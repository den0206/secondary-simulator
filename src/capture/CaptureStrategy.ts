/**
 * 1 フレーム分の JPEG を **base64 文字列で** 受け取る。
 *
 * webview へは base64 で渡すと決まっている（postMessage のシリアライズで形が
 * ぶれないため。docs/project-review.md §3.2）。バイト列で受け渡すと、
 * サイドカー経路が「base64 → Buffer → base64」と 1 往復ぶん無駄に変換していた。
 * 終端の形に合わせて、変換はそれが要る経路（MJPEG）の内側だけで行う。
 */
export type FrameCallback = (frameBase64: string) => void;

/**
 * キャプチャ戦略のインターフェース
 * MJPEGストリーミング方式をサポート
 */
export interface CaptureStrategy {
  /**
   * デバイスIDを設定
   */
  setDevice(deviceId: string): void;

  /**
   * フレームコールバックを設定
   */
  onFrame(callback: FrameCallback): void;

  /**
   * キャプチャを開始
   */
  start(): Promise<void>;

  /**
   * キャプチャを停止
   */
  stop(): void;

  /**
   * 設定を更新（必要に応じて再起動）
   */
  updateConfig(): void;

  /**
   * ビュー録画の開始・終了を伝える（実装は任意）。
   *
   * 取り込み幅を上げられるのは**サイドカー経路だけ**なので、`MjpegCapture` は
   * 実装しない。WDA / Android 経路の帯域は `WdaSettings` と mobilecli 側の
   * 設定で決まり、録画のために動かす手段が今は無い（`docs/project-review.md` §5.10）。
   */
  setRecording?(active: boolean): void;

  /**
   * リソースを解放
   */
  dispose(): void;
}
