import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import {CaptureStrategy} from '../capture/CaptureStrategy';
import {ScreenshotCapture} from '../capture/ScreenshotCapture';
import {StreamingCapture} from '../capture/StreamingCapture';
import {H264Streamer} from '../capture/H264Streamer';
import {AndroidEmulator} from '../simulator/AndroidEmulator';
import {IOSSimulator} from '../simulator/IOSSimulator';
import {SimulatorManager} from '../simulator/SimulatorManager';
import {Device, Platform} from '../simulator/types';
import {Logger} from '../utils/Logger';

export class SimulatorWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'simulatorView';

  private view?: vscode.WebviewView;
  private extensionUri: vscode.Uri;
  private iosSimulator: IOSSimulator;
  private androidEmulator: AndroidEmulator;
  private currentManager: SimulatorManager | null = null;
  private currentCapture: CaptureStrategy | null = null;
  private h264Streamer: H264Streamer | null = null;
  private forceJpegFallback = false;
  private currentDeviceId: string | null = null;
  private currentPlatform: Platform = 'ios';
  private devices: Device[] = [];
  private currentWidth: number = 420;

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
    this.iosSimulator = new IOSSimulator();
    this.androidEmulator = new AndroidEmulator();
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void | Thenable<void> {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      this.handleMessage.bind(this),
      undefined,
      []
    );

    webviewView.onDidDispose(() => {
      this.stopCapture();
    });

    webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible) {
        this.stopCapture();
      }
    });

    this.refreshDevices();
  }

  private async handleMessage(message: {
    type: string;
    [key: string]: unknown;
  }): Promise<void> {
    Logger.debug(`Received message: ${message.type}`);

    try {
      switch (message.type) {
        case 'init':
          await this.refreshDevices();
          break;

        case 'getCaptureMode':
          const currentMode = vscode.workspace
            .getConfiguration('secondarySimulator')
            .get<string>('captureMode', 'screenshot');
          this.postMessage({
            type: 'captureModeChanged',
            mode: currentMode,
          });
          break;

        case 'platformChange':
          this.currentPlatform = message.platform as Platform;
          await this.refreshDevices();
          break;

        case 'deviceChange':
          await this.selectDevice(message.deviceId as string);
          break;

        case 'tap':
          Logger.info(`Tap received: x=${message.x}, y=${message.y}`);
          await this.handleTap(message.x as number, message.y as number);
          break;

        case 'swipe': {
          Logger.info(
            `Swipe received: (${message.x1}, ${message.y1}) -> (${message.x2}, ${message.y2}), duration=${message.duration}ms`
          );
          await this.handleSwipe(
            message.x1 as number,
            message.y1 as number,
            message.x2 as number,
            message.y2 as number,
            (message.duration as number | undefined) ?? undefined
          );
          break;
        }

        case 'keypress':
          Logger.info(
            `Key pressed: ${message.key}${message.special ? ' (special)' : ''}`
          );
          await this.handleKeypress(
            message.key as string,
            message.special as boolean
          );
          break;

        case 'home':
          Logger.info('Home button pressed');
          await this.pressHome();
          break;

        case 'back':
          Logger.info('Back button pressed');
          await this.pressBack();
          break;

        case 'refreshDevices':
          Logger.info('Refresh devices requested');
          await this.refreshDevices();
          break;

        case 'saveScreenshot':
          await this.saveScreenshot();
          break;

        case 'disconnect':
          Logger.info('Disconnect requested');
          this.disconnect();
          break;

        case 'resize':
          this.currentWidth = message.width as number;
          if (this.currentCapture) {
            this.currentCapture.setMaxWidth(this.currentWidth);
          }
          break;

        case 'captureModeChange':
          await this.handleCaptureModeChange(message.mode as string);
          break;

        case 'fallback-jpeg':
          Logger.warn(
            `Webview requested JPEG fallback: ${message.reason ?? 'unknown'}`
          );
          await this.fallbackToJpeg();
          break;
      }
    } catch (error) {
      Logger.error('Failed to handle message', error as Error);
      this.sendError((error as Error).message);
    }
  }

  async refreshDevices(): Promise<void> {
    const manager =
      this.currentPlatform === 'ios' ? this.iosSimulator : this.androidEmulator;

    const isAvailable = await manager.isAvailable();
    if (!isAvailable) {
      const platform = this.currentPlatform === 'ios' ? 'Xcode' : 'Android SDK';
      this.sendError(`${platform} is not installed or not in PATH`);
      this.devices = [];
      this.postMessage({type: 'devices', devices: []});
      return;
    }

    this.devices = await manager.listDevices();
    this.postMessage({type: 'devices', devices: this.devices});
    this.postMessage({
      type: 'status',
      text: `${this.devices.length} devices found`,
    });
  }

  async selectDevice(deviceId: string): Promise<void> {
    if (!deviceId) {
      this.stopCapture();
      this.currentDeviceId = null;
      return;
    }

    const device = this.devices.find((d) => d.id === deviceId);
    if (!device) {
      this.sendError('Device not found');
      return;
    }

    if (device.state !== 'Booted') {
      this.sendError(
        'Device is not running. Please start the simulator first.'
      );
      return;
    }

    this.forceJpegFallback = false;
    await this.startCaptureForDevice(deviceId, device);
  }

  private async startCaptureForDevice(
    deviceId: string,
    device: Device
  ): Promise<void> {
    this.stopCapture();

    this.currentDeviceId = deviceId;
    this.currentManager =
      device.platform === 'ios' ? this.iosSimulator : this.androidEmulator;

    // キャプチャモードを設定から取得
    const captureMode = vscode.workspace
      .getConfiguration('secondarySimulator')
      .get<string>('captureMode', 'screenshot');

    const useH264 =
      captureMode === 'streaming' &&
      vscode.workspace
        .getConfiguration('secondarySimulator')
        .get<boolean>('experimentalH264', false) &&
      !this.forceJpegFallback;

    if (useH264) {
      await this.startH264Streaming(device);
    } else {
      await this.createCaptureInstance(captureMode);
      if (!this.currentCapture) {
        throw new Error('Failed to create capture instance');
      }

      this.currentCapture.setDevice(deviceId);

      this.currentCapture.onFrame((frame, stats) => {
        this.postMessage({
          type: 'frame',
          data: frame,
        });
        this.postMessage({
          type: 'stats',
          fps: stats.fps,
          latency: stats.latency,
        });
      });
    }

    if (useH264) {
      this.postMessage({
        type: 'status',
        text: 'Capturing (H.264 experimental)',
      });
      Logger.info(`Started H.264 streaming for device: ${device.name}`);
    } else if (this.currentCapture) {
      try {
        await this.currentCapture.start();
        this.postMessage({type: 'status', text: 'Capturing'});
        Logger.info(
          `Started capturing device: ${device.name} (mode: ${captureMode})`
        );
      } catch (error) {
        Logger.error('Failed to start capture', error as Error);
        this.sendError((error as Error).message || 'Failed to start capture');
      }
    }
  }

  private async createCaptureInstance(mode: string): Promise<void> {
    if (mode === 'streaming') {
      this.currentCapture = new StreamingCapture(
        this.currentManager!,
        this.currentWidth
      );
    } else {
      this.currentCapture = new ScreenshotCapture(
        this.currentManager!,
        this.currentWidth
      );
    }
  }

  private async startH264Streaming(device: Device): Promise<void> {
    if (this.h264Streamer) {
      this.h264Streamer.dispose();
      this.h264Streamer = null;
    }
    this.h264Streamer = new H264Streamer(
      device.platform,
      device.id,
      (msg) => this.postMessage(msg)
    );
    this.h264Streamer.start();
  }

  private async handleCaptureModeChange(mode: string): Promise<void> {
    if (!this.currentDeviceId) {
      this.sendError('No device selected');
      return;
    }

    const device = this.devices.find((d) => d.id === this.currentDeviceId);
    if (!device) {
      this.sendError('Device not found');
      return;
    }

    // 設定を更新
    const config = vscode.workspace.getConfiguration('secondarySimulator');
    await config.update('captureMode', mode, vscode.ConfigurationTarget.Global);

    Logger.info(`Switching capture mode to: ${mode}`);

    this.forceJpegFallback = false;
    // 新しいモードでキャプチャを再開
    await this.startCaptureForDevice(this.currentDeviceId, device);

    this.postMessage({
      type: 'captureModeChanged',
      mode,
    });
  }

  private clamp01(value: number): number {
    if (Number.isNaN(value)) {
      return 0.5;
    }
    return Math.min(1, Math.max(0, value));
  }

  private async handleTap(x: number, y: number): Promise<void> {
    if (!this.currentManager || !this.currentDeviceId) {
      Logger.warn('Cannot tap: no device selected');
      return;
    }

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      Logger.warn(`Tap ignored due to invalid coordinates: x=${x}, y=${y}`);
      return;
    }

    const clampedX = this.clamp01(x);
    const clampedY = this.clamp01(y);

    try {
      await this.currentManager.tap(this.currentDeviceId, clampedX, clampedY);
    } catch (error) {
      Logger.error('Failed to send tap', error as Error);
    }
  }

  private async handleSwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs?: number
  ): Promise<void> {
    if (!this.currentManager || !this.currentDeviceId) {
      Logger.warn('Cannot swipe: no device selected');
      return;
    }

    if (
      !Number.isFinite(x1) ||
      !Number.isFinite(y1) ||
      !Number.isFinite(x2) ||
      !Number.isFinite(y2)
    ) {
      Logger.warn(
        `Swipe ignored due to invalid coordinates: (${x1}, ${y1}) -> (${x2}, ${y2})`
      );
      return;
    }

    const clampedX1 = this.clamp01(x1);
    const clampedY1 = this.clamp01(y1);
    const clampedX2 = this.clamp01(x2);
    const clampedY2 = this.clamp01(y2);
    const safeDuration =
      typeof durationMs === 'number' && Number.isFinite(durationMs)
        ? Math.max(50, Math.min(durationMs, 3000))
        : undefined;

    try {
      await this.currentManager.swipe(
        this.currentDeviceId,
        clampedX1,
        clampedY1,
        clampedX2,
        clampedY2,
        safeDuration
      );
    } catch (error) {
      Logger.error('Failed to send swipe', error as Error);
    }
  }

  private async handleKeypress(key: string, special?: boolean): Promise<void> {
    if (!this.currentManager || !this.currentDeviceId) {
      Logger.warn('Cannot send key: no device selected');
      return;
    }

    try {
      await this.currentManager.sendKey(this.currentDeviceId, key, special);
    } catch (error) {
      Logger.error('Failed to send key', error as Error);
    }
  }

  private async pressHome(): Promise<void> {
    if (!this.currentManager || !this.currentDeviceId) {
      Logger.warn('Cannot press home: no device selected');
      return;
    }

    try {
      Logger.debug(`Pressing home on device: ${this.currentDeviceId}`);
      await this.currentManager.pressHome(this.currentDeviceId);
      Logger.debug('Home pressed successfully');
    } catch (error) {
      Logger.error('Failed to press home', error as Error);
    }
  }

  private async pressBack(): Promise<void> {
    if (!this.currentManager || !this.currentDeviceId) {
      Logger.warn('Cannot press back: no device selected');
      return;
    }

    try {
      await this.currentManager.pressBack(this.currentDeviceId);
    } catch (error) {
      Logger.error('Failed to press back', error as Error);
    }
  }

  private async saveScreenshot(): Promise<void> {
    if (!this.currentManager || !this.currentDeviceId) {
      vscode.window.showWarningMessage('No device selected');
      return;
    }

    try {
      const screenshot = await this.currentManager.takeScreenshot(
        this.currentDeviceId
      );

      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`screenshot-${Date.now()}.png`),
        filters: {
          'PNG Images': ['png'],
        },
      });

      if (uri) {
        await fs.writeFile(uri.fsPath, screenshot);
        vscode.window.showInformationMessage(
          `Screenshot saved to ${uri.fsPath}`
        );
      }
    } catch (error) {
      Logger.error('Failed to save screenshot', error as Error);
      vscode.window.showErrorMessage('Failed to save screenshot');
    }
  }

  private stopCapture(): void {
    if (this.currentCapture) {
      this.currentCapture.dispose();
      this.currentCapture = null;
    }
    if (this.h264Streamer) {
      this.h264Streamer.dispose();
      this.h264Streamer = null;
    }
    this.postMessage({type: 'status', text: 'Idle'});
  }

  private async fallbackToJpeg(): Promise<void> {
    if (!this.currentDeviceId) return;
    const device = this.devices.find((d) => d.id === this.currentDeviceId);
    if (!device) return;

    this.forceJpegFallback = true;
    this.stopCapture();
    await this.startCaptureForDevice(this.currentDeviceId, device);
  }

  private disconnect(): void {
    this.stopCapture();
    this.currentDeviceId = null;
    this.currentManager = null;
    this.postMessage({type: 'disconnected'});
    this.postMessage({type: 'status', text: 'Disconnected'});
    Logger.info('Device disconnected');
  }

  private postMessage(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  private sendError(text: string): void {
    this.postMessage({type: 'error', text});
  }

  private getHtmlContent(webview: vscode.Webview): string {
    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    body {
      margin: 0;
      padding: 8px;
      background: var(--vscode-sideBar-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }

    .device-selector {
      display: flex;
      gap: 4px;
      margin-bottom: 8px;
      flex-wrap: wrap;
    }

    .device-selector select {
      flex: 1;
      min-width: 100px;
      padding: 4px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 2px;
      font-size: 12px;
    }

    .simulator-container {
      position: relative;
      width: 100%;
      max-width: 420px;
      margin: 0 auto;
      background: #000;
      border-radius: 8px;
      overflow: hidden;
      min-height: 200px;
    }

    #simulator-canvas {
      width: 100%;
      height: auto;
      display: block;
      cursor: pointer;
    }

    .overlay {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.8);
      color: #fff;
      font-size: 12px;
      text-align: center;
      padding: 20px;
    }

    .overlay.hidden {
      display: none;
    }

    .controls {
      display: flex;
      justify-content: center;
      gap: 4px;
      margin-top: 8px;
      flex-wrap: wrap;
      max-width: 420px;
      margin-left: auto;
      margin-right: auto;
    }

    .control-btn {
      padding: 6px 10px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }

    .control-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .control-btn:active {
      transform: scale(0.95);
    }

    .status-bar {
      display: flex;
      justify-content: space-between;
      font-size: 10px;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-widget-border);
      opacity: 0.7;
      max-width: 420px;
      margin-left: auto;
      margin-right: auto;
    }

  </style>
</head>
<body>
  <div class="device-selector">
    <select id="platform">
      <option value="ios">iOS</option>
      <option value="android">Android</option>
    </select>
    <select id="device">
      <option value="">Select Device...</option>
    </select>
    <select id="capture-mode" title="Capture Mode">
      <option value="screenshot">Screenshot</option>
      <option value="streaming">Streaming</option>
    </select>
  </div>

  <div class="simulator-container">
    <canvas id="simulator-canvas" style="display: none;"></canvas>
    <div class="overlay" id="overlay">
      <span>Select a device to start</span>
    </div>
  </div>

  <div class="controls">
    <button class="control-btn" id="btn-home" title="Home">Home</button>
    <button class="control-btn" id="btn-back" title="Back">Back</button>
    <button class="control-btn" id="btn-screenshot" title="Save Screenshot">Save</button>
    <button class="control-btn" id="btn-refresh" title="Refresh Devices">Refresh</button>
    <button class="control-btn" id="btn-disconnect" title="Disconnect">Disconnect</button>
  </div>

  <div class="status-bar">
    <span id="fps">-- FPS</span>
    <span id="status">Idle</span>
    <span id="latency">-- ms</span>
    <span id="render-latency">Render -- ms</span>
    <span id="queue">Q:0</span>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const canvas = document.getElementById('simulator-canvas');
    const ctx = canvas.getContext('2d');
    const overlay = document.getElementById('overlay');
    const platformSelect = document.getElementById('platform');
    const deviceSelect = document.getElementById('device');
    const captureModeSelect = document.getElementById('capture-mode');

    // Touch/Mouse event handling for tap and swipe
    const clamp01 = (v) => Math.max(0, Math.min(1, v));

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    const SWIPE_THRESHOLD = 30; // minimum pixels for swipe
    const TAP_THRESHOLD = 10; // maximum pixels for tap

    canvas.addEventListener('mousedown', (e) => {
      isDragging = true;
      const rect = canvas.getBoundingClientRect();
      startX = e.clientX - rect.left;
      startY = e.clientY - rect.top;
      startTime = Date.now();
      e.preventDefault();
    });

    canvas.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      e.preventDefault();
    });

    canvas.addEventListener('mouseup', (e) => {
      if (!isDragging) return;
      isDragging = false;

      const rect = canvas.getBoundingClientRect();
      const endX = e.clientX - rect.left;
      const endY = e.clientY - rect.top;
      const duration = Date.now() - startTime;

      const deltaX = endX - startX;
      const deltaY = endY - startY;
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

      if (distance < TAP_THRESHOLD) {
        // It's a tap
        const x = clamp01(endX / rect.width);
        const y = clamp01(endY / rect.height);
        vscode.postMessage({ type: 'tap', x, y });
      } else if (distance >= SWIPE_THRESHOLD) {
        // It's a swipe
        const x1 = clamp01(startX / rect.width);
        const y1 = clamp01(startY / rect.height);
        const x2 = clamp01(endX / rect.width);
        const y2 = clamp01(endY / rect.height);
        vscode.postMessage({ type: 'swipe', x1, y1, x2, y2, duration });
      }
    });

    canvas.addEventListener('mouseleave', () => {
      isDragging = false;
    });

    // Touch events for mobile/trackpad
    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        const touch = e.touches[0];
        const rect = canvas.getBoundingClientRect();
        startX = touch.clientX - rect.left;
        startY = touch.clientY - rect.top;
        startTime = Date.now();
        isDragging = true;
      }
      e.preventDefault();
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
      if (!isDragging || e.changedTouches.length !== 1) return;
      isDragging = false;

      const touch = e.changedTouches[0];
      const rect = canvas.getBoundingClientRect();
      const endX = touch.clientX - rect.left;
      const endY = touch.clientY - rect.top;
      const duration = Date.now() - startTime;

      const deltaX = endX - startX;
      const deltaY = endY - startY;
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

      if (distance < TAP_THRESHOLD) {
        const x = clamp01(endX / rect.width);
        const y = clamp01(endY / rect.height);
        vscode.postMessage({ type: 'tap', x, y });
      } else if (distance >= SWIPE_THRESHOLD) {
        const x1 = clamp01(startX / rect.width);
        const y1 = clamp01(startY / rect.height);
        const x2 = clamp01(endX / rect.width);
        const y2 = clamp01(endY / rect.height);
        vscode.postMessage({ type: 'swipe', x1, y1, x2, y2, duration });
      }
      e.preventDefault();
    }, { passive: false });

    // Keyboard input handling
    document.addEventListener('keydown', (e) => {
      // Only capture when screen is visible and focused
      if (!canvas || canvas.style.display === 'none') return;

      // Ignore modifier-only keys and some special keys
      if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab'].includes(e.key)) return;

      // Handle special keys
      if (e.key === 'Backspace') {
        vscode.postMessage({ type: 'keypress', key: 'delete', special: true });
        e.preventDefault();
        return;
      }

      if (e.key === 'Enter') {
        vscode.postMessage({ type: 'keypress', key: 'return', special: true });
        e.preventDefault();
        return;
      }

      if (e.key === 'Escape') {
        vscode.postMessage({ type: 'keypress', key: 'escape', special: true });
        e.preventDefault();
        return;
      }

      // For regular characters
      if (e.key.length === 1) {
        vscode.postMessage({ type: 'keypress', key: e.key });
        e.preventDefault();
      }
    });

    platformSelect.addEventListener('change', () => {
      vscode.postMessage({
        type: 'platformChange',
        platform: platformSelect.value
      });
    });

    deviceSelect.addEventListener('change', () => {
      vscode.postMessage({
        type: 'deviceChange',
        deviceId: deviceSelect.value
      });
    });

    if (captureModeSelect) {
      captureModeSelect.addEventListener('change', () => {
        vscode.postMessage({
          type: 'captureModeChange',
          mode: captureModeSelect.value
        });
      });
    }

    document.getElementById('btn-home').addEventListener('click', () => {
      vscode.postMessage({ type: 'home' });
    });

    document.getElementById('btn-back').addEventListener('click', () => {
      vscode.postMessage({ type: 'back' });
    });

    document.getElementById('btn-screenshot').addEventListener('click', () => {
      vscode.postMessage({ type: 'saveScreenshot' });
    });

    document.getElementById('btn-refresh').addEventListener('click', () => {
      vscode.postMessage({ type: 'refreshDevices' });
    });

    document.getElementById('btn-disconnect').addEventListener('click', () => {
      vscode.postMessage({ type: 'disconnect' });
    });

    let pendingFrame = null;
    let currentBitmap = null;
    let isRendering = false;
    let lastRenderAt = 0;
    let animationFrameId = null;

    // WebCodecs (H.264) pipeline groundwork
    let decoder = null;
    let decoderConfig = null;
    let decodedQueue = 0;
    let lastChunkTime = performance.now();

    const maxDecodeQueue = 3;
    let askedFallback = false;

    function normalizeToUint8Array(data) {
      if (data instanceof Uint8Array) return data;
      if (data?.data && Array.isArray(data.data)) {
        return new Uint8Array(data.data);
      }
      if (Array.isArray(data)) {
        return new Uint8Array(data);
      }
      return null;
    }

    // Optimized rendering using requestAnimationFrame (mobiledeck approach)
    async function renderFrame(bytes) {
      if (!bytes) return;
      const started = performance.now();
      try {
        const blob = new Blob([bytes], { type: 'image/jpeg' });
        const bitmap = await createImageBitmap(blob);

        // Clean up previous bitmap to free GPU memory
        if (currentBitmap) {
          currentBitmap.close?.();
          currentBitmap = null;
        }

        currentBitmap = bitmap;

        // Resize canvas to frame size once
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }

        // Draw using RAF for smoother rendering
        if (animationFrameId !== null) {
          cancelAnimationFrame(animationFrameId);
        }

        animationFrameId = requestAnimationFrame(() => {
          if (currentBitmap && ctx) {
            ctx.drawImage(currentBitmap, 0, 0, canvas.width, canvas.height);

            const renderLatency = Math.round(performance.now() - started);
            document.getElementById('render-latency').textContent =
              'Render ' + renderLatency + ' ms';
          }
          animationFrameId = null;
        });

        lastRenderAt = performance.now();
      } catch (err) {
        console.error('Failed to render frame', err);
        // Clean up on error
        if (currentBitmap) {
          currentBitmap.close?.();
          currentBitmap = null;
        }
      }
    }

    // --- WebCodecs decode path for future H.264 stream support ---
    function requestFallback(reason) {
      if (askedFallback) return;
      askedFallback = true;
      vscode.postMessage({ type: 'fallback-jpeg', reason });
    }

    function ensureDecoder(config) {
      if (!('VideoDecoder' in window)) {
        console.warn('WebCodecs not available');
        requestFallback('VideoDecoder unavailable');
        return null;
      }
      if (decoder && decoderConfig && JSON.stringify(decoderConfig) === JSON.stringify(config)) {
        return decoder;
      }
      if (decoder) {
        try { decoder.close(); } catch (_) {}
        decoder = null;
      }
      decoderConfig = config;
      decoder = new VideoDecoder({
        output: handleDecodedFrame,
        error: (e) => {
          console.error('Decoder error', e);
          requestFallback('decoder error');
        },
      });
      try {
        decoder.configure(config);
      } catch (e) {
        console.error('Failed to configure decoder', e);
        requestFallback('configure failed');
        decoder = null;
      }
      decodedQueue = 0;
      return decoder;
    }

    function handleDecodedFrame(videoFrame) {
      decodedQueue = Math.max(0, decodedQueue - 1);
      try {
        if (canvas.width !== videoFrame.codedWidth || canvas.height !== videoFrame.codedHeight) {
          canvas.width = videoFrame.codedWidth;
          canvas.height = videoFrame.codedHeight;
        }
        const started = performance.now();
        const renderWidth = canvas.width;
        const renderHeight = canvas.height;

        // drawImage accepts VideoFrame directly
        ctx.drawImage(videoFrame, 0, 0, renderWidth, renderHeight);
        lastRenderAt = performance.now();
        document.getElementById('render-latency').textContent =
          'Render ' + Math.round(lastRenderAt - started) + ' ms';
      } catch (e) {
        console.error('Failed to draw decoded frame', e);
      } finally {
        videoFrame.close();
      }
    }

    function convertAnnexBToAvcc(bytes) {
      // strip start code if present and prefix length (4 bytes)
      let offset = 0;
      if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x00 && bytes[3] === 0x01) {
        offset = 4;
      } else if (bytes.length >= 3 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01) {
        offset = 3;
      }
      const nal = bytes.subarray(offset);
      const len = nal.length;
      const out = new Uint8Array(4 + len);
      out[0] = (len >>> 24) & 0xff;
      out[1] = (len >>> 16) & 0xff;
      out[2] = (len >>> 8) & 0xff;
      out[3] = len & 0xff;
      out.set(nal, 4);
      return out;
    }

    function handleH264Chunk(data, isKeyframe) {
      const bytes = normalizeToUint8Array(data);
      if (!bytes || !decoder) return;
      const chunkData = convertAnnexBToAvcc(bytes);
      if (decoder.decodeQueueSize >= maxDecodeQueue) {
        // Drop to keep latency low
        return;
      }
      decodedQueue = Math.min(maxDecodeQueue, decodedQueue + 1);
      lastChunkTime = performance.now();
      try {
        decoder.decode(new EncodedVideoChunk({
          type: isKeyframe ? 'key' : 'delta',
          timestamp: lastChunkTime * 1000, // microseconds
          data: chunkData,
        }));
        document.getElementById('queue').textContent = 'Q:' + decodedQueue;
      } catch (e) {
        console.error('decode failed', e);
        requestFallback('decode failed');
      }
    }

    function dequeueAndRender() {
      if (isRendering || !pendingFrame) return;
      const frame = pendingFrame;
      pendingFrame = null;
      isRendering = true;
      renderFrame(frame).finally(() => {
        isRendering = false;
        document.getElementById('queue').textContent = 'Q:' + (pendingFrame ? 1 : 0);
        // If another frame arrived while rendering, render it next
        if (pendingFrame) {
          requestAnimationFrame(dequeueAndRender);
        }
      });
    }

    function enqueueFrame(data) {
      const bytes = normalizeToUint8Array(data);
      if (!bytes) {
        console.warn('Dropping frame: could not normalize data');
        return;
      }
      pendingFrame = bytes;
      document.getElementById('queue').textContent = 'Q:1';
      if (!isRendering) {
        requestAnimationFrame(dequeueAndRender);
      }
    }

    window.addEventListener('message', (event) => {
      const message = event.data;

      switch (message.type) {
        case 'h264-config': {
          // Expect {codec, description} etc.
          const config = {
            codec: message.codec || 'avc1.42E01E',
            description: message.description
              ? new Uint8Array(message.description)
              : undefined,
          };
          ensureDecoder(config);
          break;
        }

        case 'h264-chunk':
          handleH264Chunk(message.data, !!message.isKeyframe);
          canvas.style.display = 'block';
          overlay.classList.add('hidden');
          break;

        case 'frame':
          enqueueFrame(message.data);
          canvas.style.display = 'block';
          overlay.classList.add('hidden');
          break;

        case 'devices':
          updateDeviceList(message.devices);
          break;

        case 'stats':
          document.getElementById('fps').textContent = message.fps + ' FPS';
          document.getElementById('latency').textContent = message.latency + ' ms';
          break;

        case 'status':
          document.getElementById('status').textContent = message.text;
          break;

        case 'error':
          // Clean up resources on error
          if (currentBitmap) {
            currentBitmap.close?.();
            currentBitmap = null;
          }
          if (animationFrameId !== null) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
          }

          overlay.classList.remove('hidden');
          overlay.querySelector('span').textContent = message.text;
          screen.style.display = 'none';
          break;

        case 'disconnected':
          // Clean up resources (mobiledeck approach)
          if (currentBitmap) {
            currentBitmap.close?.();
            currentBitmap = null;
          }
          if (animationFrameId !== null) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
          }
          pendingFrame = null;

          overlay.classList.remove('hidden');
          overlay.querySelector('span').textContent = 'Select a device to start';
          screen.style.display = 'none';
          deviceSelect.value = '';
          document.getElementById('fps').textContent = '-- FPS';
          document.getElementById('latency').textContent = '-- ms';
          break;

        case 'captureModeChanged':
          if (captureModeSelect) {
            captureModeSelect.value = message.mode;
          }
          break;
      }
    });

    function updateDeviceList(devices) {
      deviceSelect.innerHTML = '<option value="">Select Device...</option>';
      devices.forEach(device => {
        const option = document.createElement('option');
        option.value = device.id;
        const state = device.state === 'Booted' ? '' : ' (Shutdown)';
        option.textContent = device.name + state;
        deviceSelect.appendChild(option);
      });
    }

    let resizeTimeout;
    function sendResize() {
      const container = document.querySelector('.simulator-container');
      if (container) {
        const width = Math.round(container.clientWidth);
        vscode.postMessage({ type: 'resize', width: width });
      }
    }

    window.addEventListener('resize', () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(sendResize, 200);
    });

    // Clean up resources when page unloads (mobiledeck approach)
    window.addEventListener('beforeunload', () => {
      if (currentBitmap) {
        currentBitmap.close?.();
        currentBitmap = null;
      }
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
      if (decoder) {
        try { decoder.close(); } catch (_) {}
        decoder = null;
      }
    });

    // 初期設定を取得
    vscode.postMessage({ type: 'init' });
    vscode.postMessage({ type: 'getCaptureMode' });
    setTimeout(sendResize, 100);
  </script>
</body>
</html>`;
  }

  private getNonce(): string {
    let text = '';
    const possible =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  onConfigurationChanged(): void {
    if (this.currentCapture) {
      this.currentCapture.updateConfig();
    }
  }

  dispose(): void {
    this.stopCapture();
    this.iosSimulator.dispose();
    this.androidEmulator.dispose();
  }
}
