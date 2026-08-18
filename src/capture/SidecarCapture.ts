import {randomBytes} from 'node:crypto';
import {SimhidSidecar} from '../input/SimhidSidecar';
import {Logger} from '../utils/Logger';
import {CaptureStrategy, FrameCallback} from './CaptureStrategy';
import {effectiveCaptureConfig, EffectiveCapture} from './CaptureStats';

export interface SidecarCaptureConfig {
  /** 取り込み間隔の基準。画面が変わらないフレームは送られないので上限値 */
  fps: number;
  /** 送出する JPEG の最大幅（px）。実際の幅は表示中のサイズに合わせて下げる */
  maxWidth: number;
  /** JPEG 品質 0.1〜1.0 */
  quality: number;
}

/**
 * iOS Simulator のフレームバッファを HID サイドカー経由で受け取る（iOS Simulator 限定）。
 *
 * WDA(XCTest) のスクリーンショットは「テスト対象アプリのウィンドウ」しか描かないため、
 * ソフトウェアキーボードやステータスバーが写らない（docs/ios-hid-injection.md §6）。
 * こちらは端末のフレームバッファなので、画面に出ているものが全て入る。
 *
 * サイドカーは 1 プロセスで入力と共用する。
 *
 * フレームの受け取り方は 2 通りある（`sink`）。
 * - `stdout`（既定）: base64 JPEG の JSON Lines。`onFrame` へ流す
 * - `http`: サイドカーが loopback で multipart を配信し、webview の `<img>` が直接受ける。
 *   フレームが拡張ホストを通らないので、**映像の背圧が入力の応答を巻き込まない**
 *   （`docs/sidecar-protocol.md` §3.6）。URL は `streamUrl` で取る
 *
 * 取り込みの粗さは固定ではなく、**表示中の幅と操作の有無に追従させる。**
 * 設定値は上限として扱う。
 */
export class SidecarCapture implements CaptureStrategy {
  /**
   * frame も captureAlive も来なくなったら死んだとみなす。
   * 生存通知は約2秒毎なので、数回落ちても誤検知しない幅を取る。
   */
  private static readonly STALL_TIMEOUT_MS = 10_000;
  /** 指を離してから通常の fps へ戻すまで。慣性スクロールのぶん少し待つ。 */
  private static readonly INTERACTION_TAIL_MS = 700;
  /**
   * サイドカーの HTTP 配信が使うポートの先頭と試行数。
   * `MjpegProxy` と同じく、CSP には範囲で許可を出しておく必要がある。
   */
  static readonly STREAM_BASE_PORT = 12220;
  static readonly MAX_PORT_TRIES = 20;

  private deviceId = '';
  private callback: FrameCallback | null = null;
  private started = false;
  /** 表示中の実ピクセル幅（CSS 幅 × devicePixelRatio）。未報告なら null。 */
  private viewportWidth: number | null = null;
  private interacting = false;
  private interactionTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 生存通知を 1 度でも受け取ったか。
   * 受け取っていない間は停止検出を張らない（生存通知を送らない古い
   * サイドカーバイナリを、静止画面のたびに再起動しないため）。
   */
  private sawAlive = false;
  /** 直近にサイドカーへ送った設定。同じ値を送り直さない。 */
  private applied: EffectiveCapture | null = null;

  /** 停止とみなすまでの時間。既定は STALL_TIMEOUT_MS（テストから縮められる）。 */
  private readonly stallTimeoutMs: number;
  /** フレームの受け取り方。`http` なら `onFrame` は呼ばれず `streamUrl` に URL が入る。 */
  private readonly sink: 'stdout' | 'http';
  /** 取り込みの駆動。`auto` は変更通知を試し、駄目ならサイドカーがポーリングへ戻す。 */
  private readonly mode: 'auto' | 'poll';
  /** 起動毎に変わる。webview へ渡す URL 以外からは配信させない。 */
  private readonly token = randomBytes(24).toString('hex');
  private servePort = 0;

  constructor(
    private readonly sidecar: SimhidSidecar,
    private readonly getConfig: () => SidecarCaptureConfig,
    options?: {
      stallTimeoutMs?: number;
      sink?: 'stdout' | 'http';
      mode?: 'auto' | 'poll';
    }
  ) {
    this.stallTimeoutMs = options?.stallTimeoutMs ?? SidecarCapture.STALL_TIMEOUT_MS;
    this.sink = options?.sink ?? 'stdout';
    this.mode = options?.mode ?? 'auto';
  }

  /**
   * webview の `<img>` に渡す URL。`sink` が `http` で、配信が始まっているときだけ。
   * トークンはここでしか漏れない。
   */
  streamUrl(): string | null {
    if (this.sink !== 'http' || !this.servePort) return null;
    return `http://localhost:${this.servePort}/stream?device=${encodeURIComponent(
      this.deviceId
    )}&t=${this.token}`;
  }

  /** 実際に使っている配信ポート（portMapping 用）。未起動なら 0。 */
  get port(): number {
    return this.servePort;
  }

  /**
   * 直結配信の URL が決まった／変わったときに呼ばれる。
   * 停止検出で張り直すとポートが変わりうるので、webview へ送り直す口が要る。
   */
  onStreamChange?: (url: string | null) => void;

  setDevice(deviceId: string): void {
    if (deviceId === this.deviceId) return;
    this.stop();
    this.deviceId = deviceId;
  }

  onFrame(callback: FrameCallback): void {
    this.callback = callback;
  }

  async start(): Promise<void> {
    if (!this.deviceId) throw new Error('SidecarCapture: device 未設定');
    if (this.started) return;
    const config = this.effective();

    // 直結配信は取り込みより先に立てる（最初のフレームを取りこぼさない）
    let sink: 'stdout' | 'http' = this.sink;
    if (sink === 'http' && !(await this.ensureServing())) {
      // 空きポートが無い等。stdout 経路なら動くので、そちらへ降りる
      Logger.warn('サイドカーの直結配信を開始できないため stdout 経路で続ける');
      sink = 'stdout';
    }

    // onFrame / onCaptureAlive は高頻度パス。ここでログを出さない。
    // サイドカーが送ってくる base64 をそのまま流す（webview も base64 で受ける）。
    this.sidecar.onFrame = (base64) => {
      this.armStallTimer();
      this.callback?.(base64);
    };
    this.sidecar.onCaptureAlive = () => {
      this.sawAlive = true;
      this.armStallTimer();
    };
    await this.sidecar.send({
      cmd: 'captureStart',
      device: this.deviceId,
      fps: config.fps,
      maxWidth: config.maxWidth,
      quality: config.quality,
      sink,
      mode: this.mode,
    });
    this.started = true;
    this.applied = config;
    Logger.info(
      `サイドカーの画面取り込みを開始: ${config.maxWidth}px / ${config.fps}fps` +
        (sink === 'http' ? `（直結 :${this.servePort}）` : '')
    );
    // 張り直しでポートが変わることがあるので、開始のたびに知らせる
    if (sink === 'http') this.onStreamChange?.(this.streamUrl());
  }

  /**
   * サイドカーに loopback 配信を張らせる。空きポートを順に試す。
   *
   * ポートは**拡張ホストが決めて渡す**。CSP は HTML 生成時に範囲で許可しており
   * （`MjpegProxy` と同じ形）、サイドカーに選ばせると範囲外を掴みうるため。
   */
  private async ensureServing(): Promise<boolean> {
    if (this.servePort) return true;
    const base = SidecarCapture.STREAM_BASE_PORT;
    for (let i = 0; i < SidecarCapture.MAX_PORT_TRIES; i++) {
      const port = base + i;
      try {
        await this.sidecar.send({
          cmd: 'captureServe',
          enable: true,
          port,
          token: this.token,
        });
        this.servePort = port;
        return true;
      } catch (error) {
        // 使用中なら次のポート。それ以外（古いサイドカーで未対応など）は諦める
        const message = (error as Error).message;
        if (!message.includes('ポートが使えない')) {
          Logger.warn(`サイドカーの配信を開始できない: ${message}`);
          return false;
        }
      }
    }
    return false;
  }

  stop(): void {
    this.clearStallTimer();
    this.clearInteractionTimer();
    // 待ち受けは started と別に畳む。start() が captureStart で失敗した場合、
    // 配信だけ張られたまま started は false なので、下の早期 return では閉じられない
    // （サイドカーは使い回されるため、開けっ放しの listener が残る）。
    if (this.servePort) {
      this.servePort = 0;
      this.sidecar.send({cmd: 'captureServe', enable: false}).catch(() => {});
    }
    if (!this.started) return;
    this.started = false;
    this.applied = null;
    this.sidecar.onFrame = undefined;
    this.sidecar.onCaptureAlive = undefined;
    // 送れなくても（プロセス終了済みなど）取り込みは止まるので握りつぶす
    this.sidecar
      .send({cmd: 'captureStop', device: this.deviceId})
      .catch(() => {});
  }

  /** 設定が変わったときに呼ばれる。張り直さずに差分だけ送る。 */
  updateConfig(): void {
    if (!this.started) return;
    this.applyConfig();
  }

  /**
   * 表示中の大きさを伝える（webview の ResizeObserver から）。
   * サイドバーが狭いときに要らない画素を送らず、広げたときはその幅まで上げる
   * （設定値が上限）。
   */
  setViewportWidth(pixels: number): void {
    if (!Number.isFinite(pixels) || pixels <= 0) return;
    // 数 px の揺れで送り直さない
    if (this.viewportWidth !== null && Math.abs(this.viewportWidth - pixels) < 16) {
      return;
    }
    this.viewportWidth = pixels;
    this.applyConfig();
  }

  /**
   * 操作の開始・終了。押している間だけ fps を上げる。
   *
   * 追従が要るのはドラッグ中だけで、静止中に同じレートで回すのは
   * エンコードの無駄になる。
   * 高頻度の move では呼ばない（down / up だけ）。
   */
  setInteracting(active: boolean): void {
    if (active) {
      this.clearInteractionTimer();
      if (this.interacting) return;
      this.interacting = true;
      this.applyConfig();
      return;
    }
    // 離した直後の慣性スクロールも追いたいので、少し待ってから戻す
    if (!this.interacting || this.interactionTimer) return;
    this.interactionTimer = setTimeout(() => {
      this.interactionTimer = null;
      this.interacting = false;
      this.applyConfig();
    }, SidecarCapture.INTERACTION_TAIL_MS);
  }

  /** 実際に送るべき設定。設定値・表示幅・操作状態から決まる。 */
  private effective(): EffectiveCapture {
    return effectiveCaptureConfig(this.getConfig(), {
      viewportWidth: this.viewportWidth,
      interacting: this.interacting,
    });
  }

  private applyConfig(): void {
    if (!this.started) return;
    const next = this.effective();
    if (
      this.applied &&
      this.applied.fps === next.fps &&
      this.applied.maxWidth === next.maxWidth &&
      this.applied.quality === next.quality
    ) {
      return;
    }
    this.applied = next;
    // 張り直さずに差し替える（captureStop→Start だと 1 枚落ちて画面が止まる）
    this.sidecar
      .send({
        cmd: 'captureConfig',
        device: this.deviceId,
        fps: next.fps,
        maxWidth: next.maxWidth,
        quality: next.quality,
      })
      .catch((error) =>
        // 古いサイドカーには captureConfig が無い。取り込み自体は続くので警告だけ。
        Logger.warn(`取り込み設定の変更に失敗: ${(error as Error).message}`)
      );
  }

  /**
   * frame も生存通知も来なくなったら張り直す。
   *
   * サイドカー経路は**静止画面だとフレームが 1 枚も来ない**ので、
   * フレームの途絶だけでは死活を判定できない。生存通知を見てから張る。
   */
  private armStallTimer(): void {
    if (!this.sawAlive) return;
    this.clearStallTimer();
    if (!this.started) return;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (!this.started) return;
      Logger.warn(`${this.stallTimeoutMs}ms 取り込みの応答が無いため張り直す`);
      // stop() は deviceId を消さないので、そのまま張り直せる
      this.stop();
      void this.start().catch((error) =>
        Logger.warn(`取り込みの張り直しに失敗: ${(error as Error).message}`)
      );
    }, this.stallTimeoutMs);
  }

  private clearStallTimer(): void {
    if (!this.stallTimer) return;
    clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  private clearInteractionTimer(): void {
    if (!this.interactionTimer) return;
    clearTimeout(this.interactionTimer);
    this.interactionTimer = null;
  }

  dispose(): void {
    this.stop();
    this.callback = null;
    this.onStreamChange = undefined;
  }
}
