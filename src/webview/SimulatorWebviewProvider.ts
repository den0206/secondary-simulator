import * as fs from 'fs';
import * as vscode from 'vscode';
import {CaptureStrategy} from '../capture/CaptureStrategy';
import {H264Streamer} from '../capture/H264Streamer';
import {ScreenshotCapture} from '../capture/ScreenshotCapture';
import {StreamingCapture} from '../capture/StreamingCapture';
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

    // 初期設定をWebviewへ送信
    this.sendConfig();

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

        case 'longPress': {
          Logger.info(
            `Long press received: (${message.x}, ${message.y}), duration=${message.duration}ms`
          );
          await this.handleLongPress(
            message.x as number,
            message.y as number,
            message.duration as number | undefined
          );
          break;
        }

        case 'doubleTap': {
          Logger.info(`Double tap received: (${message.x}, ${message.y})`);
          await this.handleDoubleTap(message.x as number, message.y as number);
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

        case 'adjustFps':
          await this.handleFpsAdjustment(message.fps as number);
          break;

        case 'toggleOverlay':
          await this.handleOverlayToggle(message.enabled as boolean);
          break;
      }
    } catch (error) {
      Logger.error('Failed to handle message', error as Error);
      this.sendError((error as Error).message);
    }
  }

  private sendConfig(): void {
    if (!this.view) return;
    const config = vscode.workspace.getConfiguration('secondarySimulator');
    const tapThreshold = config.get<number>('tapThreshold', 10);
    const swipeThreshold = config.get<number>('swipeThreshold', 30);
    const showGestureOverlay = config.get<boolean>('showGestureOverlay', true);
    const longPressDuration = config.get<number>('longPressDuration', 600);
    this.postMessage({
      type: 'config',
      tapThreshold,
      swipeThreshold,
      showGestureOverlay,
      longPressDuration,
    });
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
    this.h264Streamer = new H264Streamer(device.platform, device.id, (msg) =>
      this.postMessage(msg)
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

  private async handleLongPress(
    x: number,
    y: number,
    durationMs?: number
  ): Promise<void> {
    if (!this.currentManager || !this.currentDeviceId) {
      Logger.warn('Cannot long-press: no device selected');
      return;
    }

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      Logger.warn(`Long press ignored due to invalid coordinates: x=${x}, y=${y}`);
      return;
    }

    const config = vscode.workspace.getConfiguration('secondarySimulator');
    const defaultDuration = config.get<number>('longPressDuration', 600);
    const duration =
      typeof durationMs === 'number' && Number.isFinite(durationMs)
        ? Math.max(200, Math.min(durationMs, 2000))
        : defaultDuration;

    const clampedX = this.clamp01(x);
    const clampedY = this.clamp01(y);
    const epsilon = 0.001;
    const x2 = this.clamp01(clampedX + epsilon);
    const y2 = this.clamp01(clampedY + epsilon);

    try {
      await this.currentManager.swipe(
        this.currentDeviceId,
        clampedX,
        clampedY,
        x2,
        y2,
        duration
      );
    } catch (error) {
      Logger.error('Failed to send long press', error as Error);
    }
  }

  private async handleDoubleTap(x: number, y: number): Promise<void> {
    if (!this.currentManager || !this.currentDeviceId) {
      Logger.warn('Cannot double-tap: no device selected');
      return;
    }

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      Logger.warn(`Double tap ignored due to invalid coordinates: x=${x}, y=${y}`);
      return;
    }

    const clampedX = this.clamp01(x);
    const clampedY = this.clamp01(y);

    try {
      await this.currentManager.tap(this.currentDeviceId, clampedX, clampedY);
      await new Promise((resolve) => setTimeout(resolve, 80));
      await this.currentManager.tap(this.currentDeviceId, clampedX, clampedY);
    } catch (error) {
      Logger.error('Failed to send double tap', error as Error);
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
        await fs.promises.writeFile(uri.fsPath, screenshot);
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

  private async handleFpsAdjustment(fps: number): Promise<void> {
    if (!this.currentCapture) return;

    Logger.info(`Adjusting FPS to ${fps} based on adaptive algorithm`);

    // Update the streaming FPS configuration
    const config = vscode.workspace.getConfiguration('secondarySimulator');
    await config.update('streamingFps', fps, vscode.ConfigurationTarget.Global);

    // Restart capture with new FPS if in streaming mode
    const captureMode = config.get<string>('captureMode', 'screenshot');
    if (captureMode === 'streaming' && this.currentDeviceId) {
      const device = this.devices.find((d) => d.id === this.currentDeviceId);
      if (device) {
        await this.startCaptureForDevice(this.currentDeviceId, device);
      }
    }
  }

  private async handleOverlayToggle(enabled: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('secondarySimulator');
    await config.update(
      'showGestureOverlay',
      !!enabled,
      vscode.ConfigurationTarget.Global
    );
    this.sendConfig();
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
    const htmlPath = vscode.Uri.joinPath(
      this.extensionUri,
      'media',
      'webview',
      'index.html'
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', 'main.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', 'style.css')
    );
    const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">`;

    const html = fs.readFileSync(htmlPath.fsPath, 'utf8');
    return html
      .replace('{{scriptUri}}', scriptUri.toString())
      .replace('{{styleUri}}', styleUri.toString())
      .replace('{{nonce}}', nonce)
      .replace('{{cspMeta}}', cspMeta);
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
    this.sendConfig();
  }

  dispose(): void {
    this.stopCapture();
    this.iosSimulator.dispose();
    this.androidEmulator.dispose();
  }
}
