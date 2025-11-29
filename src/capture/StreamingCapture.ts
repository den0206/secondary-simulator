import sharp from 'sharp';
import * as vscode from 'vscode';
import {SimulatorManager} from '../simulator/SimulatorManager';
import {Logger} from '../utils/Logger';
import {FFmpegDetector} from '../utils/FFmpegDetector';
import {CaptureStrategy, FrameCallback} from './CaptureStrategy';

/**
 * ストリーミング方式のキャプチャ実装
 * 高速スクリーンショット方式（ScreenshotCaptureの高速版）
 * ffmpegが利用可能な場合は最適化を適用
 */
export class StreamingCapture implements CaptureStrategy {
  private manager: SimulatorManager;
  private deviceId: string | null = null;
  private frameCallback: FrameCallback | null = null;
  private timer: NodeJS.Timeout | null = null;
  private isCapturing: boolean = false;
  private isTakingScreenshot: boolean = false;
  private frameCount: number = 0;
  private lastFpsUpdate: number = 0;
  private currentFps: number = 0;
  private maxWidth: number | null = null;
  private useFFmpeg: boolean = false;
  private pendingFrames: Buffer[] = [];
  private isProcessingFrame: boolean = false;
  private readonly MAX_PENDING_FRAMES = 3;  // mobiledeck approach: limit queue size
  private consecutiveErrors: number = 0;
  private readonly MAX_CONSECUTIVE_ERRORS = 5;  // Stop after 5 consecutive errors

  constructor(manager: SimulatorManager, initialWidth?: number) {
    this.manager = manager;
    this.maxWidth = initialWidth || null;
  }

  private getConfig<T>(key: string): T {
    const config = vscode.workspace.getConfiguration('secondarySimulator');
    return config.get<T>(key) as T;
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

    // ffmpegが利用可能か確認（オプション）
    this.useFFmpeg = await FFmpegDetector.isAvailable();
    if (this.useFFmpeg) {
      Logger.info('Using ffmpeg optimization for streaming');
    }

    this.isCapturing = true;
    this.frameCount = 0;
    this.lastFpsUpdate = Date.now();
    this.currentFps = 0;
    this.pendingFrames = [];

    const fps = this.getConfig<number>('streamingFps') || 15;
    const interval = 1000 / fps; // フレーム間隔（ミリ秒）

    Logger.info(`Starting streaming capture for device: ${this.deviceId} at ${fps} fps`);
    this.scheduleNextCapture(interval);
  }

  stop(): void {
    this.isCapturing = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // バッファ内のBufferをクリアしてメモリを解放
    this.pendingFrames.forEach((buf) => {
      if (Buffer.isBuffer(buf)) {
        buf.fill(0);
      }
    });
    this.pendingFrames = [];
    Logger.info('Streaming capture stopped');
  }

  setMaxWidth(width: number): void {
    this.maxWidth = width;
  }

  updateConfig(): void {
    // 実行中の場合は再起動が必要
    if (this.isCapturing) {
      const wasCapturing = this.isCapturing;
      this.stop();
      if (wasCapturing) {
        this.start();
      }
    }
  }

  dispose(): void {
    this.stop();
    this.frameCallback = null;
    this.deviceId = null;
    // 念のため、再度バッファをクリア
    this.pendingFrames.forEach((buf) => {
      if (Buffer.isBuffer(buf)) {
        buf.fill(0);
      }
    });
    this.pendingFrames = [];
  }

  private scheduleNextCapture(interval: number): void {
    if (!this.isCapturing) {
      return;
    }

    // Drop oldest frames if queue is full (mobiledeck low-latency approach)
    const lowLatency = this.getConfig<boolean>('streamingLowLatency') || false;
    if (lowLatency && this.pendingFrames.length >= this.MAX_PENDING_FRAMES) {
      // Drop oldest frame to maintain low latency
      const dropped = this.pendingFrames.shift();
      if (dropped && Buffer.isBuffer(dropped)) {
        dropped.fill(0);
      }
      Logger.debug(`Dropped frame to maintain low latency (queue: ${this.pendingFrames.length})`);
    } else if (!lowLatency && this.pendingFrames.length >= this.MAX_PENDING_FRAMES * 2) {
      // In normal mode, allow more buffering but still limit
      const dropped = this.pendingFrames.shift();
      if (dropped && Buffer.isBuffer(dropped)) {
        dropped.fill(0);
      }
      Logger.debug(`Dropped frame due to queue overflow (queue: ${this.pendingFrames.length})`);
    }

    this.timer = setTimeout(() => {
      this.captureFrame(interval);
    }, interval);
  }

  private async captureFrame(interval: number): Promise<void> {
    if (!this.isCapturing || !this.deviceId) {
      this.scheduleNextCapture(interval);
      return;
    }

    // 前のフレーム処理中でも、低遅延モードの場合は並行して取得
    const lowLatency = this.getConfig<boolean>('streamingLowLatency') || false;
    if (!lowLatency && this.isTakingScreenshot) {
      this.scheduleNextCapture(interval);
      return;
    }

    this.isTakingScreenshot = true;
    const startTime = Date.now();

    try {
      const screenshot = await this.manager.takeScreenshot(this.deviceId);

      // Success: reset error counter
      this.consecutiveErrors = 0;

      // フレームをバッファに追加
      this.pendingFrames.push(screenshot);

      // 非同期で処理（低遅延モードでは並行処理）
      if (!this.isProcessingFrame) {
        setImmediate(() => this.processNextFrame(startTime, interval));
      }
    } catch (error) {
      this.consecutiveErrors++;
      Logger.error(
        `Failed to capture frame (${this.consecutiveErrors}/${this.MAX_CONSECUTIVE_ERRORS})`,
        error as Error
      );

      this.isTakingScreenshot = false;

      // Stop capturing after too many consecutive errors
      if (this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
        Logger.error('Too many consecutive errors, stopping capture');
        this.stop();
        return;
      }

      // エラー時もバッファをクリア
      this.pendingFrames.forEach((buf) => {
        if (Buffer.isBuffer(buf)) {
          buf.fill(0);
        }
      });
      this.pendingFrames = [];

      // Exponential backoff on errors
      const backoffInterval = Math.min(interval * Math.pow(2, this.consecutiveErrors - 1), 5000);
      this.timer = setTimeout(() => {
        this.captureFrame(interval);
      }, backoffInterval);
      return;
    }

    this.isTakingScreenshot = false;
  }

  private async processNextFrame(startTime: number, interval: number): Promise<void> {
    if (this.isProcessingFrame || this.pendingFrames.length === 0) {
      this.isTakingScreenshot = false;
      this.scheduleNextCapture(interval);
      return;
    }

    this.isProcessingFrame = true;
    const screenshot = this.pendingFrames.shift();
    this.isTakingScreenshot = false;

    if (!screenshot) {
      this.isProcessingFrame = false;
      this.scheduleNextCapture(interval);
      return;
    }

    try {
      const processed = await this.processImage(screenshot);
      const frameBytes = new Uint8Array(
        processed.buffer,
        processed.byteOffset,
        processed.byteLength
      );

      this.frameCount++;
      const now = Date.now();
      const elapsed = now - this.lastFpsUpdate;

      if (elapsed >= 1000) {
        this.currentFps = Math.round((this.frameCount * 1000) / elapsed);
        this.frameCount = 0;
        this.lastFpsUpdate = now;
      }

      const latency = now - startTime;

      if (this.frameCallback) {
        this.frameCallback(frameBytes, {
          fps: this.currentFps,
          latency,
        });
      }

      // メモリを解放
      processed.fill(0);
      // 元のscreenshot Bufferもクリア
      if (Buffer.isBuffer(screenshot)) {
        screenshot.fill(0);
      }
    } catch (error) {
      Logger.error('Failed to process frame', error as Error);
      // エラー時もscreenshot Bufferをクリア
      if (screenshot && Buffer.isBuffer(screenshot)) {
        screenshot.fill(0);
      }
    } finally {
      this.isProcessingFrame = false;

      // 次のフレームを処理（バッファに残っている場合）
      if (this.pendingFrames.length > 0) {
        setImmediate(() => this.processNextFrame(Date.now(), interval));
      }

      this.scheduleNextCapture(interval);
    }
  }

  private async processImage(buffer: Buffer): Promise<Buffer> {
    const maxWidth = this.maxWidth || this.getConfig<number>('maxWidth');
    const quality = this.getConfig<number>('imageQuality');

    try {
      // ffmpegが利用可能な場合でも、sharpを使用（より軽量で確実）
      // 将来的にffmpegを使用した最適化を追加可能
      const processed = await sharp(buffer)
        .resize(maxWidth, null, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({
          quality,
          mozjpeg: true,
          progressive: false, // ストリーミングではプログレッシブJPEGは不要
        })
        .toBuffer();

      return processed;
    } catch (error) {
      Logger.error('Failed to process image', error as Error);
      return buffer;
    }
  }
}
