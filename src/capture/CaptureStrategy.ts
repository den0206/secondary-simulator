export type FrameCallback = (frame: Uint8Array) => void;

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
