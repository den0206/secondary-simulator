import * as fs from 'fs';

/**
 * webview で合成した映像（画面＋操作の表示）を、ユーザーが選んだファイルへ書く受け口。
 *
 * 端末側の録画（`device.screenrecord`）には**マウスカーソルもタップも写らない**
 * （入力は HID / adb で合成しており、端末は指を描かない）。webview は見えている
 * とおりの絵を持っているので、そこで符号化してここへ流す。
 *
 * **チャンクは捨てない。** `touchMove` は最新の 1 点だけが意味を持つので捨ててよいが、
 * 録画のチャンクは 1 つ落ちるだけでコンテナが壊れ、映像が入っているのに再生できない
 * ファイルが残る（`RecordingFile.ts` が番人をしているのがまさにこれ）。詰まったら
 * **黙って捨てずに録画そのものを止める**、が上限の当たり方になる。
 *
 * 拡張ホストが抱えるのは「書き込み中の 1 チャンク」だけで、キューは作らない。
 * webview 側は ack が返るまで次を出さない（未 ack の上限は webview が持つ）。
 */
export type ViewRecordingAbort =
  /** 総量の上限に当たった。ここまでの内容は書き終えて閉じる。 */
  | {reason: 'size'; bytes: number}
  /** webview からチャンクが途切れた（再読み込み・クラッシュ）。 */
  | {reason: 'stalled'}
  /** 連番が飛んだ = 落ちたチャンクがある。continue すると壊れたファイルになる。 */
  | {reason: 'gap'; expected: number; got: number}
  | {reason: 'error'; message: string};

export interface ViewRecordingOptions {
  /** 総量の蓋。時間の上限（10 分）とは別に、ファイルの伸びを言い切れるようにする。 */
  maxBytes: number;
  /**
   * これだけチャンクが途切れたら webview が消えたとみなす。
   * 生産者が別プロセスにいるので、ここが無いと「録画中の顔をしたまま
   * 何も書かれない」状態が残る。
   */
  stallMs: number;
  /** 上限・欠落・エラーで打ち切るときに 1 度だけ呼ばれる。 */
  onAbort: (abort: ViewRecordingAbort) => void;
}

/** MediaRecorder が通した MIME から保存時の拡張子を決める（純粋関数）。 */
export function containerExtension(
  mimeType: string | null | undefined
): 'mp4' | 'webm' | null {
  if (typeof mimeType !== 'string') return null;
  const type = mimeType.split(';')[0].trim().toLowerCase();
  if (type === 'video/mp4') return 'mp4';
  if (type === 'video/webm' || type === 'video/x-matroska') return 'webm';
  return null;
}

export class ViewRecordingWriter {
  private stream: fs.WriteStream | null = null;
  /** 書き込みの直列化。postMessage の到着順のまま並べる。 */
  private chain: Promise<unknown> = Promise.resolve();
  private expectedSeq = 0;
  private aborted: ViewRecordingAbort | null = null;
  /** 閉じ始めたら新しいチャンクは受けない（多重の close も 1 回にまとめる）。 */
  private closing: Promise<void> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private written = 0;

  constructor(
    private readonly filePath: string,
    private readonly options: ViewRecordingOptions
  ) {}

  get bytesWritten(): number {
    return this.written;
  }

  get isAborted(): boolean {
    return this.aborted !== null;
  }

  /** 書き込み先を開く。開けない（権限・存在しない親）なら例外を投げる。 */
  open(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const stream = fs.createWriteStream(this.filePath);
      stream.once('error', reject);
      stream.once('open', () => {
        stream.removeListener('error', reject);
        // 開いた後のエラーは書き込み中に拾う（呼び手は既に録画中）
        stream.on('error', (error) =>
          this.abort({reason: 'error', message: error.message})
        );
        this.stream = stream;
        resolve();
      });
    });
  }

  /**
   * 「チャンクが来なくなったら打ち切る」見張りを始める。
   *
   * **開く時点では始めない** — webview が符号化を始めるまでの待ち（数秒）を
   * 停止と数えると、始まる前に打ち切ってしまう。録画が始まったと確認できてから呼ぶ。
   */
  startWatch(): void {
    if (!this.stream || this.aborted || this.closing) return;
    this.armStall();
  }

  /**
   * チャンクを 1 つ書く。書けたら true（呼び手は ack を返す）。
   * false は打ち切り済み・欠落・上限のいずれかで、ack を返してはいけない。
   */
  write(seq: number, chunk: Uint8Array): Promise<boolean> {
    if (!this.stream || this.aborted || this.closing) {
      return Promise.resolve(false);
    }
    if (seq !== this.expectedSeq) {
      this.abort({reason: 'gap', expected: this.expectedSeq, got: seq});
      return Promise.resolve(false);
    }
    this.expectedSeq++;
    this.armStall();
    const task = this.chain.then(() => this.writeChunk(chunk));
    // 失敗しても後続を止めない（打ち切りの判断は abort が持つ）
    this.chain = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  private writeChunk(chunk: Uint8Array): Promise<boolean> {
    const stream = this.stream;
    if (!stream || this.aborted) return Promise.resolve(false);
    if (this.written + chunk.length > this.options.maxBytes) {
      this.abort({reason: 'size', bytes: this.written});
      return Promise.resolve(false);
    }
    this.written += chunk.length;
    return new Promise<boolean>((resolve) => {
      // 戻り値 false は「バッファが上限を超えた」の合図。drain を待って初めて
      // ack を返す — ここが webview への逆圧になる（溜め込む代わりに待たせる）。
      const flushed = stream.write(chunk, (error) => {
        if (error) {
          this.abort({reason: 'error', message: error.message});
          resolve(false);
        }
      });
      if (flushed) resolve(true);
      else stream.once('drain', () => resolve(true));
    });
  }

  /** 書き終えて閉じる。停止・打ち切りのどちらからでも呼べる（多重呼び出し可）。 */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.clearStall();
      const stream = this.stream;
      if (!stream) return;
      // **溜まっている書き込みを流し切ってから**閉じる。先に stream を外すと
      // 待ち行列に残ったチャンク（＝末尾）が黙って落ちる。
      await this.chain.catch(() => undefined);
      this.stream = null;
      await new Promise<void>((resolve) => {
        stream.end(() => resolve());
      });
    })();
    return this.closing;
  }

  private armStall(): void {
    this.clearStall();
    this.stallTimer = setTimeout(
      () => this.abort({reason: 'stalled'}),
      this.options.stallMs
    );
    this.stallTimer.unref?.();
  }

  private clearStall(): void {
    if (!this.stallTimer) return;
    clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  private abort(abort: ViewRecordingAbort): void {
    if (this.aborted) return;
    this.aborted = abort;
    this.clearStall();
    this.options.onAbort(abort);
  }
}
