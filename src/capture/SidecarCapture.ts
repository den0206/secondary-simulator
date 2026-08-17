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
 * サイドカーは 1 プロセスで入力と共用する。フレームは base64 JPEG の JSON Lines で届く。
 *
 * 取り込みの粗さは固定ではなく、**表示中の幅と操作の有無に追従させる**
 * （docs/sync-enhancement.md §3.4）。設定値は上限として扱う。
 */
export class SidecarCapture implements CaptureStrategy {
  /**
   * frame も captureAlive も来なくなったら死んだとみなす。
   * 生存通知は約2秒毎なので、数回落ちても誤検知しない幅を取る。
   */
  private static readonly STALL_TIMEOUT_MS = 10_000;
  /** 指を離してから通常の fps へ戻すまで。慣性スクロールのぶん少し待つ。 */
  private static readonly INTERACTION_TAIL_MS = 700;

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

  constructor(
    private readonly sidecar: SimhidSidecar,
    private readonly getConfig: () => SidecarCaptureConfig,
    options?: {stallTimeoutMs?: number}
  ) {
    this.stallTimeoutMs = options?.stallTimeoutMs ?? SidecarCapture.STALL_TIMEOUT_MS;
  }

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
    });
    this.started = true;
    this.applied = config;
    Logger.info(
      `サイドカーの画面取り込みを開始: ${config.maxWidth}px / ${config.fps}fps`
    );
  }

  stop(): void {
    this.clearStallTimer();
    this.clearInteractionTimer();
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
   * エンコードの無駄になる（docs/sync-enhancement.md §2.7）。
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
  }
}
