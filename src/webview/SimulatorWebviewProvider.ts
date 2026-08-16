import * as fs from 'fs';
import * as vscode from 'vscode';
import {CaptureStrategy} from '../capture/CaptureStrategy';
import {H264Streamer} from '../capture/H264Streamer';
import {MjpegCapture} from '../capture/MjpegCapture';
import {SimulatorInputController} from '../input/SimulatorInputController';
import {Device, DeviceType} from '../simulator/types';
import {JsonRpcClient} from '../utils/JsonRpcClient';
import {Logger} from '../utils/Logger';
import {MobileCliClient} from '../utils/MobileCliClient';
import {MobileCliServer} from '../utils/MobileCliServer';

export class SimulatorWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'simulatorView';

  private view?: vscode.WebviewView;
  private extensionUri: vscode.Uri;
  private currentCapture: CaptureStrategy | null = null;
  private h264Streamer: H264Streamer | null = null;
  private mobileCliServer: MobileCliServer;
  private mobileCliClient: MobileCliClient | null = null;
  private inputController: SimulatorInputController | null = null;
  private currentDeviceId: string | null = null;
  private devices: Device[] = [];
  private screenSize: {width: number; height: number} | null = null;
  private messageDisposable?: vscode.Disposable;
  private disposeDisposable?: vscode.Disposable;
  private visibilityDisposable?: vscode.Disposable;

  constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
    this.extensionUri = extensionUri;
    // mobilecliサーバーを初期化（必須）
    this.mobileCliServer = new MobileCliServer(context);
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

    // イベントリスナーを保持して、dispose時にクリーンアップできるようにする
    this.messageDisposable = webviewView.webview.onDidReceiveMessage(
      this.handleMessage.bind(this),
      undefined,
      []
    );

    // 初期設定をWebviewへ送信
    this.sendConfig();

    this.disposeDisposable = webviewView.onDidDispose(() => {
      this.stopCapture();
    });

    this.visibilityDisposable = webviewView.onDidChangeVisibility(() => {
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

        case 'gesture': {
          Logger.info(
            `Gesture received with ${
              (
                message.points as Array<{
                  x: number;
                  y: number;
                  duration: number;
                }>
              ).length
            } points`
          );
          await this.handleGesture(
            message.points as Array<{x: number; y: number; duration: number}>
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

        case 'disconnect':
          Logger.info('Disconnect requested');
          this.disconnect();
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
    const longPressDuration = config.get<number>('longPressDuration', 600);
    this.postMessage({
      type: 'config',
      tapThreshold,
      swipeThreshold,
      longPressDuration,
    });
  }

  async refreshDevices(): Promise<void> {
    // mobilecliクライアントを初期化（まだ初期化されていない場合）
    if (!this.mobileCliClient) {
      try {
        if (!this.mobileCliServer.isServerRunning()) {
          await this.mobileCliServer.launchServer();
        }
        const serverPort = this.mobileCliServer.getServerPort();
        const jsonRpcClient = new JsonRpcClient(
          `http://localhost:${serverPort}`
        );
        this.mobileCliClient = new MobileCliClient(jsonRpcClient);
      } catch (error) {
        Logger.error('Failed to initialize mobilecli client', error as Error);
        this.sendError(
          `Failed to initialize mobilecli: ${(error as Error).message}`
        );
        this.devices = [];
        this.postMessage({type: 'devices', devices: []});
        return;
      }
    }

    try {
      const response = await this.mobileCliClient.listDevices(true);
      // DeviceDescriptorをDeviceに変換
      this.devices = response.devices.map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform,
        state: d.state === 'online' ? 'Booted' : 'Shutdown',
        runtime: d.version || '',
        type: d.type as DeviceType,
      }));
      this.postMessage({type: 'devices', devices: this.devices});
      this.postMessage({
        type: 'status',
        text: `${this.devices.length} devices found`,
      });
    } catch (error) {
      Logger.error('Failed to list devices via mobilecli', error as Error);
      this.sendError(`Failed to list devices: ${(error as Error).message}`);
      this.devices = [];
      this.postMessage({type: 'devices', devices: []});
    }
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

    await this.startCaptureForDevice(deviceId, device);
  }

  private async startCaptureForDevice(
    deviceId: string,
    device: Device
  ): Promise<void> {
    this.stopCapture();

    this.currentDeviceId = deviceId;

    // Get device info and send screen size to webview (mobiledeck-style)
    if (this.mobileCliClient) {
      try {
        const deviceInfo = await this.mobileCliClient.getDeviceInfo(deviceId);
        if (deviceInfo?.device?.screenSize) {
          this.screenSize = {
            width: deviceInfo.device.screenSize.width,
            height: deviceInfo.device.screenSize.height,
          };
          this.postMessage({
            type: 'screenSize',
            width: this.screenSize.width,
            height: this.screenSize.height,
          });
        }
      } catch (error) {
        Logger.warn(
          `Failed to get device info for screen size: ${
            (error as Error).message
          }`
        );
      }
    }

    // 入力コントローラを初期化（iOS Simulator は HID 直接注入、それ以外は WDA フォールバック）
    if (this.mobileCliClient) {
      this.inputController?.dispose();
      this.inputController = new SimulatorInputController({
        deviceId,
        platform: device.platform,
        type: device.type ?? 'simulator',
        mobileCliClient: this.mobileCliClient,
        getScreenSize: () => this.screenSize,
        sidecarBinaryPath: this.resolveSidecarPath(),
        onBackendChange: (kind) => {
          this.postMessage({
            type: 'status',
            text: kind === 'hid' ? '高速モード (HID)' : '互換モード (WDA)',
          });
        },
      });
      try {
        await this.inputController.init();
      } catch (error) {
        Logger.warn(
          `入力コントローラの初期化に失敗: ${(error as Error).message}`
        );
      }
    }

    // H.264ストリーミング（実験的）のチェック
    const useH264 = vscode.workspace
      .getConfiguration('secondarySimulator')
      .get<boolean>('experimentalH264', false);

    if (useH264) {
      await this.startH264Streaming(device);
    } else {
      // MJPEGストリーミングを使用
      await this.createCaptureInstance();
      if (!this.currentCapture) {
        throw new Error('Failed to create capture instance');
      }

      this.currentCapture.setDevice(deviceId);

      this.currentCapture.onFrame((frame, stats) => {
        this.postMessage({
          type: 'frame',
          data: frame,
        });
      });

      try {
        await this.currentCapture.start();
        Logger.info(`Started MJPEG streaming for device: ${device.name}`);
      } catch (error) {
        Logger.error('Failed to start capture', error as Error);
        this.sendError((error as Error).message || 'Failed to start capture');
      }
    }

    if (useH264) {
      Logger.info(`Started H.264 streaming for device: ${device.name}`);
    }
  }

  private async createCaptureInstance(): Promise<void> {
    try {
      // mobilecliサーバーを起動
      if (!this.mobileCliServer.isServerRunning()) {
        await this.mobileCliServer.launchServer();
      }
      const serverPort = this.mobileCliServer.getServerPort();

      // JSON-RPCクライアントとMobileCliClientを初期化（まだ初期化されていない場合）
      if (!this.mobileCliClient) {
        const jsonRpcClient = new JsonRpcClient(
          `http://localhost:${serverPort}`
        );
        this.mobileCliClient = new MobileCliClient(jsonRpcClient);
      }

      // MJPEGストリーミングを使用
      this.currentCapture = new MjpegCapture(serverPort);
      Logger.info('Using MJPEG streaming capture with mobilecli');
    } catch (error) {
      Logger.error(
        `Failed to start mobilecli server: ${(error as Error).message}`
      );
      throw new Error(
        `Failed to start mobilecli server. Please ensure mobilecli is installed and available.`
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

  private clamp01(value: number): number {
    if (Number.isNaN(value)) {
      return 0.5;
    }
    return Math.min(1, Math.max(0, value));
  }

  private async handleTap(x: number, y: number): Promise<void> {
    if (!this.currentDeviceId || !this.inputController) {
      Logger.warn('Cannot tap: no device selected');
      return;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      Logger.warn(`Tap ignored due to invalid coordinates: x=${x}, y=${y}`);
      return;
    }
    await this.inputController.tap(this.clamp01(x), this.clamp01(y));
  }

  private async handleSwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs?: number
  ): Promise<void> {
    if (!this.currentDeviceId || !this.inputController) {
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
    await this.inputController.swipe(
      this.clamp01(x1),
      this.clamp01(y1),
      this.clamp01(x2),
      this.clamp01(y2),
      durationMs
    );
  }

  private async handleGesture(
    points: Array<{x: number; y: number; duration: number}>
  ): Promise<void> {
    if (!this.currentDeviceId || !this.inputController) {
      Logger.warn('Cannot send gesture: no device selected');
      return;
    }
    if (!points || points.length === 0) {
      Logger.warn('Gesture ignored: no points provided');
      return;
    }
    const clamped = points.map((p) => ({
      x: this.clamp01(p.x),
      y: this.clamp01(p.y),
      duration: p.duration,
    }));
    await this.inputController.gesture(clamped);
  }

  private async handleLongPress(
    x: number,
    y: number,
    durationMs?: number
  ): Promise<void> {
    if (!this.currentDeviceId || !this.inputController) {
      Logger.warn('Cannot long-press: no device selected');
      return;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      Logger.warn(
        `Long press ignored due to invalid coordinates: x=${x}, y=${y}`
      );
      return;
    }
    const config = vscode.workspace.getConfiguration('secondarySimulator');
    const defaultDuration = config.get<number>('longPressDuration', 600);
    const duration =
      typeof durationMs === 'number' && Number.isFinite(durationMs)
        ? Math.max(200, Math.min(durationMs, 2000))
        : defaultDuration;
    await this.inputController.longPress(
      this.clamp01(x),
      this.clamp01(y),
      duration
    );
  }

  private async handleDoubleTap(x: number, y: number): Promise<void> {
    if (!this.currentDeviceId || !this.inputController) {
      Logger.warn('Cannot double-tap: no device selected');
      return;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      Logger.warn(
        `Double tap ignored due to invalid coordinates: x=${x}, y=${y}`
      );
      return;
    }
    await this.inputController.doubleTap(this.clamp01(x), this.clamp01(y));
  }

  private async handleKeypress(key: string, special?: boolean): Promise<void> {
    if (!this.currentDeviceId || !this.inputController) {
      Logger.warn('Cannot send key: no device selected');
      return;
    }
    await this.inputController.keypress(key, special);
  }

  async pressHome(): Promise<void> {
    if (!this.currentDeviceId || !this.inputController) {
      Logger.warn('Cannot press home: no device selected');
      return;
    }
    await this.inputController.home();
  }

  async pressBack(): Promise<void> {
    if (!this.currentDeviceId || !this.inputController) {
      Logger.warn('Cannot press back: no device selected');
      return;
    }
    await this.inputController.back();
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
    if (this.inputController) {
      this.inputController.dispose();
      this.inputController = null;
    }
  }

  /** 同梱の simhid-server バイナリのパス。存在しなければ WDA フォールバックになる。 */
  private resolveSidecarPath(): string {
    return vscode.Uri.joinPath(
      this.extensionUri,
      'native',
      'simhid-server'
    ).fsPath;
  }

  private disconnect(): void {
    this.stopCapture();
    this.currentDeviceId = null;
    this.postMessage({type: 'disconnected'});
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
    // イベントリスナーのクリーンアップ（メモリリーク防止）
    this.messageDisposable?.dispose();
    this.disposeDisposable?.dispose();
    this.visibilityDisposable?.dispose();
    this.messageDisposable = undefined;
    this.disposeDisposable = undefined;
    this.visibilityDisposable = undefined;

    this.stopCapture();
    this.mobileCliServer.stopServer();
    this.view = undefined;
    this.currentDeviceId = null;
    this.devices = [];
    this.screenSize = null;
    this.mobileCliClient = null;
  }
}
