import {Logger} from '../utils/Logger';
import {CaptureStrategy, FrameCallback} from './CaptureStrategy';
import {MjpegParseError, MjpegParser, parseBoundary} from './MjpegParser';

/**
 * MJPEGストリーミング方式のキャプチャ実装
 * mobilecliのMJPEGストリームを使用
 *
 * multipart の解析自体は MjpegParser が行う（単体テスト可能な純ロジック）。
 * ここはセッション確立・再接続・ライフサイクルだけを見る。
 */
export class MjpegCapture implements CaptureStrategy {
  private static readonly MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB
  private static readonly MAX_IMAGE_DATA_SIZE = 10 * 1024 * 1024; // 10MB
  /** boundary が取れなかったときだけ使う既定値（mobilecli の実装値） */
  private static readonly FALLBACK_BOUNDARY = '--BoundaryString';
  /**
   * この時間フレームが 1 枚も来なければ、繋がったまま死んだとみなして張り直す。
   * 実測のフレーム間隔は p99 41ms（docs/sync-research.md §1.1）なので桁で余裕がある。
   */
  private static readonly STALL_TIMEOUT_MS = 15_000;

  private deviceId: string | null = null;
  private frameCallback: FrameCallback | null = null;
  private isCapturing: boolean = false;
  private serverPort: number;
  private streamController: AbortController | null = null;
  private streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private parser: MjpegParser | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  // 利用者がキャプチャ継続を望んでいるか（isCapturing は現在ストリーム中かで別物）。
  // ストリームが異常終了しても wantCapture が true なら自動再接続する。
  private wantCapture: boolean = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private streamGen = 0;
  private static readonly RECONNECT_DELAY_MS = 500;
  /**
   * 再接続の待ち時間の上限。デバイスが落ちている間は 500ms 固定で永久に叩き続け、
   * 1 回ごとにログが 2 行以上増えて OutputChannel が際限なく膨らんでいた
   * （CLAUDE.md「無制限に伸びる入れ物を作らない」）。
   */
  private static readonly RECONNECT_MAX_DELAY_MS = 10_000;
  /** 連続失敗数。フレームが 1 枚届いたら 0 へ戻す。 */
  private reconnectAttempts = 0;

  constructor(serverPort: number) {
    this.serverPort = serverPort;
  }

  setDevice(deviceId: string): void {
    this.deviceId = deviceId;
  }

  onFrame(callback: FrameCallback): void {
    this.frameCallback = callback;
  }

  async start(): Promise<void> {
    if (!this.deviceId) {
      throw new Error('No device selected');
    }

    if (this.isCapturing) {
      return;
    }

    this.wantCapture = true;
    this.reconnectAttempts = 0;
    this.streamGen++;
    const gen = this.streamGen;
    this.isCapturing = true;

    Logger.info(`Starting MJPEG stream for device: ${this.deviceId}`);
    await this.startMjpegStream(gen);
  }

  stop(): void {
    this.wantCapture = false;
    this.streamGen++;
    this.isCapturing = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopMjpegStream();
    Logger.info('MJPEG capture stopped');
  }

  updateConfig(): void {
    // MJPEGストリーミングでは設定変更は再起動が必要
    if (this.wantCapture && this.deviceId) {
      this.stop();
      void this.start().catch((e) =>
        Logger.error('Failed to restart capture on config change', e as Error)
      );
    }
  }

  // ストリームが異常終了したとき、利用者がまだ継続を望んでいれば再接続する。
  // 失敗が続くほど間隔を空ける（500ms から倍々で最大 10 秒）。
  private scheduleReconnect(): void {
    if (!this.wantCapture || this.reconnectTimer) return;
    const gen = this.streamGen;
    const delay = MjpegCapture.reconnectDelayFor(this.reconnectAttempts);
    this.reconnectAttempts++;
    // 毎回出すと出力チャンネルが膨らむので、最初の数回だけ記録する
    if (this.reconnectAttempts <= 3) {
      Logger.info(`MJPEG stream reconnect in ${delay}ms (${this.reconnectAttempts})`);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.wantCapture || !this.deviceId || gen !== this.streamGen) return;
      this.isCapturing = true;
      void this.startMjpegStream(gen).catch((e) =>
        Logger.debug(`MJPEG reconnect failed: ${(e as Error).message}`)
      );
    }, delay);
  }

  /** 指数バックオフ（500ms, 1s, 2s, 4s, 8s, 10s, 10s, ...）。 */
  static reconnectDelayFor(attempt: number): number {
    const delay = MjpegCapture.RECONNECT_DELAY_MS * 2 ** Math.max(0, attempt);
    return Math.min(delay, MjpegCapture.RECONNECT_MAX_DELAY_MS);
  }

  dispose(): void {
    this.stop();
    this.frameCallback = null;
    this.deviceId = null;
  }

  private async startMjpegStream(gen: number): Promise<void> {
    if (!this.deviceId) {
      return;
    }
    if (gen !== this.streamGen) {
      return;
    }

    // RPC 中の stop() でも打ち切れるように、GET より前から abort を共有する
    const controller = new AbortController();
    this.streamController = controller;
    if (gen !== this.streamGen) {
      controller.abort();
      return;
    }

    try {
      // mobilecli 0.1.x: RPC はストリーム本体ではなくセッション URL を返す。
      // multipart は続けて GET する `/stream?s=...` 側で流れてくる。
      const rpcResponse = await fetch(
        `http://localhost:${this.serverPort}/rpc`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            method: 'device.screencapture',
            id: '1',
            jsonrpc: '2.0',
            params: {
              format: 'mjpeg',
              deviceId: this.deviceId,
            },
          }),
          signal: controller.signal,
        }
      );

      if (gen !== this.streamGen) {
        controller.abort();
        return;
      }

      if (!rpcResponse.ok) {
        throw new Error(`HTTP error! status: ${rpcResponse.status}`);
      }

      const rpcBody = (await rpcResponse.json()) as {
        result?: {sessionUrl?: string};
        error?: {message?: string; data?: string};
      };
      if (gen !== this.streamGen) {
        controller.abort();
        return;
      }

      const sessionUrl = rpcBody.result?.sessionUrl;
      if (!sessionUrl) {
        throw new Error(
          rpcBody.error?.data ??
            rpcBody.error?.message ??
            'device.screencapture が sessionUrl を返さなかった'
        );
      }

      const response = await fetch(
        `http://localhost:${this.serverPort}${sessionUrl}`,
        {signal: controller.signal}
      );

      if (gen !== this.streamGen) {
        controller.abort();
        return;
      }

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      if (!response.body) {
        throw new Error('ReadableStream not supported');
      }

      // boundary はレスポンスの Content-Type から取る（ソースへ固定しない）
      const boundary =
        parseBoundary(response.headers.get('content-type')) ??
        MjpegCapture.FALLBACK_BOUNDARY;
      this.parser = new MjpegParser(boundary, {
        maxBufferSize: MjpegCapture.MAX_BUFFER_SIZE,
        maxPartSize: MjpegCapture.MAX_IMAGE_DATA_SIZE,
      });

      const reader = response.body.getReader();
      this.streamReader = reader;
      // 最初の 1 枚が来ないまま黙るケースも拾えるよう、ここから見張り始める
      this.armStallTimer();

      // MJPEGストリームを処理
      this.processMjpegStream(reader, gen);
    } catch (error) {
      // stop() 中の abort は異常ではない（再接続もしない）
      if ((error as Error).name === 'AbortError') {
        Logger.info('MJPEG stream aborted before start');
        return;
      }
      Logger.error('Failed to start MJPEG stream', error as Error);
      if (gen === this.streamGen) {
        this.isCapturing = false;
        this.scheduleReconnect();
      }
      throw error;
    }
  }

  private stopMjpegStream(): void {
    if (this.streamController) {
      this.streamController.abort();
      this.streamController = null;
    }

    if (this.streamReader) {
      // abort 済みのストリームでは cancel() が reject する（無視してよい）
      this.streamReader.cancel().catch(() => {});
      this.streamReader = null;
    }

    // バッファ・タイマーのクリア（メモリリーク防止）
    this.clearStallTimer();
    this.parser?.reset();
    this.parser = null;
  }

  private async processMjpegStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    gen: number
  ): Promise<void> {
    Logger.info('Starting MJPEG stream processing');

    try {
      while (this.isActive) {
        const {done, value} = await reader.read();
        if (done) {
          Logger.info('MJPEG stream ended');
          break;
        }

        const parser = this.parser;
        if (!parser) break;

        let parts;
        try {
          parts = parser.push(value);
        } catch (error) {
          if (error instanceof MjpegParseError) {
            // 壊れた入力。バッファを捨ててストリームを張り直す（finally で再接続）。
            Logger.warn(`MJPEG 解析を中断: ${error.message}`);
            this.resetStream(reader);
            break;
          }
          throw error;
        }

        for (const part of parts) {
          if (part.contentType === 'image/jpeg') {
            // フレームを即座に処理（遅延を最小化）
            this.displayMjpegImage(part.data);
          } else {
            // 非JPEGフレーム（JSON-RPC通知など）
            Logger.debug(
              `Non-JPEG frame: ${part.contentType}, body: ${new TextDecoder().decode(part.data)}`
            );
          }
        }
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        Logger.info('MJPEG stream aborted');
      } else {
        Logger.error('Error processing MJPEG stream', error);
      }
    } finally {
      // 新しい世代が始まっているなら、そのストリームのフラグを壊さない
      if (gen === this.streamGen) {
        this.isCapturing = false;
        this.scheduleReconnect();
      }
    }
  }

  // MJPEG から受け取った JPEG をそのままコールバックへ渡す（再エンコードしない）
  private displayMjpegImage(imageData: Uint8Array): void {
    // 1 枚でも届けば復帰したとみなす
    this.reconnectAttempts = 0;
    this.armStallTimer();
    this.frameCallback?.(imageData);
  }

  /**
   * フレームが届く度に張り直す停止検出。繋がったままフレームが止まる
   * （WDA セッションだけ死ぬ等）ケースは done も error も来ないので、これが無いと
   * 画面が固まったまま再接続が走らない。
   */
  private armStallTimer(): void {
    this.clearStallTimer();
    if (!this.wantCapture) return;
    const gen = this.streamGen;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (!this.wantCapture || gen !== this.streamGen) return;
      Logger.warn(
        `${MjpegCapture.STALL_TIMEOUT_MS}ms フレームが来ないためストリームを張り直す`
      );
      // reader を閉じると processMjpegStream の finally が再接続を予約する
      this.stopMjpegStream();
    }, MjpegCapture.STALL_TIMEOUT_MS);
  }

  private clearStallTimer(): void {
    if (!this.stallTimer) return;
    clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  private get isActive(): boolean {
    return this.isCapturing;
  }

  /**
   * ストリームをリセット（異常な状況でのメモリ保護）
   */
  private resetStream(reader: ReadableStreamDefaultReader<Uint8Array>): void {
    Logger.warn('Resetting MJPEG stream due to memory protection');
    this.parser?.reset();
    // リーダーをキャンセルして再起動を促す
    reader.cancel().catch((err) => {
      Logger.debug(`Error canceling reader during reset: ${err}`);
    });
    this.isCapturing = false;
  }
}
