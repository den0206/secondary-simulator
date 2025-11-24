import {SimulatorManager} from '../simulator/SimulatorManager';

export type FrameCallback = (
  frame: Uint8Array,
  stats: {fps: number; latency: number}
) => void;

/**
 * キャプチャ戦略のインターフェース
 * スクリーンショット方式とストリーミング方式の両方をサポート
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
   * 最大表示幅を設定
   */
  setMaxWidth(width: number): void;

  /**
   * 設定を更新
   */
  updateConfig(): void;

  /**
   * リソースを解放
   */
  dispose(): void;
}

