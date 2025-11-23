import * as vscode from 'vscode';
import sharp from 'sharp';
import { SimulatorManager } from '../simulator/SimulatorManager';
import { FrameBuffer } from './FrameBuffer';
import { Logger } from '../utils/Logger';

export type FrameCallback = (frame: string, stats: { fps: number; latency: number }) => void;

export class ScreenshotCapture {
  private manager: SimulatorManager;
  private deviceId: string | null = null;
  private frameBuffer: FrameBuffer;
  private frameCallback: FrameCallback | null = null;
  private timer: NodeJS.Timeout | null = null;
  private isCapturing: boolean = false;
  private isTakingScreenshot: boolean = false;
  private frameCount: number = 0;
  private lastFpsUpdate: number = 0;
  private currentFps: number = 0;
  private maxWidth: number | null = null;

  constructor(manager: SimulatorManager, initialWidth?: number) {
    this.manager = manager;
    this.frameBuffer = new FrameBuffer(this.getConfig('refreshInterval'));
    this.maxWidth = initialWidth || null;
  }

  private getConfig<T>(key: string): T {
    const config = vscode.workspace.getConfiguration('secondarySimulator');
    return config.get<T>(key) as T;
  }

  setDevice(deviceId: string): void {
    this.deviceId = deviceId;
    this.frameBuffer.reset();
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

    this.isCapturing = true;
    this.frameCount = 0;
    this.lastFpsUpdate = Date.now();
    this.currentFps = 0;

    Logger.info(`Starting capture for device: ${this.deviceId}`);
    this.scheduleNextCapture();
  }

  stop(): void {
    this.isCapturing = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    Logger.info('Capture stopped');
  }

  private scheduleNextCapture(): void {
    if (!this.isCapturing) {
      return;
    }

    const adaptiveEnabled = this.getConfig<boolean>('adaptiveRefresh');
    const interval = this.frameBuffer.getAdaptiveInterval(adaptiveEnabled);

    this.timer = setTimeout(() => {
      this.captureFrame();
    }, interval);
  }

  private async captureFrame(): Promise<void> {
    if (!this.isCapturing || !this.deviceId || this.isTakingScreenshot) {
      this.scheduleNextCapture();
      return;
    }

    this.isTakingScreenshot = true;
    const startTime = Date.now();

    try {
      const screenshot = await this.manager.takeScreenshot(this.deviceId);

      if (!this.frameBuffer.shouldSendFrame(screenshot)) {
        this.scheduleNextCapture();
        return;
      }

      const processed = await this.processImage(screenshot);
      const base64 = processed.toString('base64');

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
        this.frameCallback(base64, {
          fps: this.currentFps,
          latency
        });
      }

      // Clear reference to free memory
      processed.fill(0);
    } catch (error) {
      Logger.error('Failed to capture frame', error as Error);
    } finally {
      this.isTakingScreenshot = false;
      this.scheduleNextCapture();
    }
  }

  setMaxWidth(width: number): void {
    this.maxWidth = width;
  }

  private async processImage(buffer: Buffer): Promise<Buffer> {
    const maxWidth = this.maxWidth || this.getConfig<number>('maxWidth');
    const quality = this.getConfig<number>('imageQuality');

    try {
      const processed = await sharp(buffer)
        .resize(maxWidth, null, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .jpeg({
          quality,
          mozjpeg: true
        })
        .toBuffer();

      return processed;
    } catch (error) {
      Logger.error('Failed to process image', error as Error);
      return buffer;
    }
  }

  updateConfig(): void {
    const interval = this.getConfig<number>('refreshInterval');
    this.frameBuffer.setBaseInterval(interval);
  }

  dispose(): void {
    this.stop();
    this.frameCallback = null;
    this.deviceId = null;
  }
}
