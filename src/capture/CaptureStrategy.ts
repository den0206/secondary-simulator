/**
 * 1 フレーム分の JPEG を **base64 文字列で** 受け取る。
 *
 * webview へは base64 で渡すと決まっている（postMessage のシリアライズで形が
 * ぶれないため。docs/project-review.md §3.2）。バイト列で受け渡すと、
 * サイドカー経路が「base64 → Buffer → base64」と 1 往復ぶん無駄に変換していた
 * （docs/sync-enhancement.md §2.3）。終端の形に合わせて、変換はそれが要る
 * 経路（MJPEG）の内側だけで行う。
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
   * リソースを解放
   */
  dispose(): void;
}
