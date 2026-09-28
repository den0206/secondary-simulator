import * as fs from 'fs';
import * as vscode from 'vscode';
import {defaultRecordingName} from '../simulator/RecordingName';
import {verifyRecording} from '../simulator/RecordingFile';
import {
  containerExtension,
  ViewRecordingAbort,
  ViewRecordingWriter,
} from '../simulator/ViewRecording';
import {Logger} from '../utils/Logger';
import {MobileCliClient} from '../utils/MobileCliClient';
import {asIndex, asText} from './WebviewMessage';

/**
 * 録画の作り方。
 *
 * - `device`: 端末側の録画（mobilecli の `device.screenrecord`）。端末の解像度で
 *   録れるが、**マウスカーソルもタップも写らない**（入力は合成なので端末が指を描かない）。
 * - `view`: webview で「表示中のフレーム＋操作の表示」を合成して録る。見えている
 *   とおりが残る代わりに、画質は取り込みストリームに従う。
 */
export type RecordingSource = 'device' | 'view';

type Session = {deviceId: string; target: vscode.Uri; source: RecordingSource};

/**
 * 録画が provider から借りるもの。**接続・取り込みの状態は provider が持ち続ける**
 * （録画はそれを読むだけで、取り込みの張り替えも provider に頼む）。
 */
export interface RecordingHost {
  currentDeviceId(): string | null;
  client(): MobileCliClient | null;
  deviceName(deviceId: string): string;
  /** webview が生きているか（破棄・再作成の途中は false）。 */
  hasView(): boolean;
  isVisible(): boolean;
  post(message: unknown): void;
  defaultSaveDir(): vscode.Uri;
  /** ビュー録画のために取り込みを整える／戻す（直結配信をやめる・幅を上げる）。 */
  prepareViewCapture(): Promise<void>;
  releaseViewCapture(): Promise<void>;
}

/**
 * 録画の開始・停止・書き込み・検査。**1 度に 1 セッションだけ**持つ。
 *
 * 2 つの経路（`RecordingSource`）はどちらも保存先をユーザーが選び、
 * **拡張は一時ファイルを持たない**。止め忘れを作らないため、上限時間・切断・
 * 非表示・破棄のいずれでも必ず止める。
 */
export class RecordingController {
  /**
   * 録画中のセッション。**増える一方の入れ物にしない**ため、
   * 保持するのは「どの端末を、どこへ、どちらの経路で書いているか」の 1 件だけ。
   */
  private session: Session | null = null;
  /**
   * 開始／停止の RPC が飛んでいる最中か。停止は端末からの引き上げがあり数秒かかるので、
   * その間にもう一度押されると**止め終える前に新しい録画を始めて**しまう。
   */
  private busy = false;
  /** 開始RPCの応答待ちも録画対象として追跡する。 */
  private pending: {deviceId: string; cancelled: boolean} | null = null;
  private startedAt: number | null = null;
  /**
   * ビュー録画で webview が使える MIME。`init` が報告する（使えなければ null）。
   * MediaRecorder と canvas.captureStream の有無は Chromium の版に依るので、
   * こちら側で決め打たない。
   */
  private viewMime: string | null = null;
  /** ビュー録画の書き込み先。1 セッションに 1 つだけ持つ。 */
  private viewWriter: ViewRecordingWriter | null = null;
  /** webview の「始めた／始められない」の応答を待つ受け口（1 件だけ）。 */
  private viewStartWaiter:
    | ((result: {ok: boolean; message?: string}) => void)
    | null = null;
  /** webview の「最後のチャンクまで出し切った」応答を待つ受け口（1 件だけ）。 */
  private viewStopWaiter: (() => void) | null = null;
  /** 直近の統計 tick から書けたバイト数。フッターの録画チップに出して 0 に戻す。 */
  private bytesSinceTick = 0;
  /**
   * 止め忘れの保険。CLAUDE.md「上限と破棄条件をセットで書く」に従い、
   * 録画は必ず時間で終わる（切断・破棄でも止める）。
   */
  private timer: ReturnType<typeof setTimeout> | null = null;
  static readonly MAX_RECORDING_MS = 10 * 60_000;
  /**
   * ビュー録画の総量の蓋。時間の上限とは別に持つ — ビットレートに上限があるので
   * 10 分でも 450MB を超えないが、**伸び方を言い切れる状態**にしておく。
   */
  private static readonly MAX_VIEW_RECORDING_BYTES = 512 * 1024 * 1024;
  /**
   * 符号化のビットレート。**canvas の画素数から webview が決める**（幅はサイドバーの
   * 広さと録画かどうかで数倍変わるので、固定値だと狭いとき過剰・広いとき不足になる）。
   *
   * 上限は**総量の蓋から逆算している** — 6Mbps × 10 分 ≒ 450MB で、
   * `MAX_VIEW_RECORDING_BYTES`（512MB）の内側に収まる。ここを上げるなら
   * 蓋のほうも一緒に動かさないと、10 分に届く前に `size` で打ち切られる。
   */
  private static readonly VIEW_RECORDING_BITRATE = {
    /** 1 画素あたり毎秒のビット数。1080×2340 で約 5.6Mbps、640×1386 で約 2.0Mbps。 */
    perPixel: 2.2,
    min: 1_500_000,
    max: 6_000_000,
  };
  /** チャンクの間隔。無指定だと MediaRecorder が停止まで全部抱える。 */
  private static readonly VIEW_RECORDING_TIMESLICE_MS = 1_000;
  /** webview が抱えてよい未 ack チャンク数。超えたら**捨てずに**録画を止める。 */
  private static readonly VIEW_RECORDING_MAX_UNACKED = 8;
  /** チャンクが途切れたら webview が消えたとみなすまで（心拍は毎秒）。 */
  private static readonly VIEW_RECORDING_STALL_MS = 10_000;
  /** 開始・停止の応答待ち。返らない webview で録画状態を残さない。 */
  private static readonly VIEW_RECORDING_REPLY_MS = 10_000;
  /** 開始前に webview が出す秒読み。押した直後の画面が頭に写らないための猶予。 */
  private static readonly RECORDING_COUNTDOWN_SEC = 3;
  /**
   * 終了時に録画の後始末へ与える時間（ms）。VS Code は `deactivate` を無限には
   * 待たないので、待ち切れないときは残りの後始末を優先する。
   */
  static DISPOSE_STOP_BUDGET_MS = 5_000;

  constructor(private readonly host: RecordingHost) {}

  /** 録画中（開始待ちは含まない）か。 */
  get active(): boolean {
    return this.session !== null;
  }

  /** 開始・停止の処理中か。この間は切断で端末を落とさない。 */
  get isBusy(): boolean {
    return this.busy;
  }

  /** 開始 RPC の応答待ちを無効にする（遅れて始まった録画はその場で止める）。 */
  cancelPendingStart(): void {
    if (this.pending) this.pending.cancelled = true;
  }

  /** 非表示・端末の停止。**止め忘れに気づけない**状況なので必ず止める。 */
  abandon(): void {
    this.cancelPendingStart();
    if (this.session) void this.stop();
  }

  /** 別の端末へ繋ぎ直す前。録画中の端末から離れるなら止める（別端末を録り続けない）。 */
  async followDevice(deviceId: string): Promise<void> {
    if (this.pending && this.pending.deviceId !== deviceId) {
      this.pending.cancelled = true;
    }
    if (this.session && this.session.deviceId !== deviceId) await this.stop();
  }

  /**
   * webview が作り直された（`init`）。ビュー録画の生産者は前の webview にいたので、
   * 録画中なら続きは書かれない（10 秒待たずにここで畳む）。
   */
  async onWebviewInit(viewMime: unknown): Promise<void> {
    this.viewMime = typeof viewMime === 'string' ? viewMime : null;
    if (this.session?.source === 'view') {
      await this.stop({abort: {reason: 'stalled'}});
    }
  }

  /** 作り直した webview へ録画中の表示を戻す（非表示で止めた場合は何もしない）。 */
  postState(): void {
    if (!this.session) return;
    this.host.post({
      type: 'recording', active: true, phase: this.busy ? 'stopping' : 'recording',
      startedAt: this.startedAt, maxMs: RecordingController.MAX_RECORDING_MS,
    });
  }

  /**
   * フッターへ出す録画の数字。ビュー録画は webview（レンダラ）が符号化するので、
   * その分の RSS は `collectResourceStats` からは見えない。**ファイルの伸び方だけでも
   * 常に見せる** — 上限に当たる前に異常へ気づける唯一の数字なので。
   * 呼ぶたびに区間の計測を 0 に戻す。
   */
  takeStats(elapsedMs: number): {recMb?: number; recKbps?: number} {
    const writer = this.viewWriter;
    const stats = writer
      ? {
          recMb: Math.round((writer.bytesWritten / (1024 * 1024)) * 10) / 10,
          recKbps: Math.round(
            this.bytesSinceTick / 1024 / Math.max(1, elapsedMs / 1000)
          ),
        }
      : {};
    this.bytesSinceTick = 0;
    return stats;
  }

  /**
   * webview からの録画メッセージを受ける。録画のものでなければ false。
   */
  async handleMessage(message: {
    type: string;
    [key: string]: unknown;
  }): Promise<boolean> {
    switch (message.type) {
      case 'record':
        await this.toggle();
        return true;

      case 'viewRecordingStarted':
        this.viewStartWaiter?.({ok: true});
        return true;

      // 形が揃わないチャンクは書かない。**黙って捨てても消えはしない** —
      // 連番が飛ぶので `ViewRecordingWriter` が gap として録画ごと打ち切る
      // （壊れたファイルを「保存できた」と言わないため）。
      case 'viewRecordingChunk': {
        const seq = asIndex(message.seq);
        const data = asText(message.data);
        if (seq === null || !data) {
          Logger.warn('ビュー録画のチャンクの形が不正（書かずに捨てる）');
          return true;
        }
        await this.writeViewChunk(seq, data);
        return true;
      }

      case 'viewRecordingStopped':
        this.viewStopWaiter?.();
        return true;

      case 'viewRecordingError': {
        const text = String(message.message ?? '');
        // 開始待ちならその結果として返す（録画中の扱いにしない）
        if (this.viewStartWaiter) {
          this.viewStartWaiter({ok: false, message: text});
          return true;
        }
        Logger.error(`ビュー録画が webview 側で失敗: ${text}`);
        if (this.session) {
          await this.stop({abort: {reason: 'error', message: text}});
        }
        return true;
      }

      default:
        return false;
    }
  }

  /**
   * 録画の開始・停止を切り替える。
   *
   * **止め忘れを作らない**ため、上限時間・切断・破棄のいずれでも必ず止める。
   */
  async toggle(): Promise<void> {
    // 連打で二重に開始しない（停止の引き上げは数秒かかる）
    if (this.busy) {
      Logger.debug('録画の開始/停止が処理中なので無視する');
      return;
    }
    if (this.session) {
      await this.stop();
      return;
    }

    const deviceId = this.host.currentDeviceId();
    if (!deviceId || !this.host.client()) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Secondary Simulator: Connect to a device before recording.'
        )
      );
      return;
    }

    // 使えないときは黙って端末側へ落とさない。操作が写る前提で押しているので、
    // 写らないまま録れると（HID→WDA の無音降格と同じで）気づけない。
    let source = this.source();
    if (source === 'view' && !this.canRecordView()) {
      Logger.warn(
        `ビュー録画を使えないので端末側で録る（mime=${this.viewMime}, visible=${this.host.isVisible()}）`
      );
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Secondary Simulator: This view cannot be recorded here, so the device recorder is used instead (taps and the pointer will not appear).'
        )
      );
      source = 'device';
    }
    const ext =
      source === 'view' ? (containerExtension(this.viewMime) ?? 'webm') : 'mp4';

    // 保存ダイアログも開始操作の一部。二重に開かないようここから所有する。
    this.busy = true;
    this.host.post({type: 'recording', phase: 'starting'});
    const target = await vscode.window.showSaveDialog({
      title: vscode.l10n.t('Save recording to'),
      defaultUri: vscode.Uri.joinPath(
        this.host.defaultSaveDir(),
        defaultRecordingName(this.host.deviceName(deviceId), ext)
      ),
      filters: {[vscode.l10n.t('Videos')]: [ext]},
    });
    if (!target) {
      this.busy = false;
      this.host.post({type: 'recording', phase: 'idle', active: false});
      return;
    }

    // 画面を整える猶予。保存ダイアログを閉じた直後の画面が必ず頭に写るのを避ける。
    // 待っている間に破棄されうるので、クライアントはここで押さえる。
    const client = this.host.client()!;
    // 「隠されたら始めない」を判定するための基準。コマンドパレットから畳んだまま
    // 始める使い方は従来どおり通す（元から見えていなければ比べない）。
    const visibleAtStart = this.host.isVisible();
    const changed = () =>
      this.host.currentDeviceId() !== deviceId ||
      (visibleAtStart && !this.host.isVisible());
    let started = false;
    try {
      // 直結配信のままだと <img> が別オリジンになり canvas を汚染する。
      // 張り直しの数秒は秒読みで吸収される。
      if (source === 'view') await this.host.prepareViewCapture();
      await this.countdown();
      // 秒読みのあいだに状況が変わったら始めない。非表示・切替・破棄の見張りは
      // `session` を見るので、まだ載っていないこの数秒は素通りする
      // （隠したのに録り始める・切り替える前の端末を録る、が起きる）。
      if (changed() || !this.host.client()) {
        Logger.info('秒読み中に状況が変わったので録画を始めない');
        await this.host.releaseViewCapture();
        return;
      }
      if (source === 'view') {
        await this.startViewRecording(target);
        if (changed()) {
          await this.requestViewStop();
          await this.viewWriter?.close();
          this.viewWriter = null;
          await this.host.releaseViewCapture();
          return;
        }
      } else {
        const start = {deviceId, cancelled: false};
        this.pending = start;
        await client.startScreenRecord(deviceId, target.fsPath);
        // 世代番号は見ない。同じ端末の取り込み張り直し（再表示・設定変更・
        // `prepareViewCapture`）でも増えるので、始まった録画を巻き込んで止めてしまう。
        // 切替・切断・破棄はすべて `cancelled` か `currentDeviceId` で捕まる。
        if (
          this.pending !== start || start.cancelled ||
          this.host.currentDeviceId() !== deviceId
        ) {
          // RPC の成功は端末側で録画が始まった意味なので、古い開始を放置しない。
          await client.stopScreenRecord(deviceId).catch((error) =>
            Logger.error('切替後の録画停止に失敗', error as Error)
          );
          await this.host.releaseViewCapture();
          return;
        }
        this.pending = null;
      }
      started = true;
    } catch (error) {
      Logger.error('録画を開始できなかった', error as Error);
      this.pending = null;
      await this.host.releaseViewCapture();
      void vscode.window.showErrorMessage(
        vscode.l10n.t(
          'Secondary Simulator: Could not start recording — {0}',
          (error as Error).message
        )
      );
      return;
    } finally {
      this.busy = false;
      // 始められなかった経路（失敗・秒読み中の切替・開始直後の取り消し）は
      // ここで必ず `starting` を解く。解かないと Rec ボタンが押せないまま残る。
      if (!started) {
        this.host.post({type: 'recording', phase: 'idle', active: false});
      }
    }

    this.session = {deviceId, target, source};
    this.startedAt = Date.now();
    Logger.info(`録画を開始（${source}）: ${target.fsPath}`);
    this.host.post({type: 'recording', active: true, phase: 'recording', startedAt: this.startedAt, maxMs: RecordingController.MAX_RECORDING_MS});

    // 上限で必ず終わらせる（押し忘れても増え続けない）
    this.timer = setTimeout(() => {
      this.timer = null;
      Logger.warn('録画が上限時間に達したので停止する');
      void this.stop();
    }, RecordingController.MAX_RECORDING_MS);
    this.timer.unref?.();
  }

  /**
   * 録画の作り方。**既定は `view`**（カーソルとタップが写る）で、端末の解像度が
   * 要るときだけ `device` を選ぶ。使えない環境では `toggle` が
   * 警告つきで `device` へ落とす（黙って落とさない）。
   */
  private source(): RecordingSource {
    return vscode.workspace
      .getConfiguration('secondarySimulator')
      .get<string>('recordingSource', 'view') === 'device'
      ? 'device'
      : 'view';
  }

  /**
   * ビュー録画を始められるか。符号化するのは webview なので、
   * **見えていること**と MediaRecorder が使えることの両方が要る。
   */
  private canRecordView(): boolean {
    return this.viewMime !== null && this.host.isVisible();
  }

  /**
   * 開始前のカウントダウン。webview が数字と音を出すだけで、進行はここが持つ
   * （webview にタイマーを置くと、非表示や再読み込みで置き去りになる）。
   */
  private async countdown(): Promise<void> {
    for (let n = RecordingController.RECORDING_COUNTDOWN_SEC; n > 0; n--) {
      this.host.post({type: 'countdown', value: n});
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        timer.unref?.();
      });
    }
    this.host.post({type: 'countdown', value: 0});
  }

  // ---- ビュー録画（webview が符号化し、ここが書く）------------------------------

  /**
   * webview に符号化を始めさせ、書き込み先を開く。
   * 始められなければ例外を投げる（呼び手がエラー表示を出す）。
   */
  private async startViewRecording(target: vscode.Uri): Promise<void> {
    const mimeType = this.viewMime;
    if (!mimeType) throw new Error('MediaRecorder is not available');

    const writer = new ViewRecordingWriter(target.fsPath, {
      maxBytes: RecordingController.MAX_VIEW_RECORDING_BYTES,
      stallMs: RecordingController.VIEW_RECORDING_STALL_MS,
      onAbort: (abort) => this.onViewRecordingAbort(abort),
    });
    await writer.open();
    this.viewWriter = writer;
    this.bytesSinceTick = 0;

    const result = await new Promise<{ok: boolean; message?: string}>(
      (resolve) => {
        const timer = setTimeout(() => {
          this.viewStartWaiter = null;
          resolve({ok: false, message: 'timeout'});
        }, RecordingController.VIEW_RECORDING_REPLY_MS);
        timer.unref?.();
        this.viewStartWaiter = (r) => {
          clearTimeout(timer);
          this.viewStartWaiter = null;
          resolve(r);
        };
        this.host.post({
          type: 'startViewRecording',
          mimeType,
          bitrate: RecordingController.VIEW_RECORDING_BITRATE,
          timesliceMs: RecordingController.VIEW_RECORDING_TIMESLICE_MS,
          maxUnacked: RecordingController.VIEW_RECORDING_MAX_UNACKED,
        });
      }
    );

    if (!result.ok) {
      this.viewWriter = null;
      // 返事が来なかっただけで webview 側は録っているかもしれない。止めさせる。
      this.host.post({type: 'stopViewRecording'});
      await writer.close();
      // 1 バイトも書けていない空ファイルを、ユーザーが選んだ場所へ置き去りにしない
      if (writer.bytesWritten === 0) {
        try {
          await fs.promises.unlink(target.fsPath);
        } catch {
          // 消せなくても録画の失敗として扱う（ここでは何も言わない）
        }
      }
      throw new Error(result.message || 'webview did not start recording');
    }
    // ここから先はチャンクが毎秒届く。届かなくなったら webview が消えた合図。
    writer.startWatch();
  }

  /** webview から届いたチャンクを書き、書けたぶんだけ ack を返す。 */
  private async writeViewChunk(seq: number, data: string): Promise<void> {
    const writer = this.viewWriter;
    if (!writer) return;
    const bytes = Buffer.from(data, 'base64');
    // 書き終える（＝逆圧を受け切る）まで ack を返さない。webview は未 ack の
    // 上限を超えたら録画そのものを止める — **チャンクは捨てられない**ため。
    const written = await writer.write(seq, bytes);
    if (!written) return;
    this.bytesSinceTick += bytes.length;
    this.host.post({type: 'viewRecordingAck', seq});
  }

  /** 上限・欠落・停止で書き込み側が打ち切ったとき。録画セッションごと畳む。 */
  private onViewRecordingAbort(abort: ViewRecordingAbort): void {
    Logger.warn(`ビュー録画を打ち切る: ${JSON.stringify(abort)}`);
    void this.stop({abort});
  }

  /** webview に符号化を止めさせ、最後のチャンクまで受け切る。 */
  private async requestViewStop(): Promise<void> {
    // webview が既に無ければ待たない（破棄・再作成の経路で 10 秒止まらない）
    if (!this.host.hasView()) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.viewStopWaiter = null;
        Logger.warn('webview から録画停止の応答が無かった');
        resolve();
      }, RecordingController.VIEW_RECORDING_REPLY_MS);
      timer.unref?.();
      this.viewStopWaiter = () => {
        clearTimeout(timer);
        this.viewStopWaiter = null;
        resolve();
      };
      this.host.post({type: 'stopViewRecording'});
    });
  }

  /**
   * 録画を止めて書き出す。端末側の停止が成功してからだけ `session` と UI を戻す
   * — 先に戻すと「止まったように見えるが端末では録り続けている」状態になる。
   *
   * @param options.abort 書き込み側が打ち切った理由。**中身が欠けている合図**なので、
   *   停止音も「保存できた」の通知も出さない。
   */
  async stop(options?: {
    abort?: ViewRecordingAbort;
    quiet?: boolean;
  }): Promise<void> {
    const session = this.session;
    if (!session) return;
    if (session.source === 'view') {
      await this.stopViewRecording(session, options?.abort, options?.quiet);
      return;
    }

    const client = this.host.client();
    if (!client) {
      this.clearSession();
      this.host.post({type: 'recording', active: false, phase: 'idle'});
      return;
    }
    // 引き上げと変換で数秒かかる。その間に始め直させない
    this.busy = true;
    this.host.post({type: 'recording', phase: 'stopping', active: true});
    try {
      await client.stopScreenRecord(session.deviceId);
    } catch (error) {
      Logger.error('録画の停止に失敗', error as Error);
      this.host.post({type: 'recording', active: true, phase: 'recording', startedAt: this.startedAt, maxMs: RecordingController.MAX_RECORDING_MS});
      // 終了中は聞かない。ダイアログの応答を待つと deactivate が返らない
      if (options?.quiet) {
        this.busy = false;
        this.clearSession();
        return;
      }
      const retry = vscode.l10n.t('Retry');
      const answer = await vscode.window.showErrorMessage(
        vscode.l10n.t(
          'Secondary Simulator: Could not stop the recording — {0}',
          (error as Error).message
        ),
        retry
      );
      if (answer === retry) {
        this.busy = false;
        await this.stop();
      }
      return;
    } finally {
      this.busy = false;
    }

    this.clearSession();
    await this.finish(session, undefined, options?.quiet);
  }

  /**
   * ビュー録画を止める。**webview の符号化を止めて最後のチャンクを受け切ってから**
   * ファイルを閉じる（先に閉じると末尾が落ちる）。
   */
  private async stopViewRecording(
    session: Session,
    abort?: ViewRecordingAbort,
    quiet?: boolean
  ): Promise<void> {
    // 停止ボタンと打ち切りが重なっても 1 回で終わらせる
    if (this.busy) return;
    this.busy = true;
    this.host.post({type: 'recording', phase: 'stopping', active: true});
    const writer = this.viewWriter;
    try {
      // webview が消えた（stalled）以外は、出し切らせてから閉じる
      if (!abort || abort.reason === 'size') await this.requestViewStop();
      else this.host.post({type: 'stopViewRecording'});
      await writer?.close();
    } finally {
      this.viewWriter = null;
      this.busy = false;
    }

    this.clearSession();
    await this.host.releaseViewCapture();
    // 停止の応答を待っているあいだに打ち切られた（停止と stall が重なった）場合、
    // 呼び手は abort を知らない。**書き込み側の記録を優先する** — 末尾が欠けた
    // ファイルを「保存できた」と言わないため。
    await this.finish(session, abort ?? writer?.abortReason ?? undefined, quiet);
  }

  /**
   * 書き出し終わったファイルを検査して結果を出す（両経路で共通）。
   *
   * 停止が成功しても、端末側で finalize されていなければ moov の無い mp4 が残る
   * （映像は入っているのに再生できない）。**成功と言い切る前に中身を見る** —
   * 音と通知が「保存できた」の合図になっているので、黙って通すと利用者は
   * 壊れたことに気づけない（`RecordingFile.ts`）。
   *
   * @param quiet 拡張の終了中。**結果はログにだけ残す** — 閉じていくウィンドウでは
   *   `showInformationMessage` が解決しないことがあり、待つと `deactivate` が
   *   返らない（返らなければ VS Code は待ちを打ち切り、後始末の途中でホストが消える）。
   */
  private async finish(
    session: Session,
    abort?: ViewRecordingAbort,
    quiet?: boolean
  ): Promise<void> {
    const file = session.target.fsPath;
    const check = await verifyRecording(file);
    // 総量の上限は「そこまでは正しく録れている」なので成功として扱う。
    // 欠落・停止・エラーは末尾が落ちているので、成功の合図を出さない。
    const cut = abort && abort.reason !== 'size';
    this.host.post({type: 'recording', active: false, phase: 'idle', ok: check.ok && !cut});

    let warning: string | null = null;
    if (!check.ok) {
      Logger.error(`録画が完成していない（${check.reason}）: ${file}`);
      warning = vscode.l10n.t(
        'Secondary Simulator: The recording was not finalized and cannot be played — {0}',
        file
      );
    } else if (cut) {
      Logger.error(`録画が途中で切れた（${abort!.reason}）: ${file}`);
      warning = vscode.l10n.t(
        'Secondary Simulator: The recording was cut short and may be missing the end — {0}',
        file
      );
    } else {
      Logger.info(`録画を保存: ${file}`);
    }
    if (quiet) return;

    if (warning) {
      const showLogs = vscode.l10n.t('Show Logs');
      const answer = await vscode.window.showWarningMessage(warning, showLogs);
      if (answer === showLogs) Logger.show();
      return;
    }

    const openLabel = vscode.l10n.t('Open');
    const message =
      abort?.reason === 'size'
        ? vscode.l10n.t(
            'Recording stopped at the size limit and was saved: {0}',
            file
          )
        : vscode.l10n.t('Recording saved: {0}', file);
    const open = await vscode.window.showInformationMessage(message, openLabel);
    if (open === openLabel) {
      await vscode.commands.executeCommand('vscode.open', session.target);
    }
  }

  private clearSession(): void {
    this.clearTimer();
    this.session = null;
    this.startedAt = null;
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * 終了時の後始末。**webview とリスナーが生きているうちに呼ぶ** —
   * `requestViewStop()` は view が無いと即座に返るので、先に落とすと
   * `MediaRecorder.stop()` が呼ばれず、コンテナを閉じる最後のチャンク
   * （mp4 の `moov`）が生まれない。
   */
  async dispose(): Promise<void> {
    this.clearTimer();
    this.cancelPendingStart();
    if (this.session) {
      // 通知は出さない（quiet）。結果はログに残す。
      await this.withStopBudget(this.stop({quiet: true}));
    }
    // 経路によらず、開いたままの書き込み先を残さない（close は多重呼び出し可）
    const writer = this.viewWriter;
    this.viewWriter = null;
    await writer?.close();
  }

  /**
   * 終了時の待ちに上限を付ける。
   *
   * `requestViewStop` は 10 秒待てるし、端末側の停止は mobilecli の応答待ちになる。
   * VS Code が `deactivate` を待つ時間は無限ではないので、**待ち切れないくらい
   * 遅いときは諦めて残りの後始末を続ける**（抱えたまま落ちるより、ポートと
   * 子プロセスを片付けたほうがよい）。正常な停止は 1 秒ほどで返る。
   */
  private async withStopBudget(work: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<'timeout'>((resolve) => {
      // **ここは `unref` しない。** 他のタイマー（入力の解放待ちなど）は
      // 「終了を遅らせない」ために unref するが、こちらは待っている間ずっと
      // ファイルを書いている。unref すると、残りが unref 済みのタイマーだけに
      // なった瞬間に Node がイベントループを空と見なして終わり、書きかけの
      // 末尾が落ちる。待ちが終われば下の finally で必ず捨てるので、
      // 終了が遅れるのは実際に書き終わりを待っている間だけ。
      timer = setTimeout(
        () => resolve('timeout'),
        RecordingController.DISPOSE_STOP_BUDGET_MS
      );
    });
    try {
      const result = await Promise.race([work.then(() => 'done' as const), budget]);
      if (result === 'timeout') {
        Logger.warn(
          '終了時の録画停止が時間内に終わらなかった（後始末を続ける）'
        );
      }
    } catch (error) {
      // ここで投げると後始末が止まる。理由だけ残す
      Logger.error('終了時の録画停止に失敗', error as Error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
