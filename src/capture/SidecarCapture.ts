import {SimhidSidecar} from '../input/SimhidSidecar';
import {Logger} from '../utils/Logger';
import {CaptureStrategy, FrameCallback} from './CaptureStrategy';

export interface SidecarCaptureConfig {
  /** 取り込み間隔。画面が変わらないフレームは送られないので上限値*/
  fps: number;
  /** 送出する JPEG の最大幅（px）。サイドバー表示には 640 で足りる */
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
 */
export class SidecarCapture implements CaptureStrategy {
  private deviceId = '';
  private callback: FrameCallback | null = null;
  private started = false;

  constructor(
    private readonly sidecar: SimhidSidecar,
    private readonly getConfig: () => SidecarCaptureConfig
  ) {}

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
    const config = this.getConfig();
    // onFrame は高頻度パス。ここでログを出さない。
    // サイドカーが送ってくる base64 をそのまま流す（webview も base64 で受ける）。
    this.sidecar.onFrame = (base64) => this.callback?.(base64);
    await this.sidecar.send({
      cmd: 'captureStart',
      device: this.deviceId,
      fps: config.fps,
      maxWidth: config.maxWidth,
      quality: config.quality,
    });
    this.started = true;
    Logger.info(
      `サイドカーの画面取り込みを開始: ${config.maxWidth}px / ${config.fps}fps`
    );
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.sidecar.onFrame = undefined;
    // 送れなくても（プロセス終了済みなど）取り込みは止まるので握りつぶす
    this.sidecar
      .send({cmd: 'captureStop', device: this.deviceId})
      .catch(() => {});
  }

  updateConfig(): void {
    if (!this.started) return;
    this.stop();
    void this.start().catch((error) =>
      Logger.warn(`取り込み設定の再適用に失敗: ${(error as Error).message}`)
    );
  }

  dispose(): void {
    this.stop();
    this.callback = null;
  }
}
