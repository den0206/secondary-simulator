import {randomUUID} from 'node:crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';
import {CaptureStrategy} from '../capture/CaptureStrategy';
import {MjpegCapture} from '../capture/MjpegCapture';
import {MjpegProxy} from '../capture/MjpegProxy';
import {WdaSettings} from '../capture/WdaSettings';
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
  private mobileCliServer: MobileCliServer;
  private mobileCliClient: MobileCliClient | null = null;
  private mjpegProxy: MjpegProxy | null = null;
  private static readonly PROXY_BASE_PORT = 12200;
  private inputController: SimulatorInputController | null = null;
  private currentDeviceId: string | null = null;
  private devices: Device[] = [];
  private screenSize: {width: number; height: number} | null = null;
  private messageDisposable?: vscode.Disposable;
  private disposeDisposable?: vscode.Disposable;
  private visibilityDisposable?: vscode.Disposable;

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
    // mobilecliサーバーを初期化（必須）
    this.mobileCliServer = new MobileCliServer();
  }

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.view = webviewView;

    // 直結ストリーム有効時は、CSP と portMapping に含めるためプロキシを先に起動する
    let portMapping: vscode.WebviewPortMapping[] | undefined;
    if (this.isDirectStreamEnabled()) {
      try {
        const proxyPort = await this.ensureProxy();
        portMapping = [{webviewPort: proxyPort, extensionHostPort: proxyPort}];
      } catch (e) {
        Logger.warn(
          `直結ストリームのプロキシ起動に失敗、canvas 経路にフォールバック: ${
            (e as Error).message
          }`
        );
      }
    }

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
      portMapping,
    };

    webviewView.webview.html = this.getHtmlContent(
      webviewView.webview,
      this.mjpegProxy?.getPort()
    );

    // イベントリスナーを保持して、dispose時にクリーンアップできるようにする
    this.messageDisposable = webviewView.webview.onDidReceiveMessage(
      this.handleMessage.bind(this),
      undefined,
      []
    );

    this.disposeDisposable = webviewView.onDidDispose(() => {
      this.stopCapture();
    });

    this.visibilityDisposable = webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        // 再表示時にキャプチャを再開する（以前は止めたままだった）
        if (this.currentDeviceId) {
          const device = this.devices.find((d) => d.id === this.currentDeviceId);
          if (device) {
            void this.startCaptureForDevice(this.currentDeviceId, device).catch(
              (e) => Logger.error('Failed to resume capture', e as Error)
            );
          }
        }
      } else {
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

        // Phase 1: 生ポインタイベント。タップ/スワイプ/ロングプレスの判定は端末に委ねる。
        case 'touchDown':
        case 'touch2Down':
          await this.handleTouch('down', message);
          break;
        case 'touchMove':
        case 'touch2Move':
          await this.handleTouch('move', message);
          break;
        case 'touchUp':
        case 'touch2Up':
          await this.handleTouch('up', message);
          break;

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

  private isDirectStreamEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('secondarySimulator')
      .get<boolean>('directStream', false);
  }

  // MJPEG 直結プロキシを起動して使用ポートを返す（未起動なら起動）
  private async ensureProxy(): Promise<number> {
    if (this.mjpegProxy?.isRunning()) return this.mjpegProxy.getPort();
    await this.mobileCliServer.launchServer();
    this.mjpegProxy = new MjpegProxy(this.mobileCliServer.getServerPort());
    const port = await this.mjpegProxy.start(
      SimulatorWebviewProvider.PROXY_BASE_PORT
    );
    if (this.view) {
      this.view.webview.options = {
        ...this.view.webview.options,
        portMapping: [{webviewPort: port, extensionHostPort: port}],
      };
    }
    return port;
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
    // init 完了まで this.inputController に載せない（未初期化の primary へ触ると落ちる）
    if (this.mobileCliClient) {
      this.inputController?.dispose();
      this.inputController = null;
      const controller = new SimulatorInputController({
        deviceId,
        platform: device.platform,
        // type 不明は実機扱い → HID を選ばない
        type: device.type ?? 'real',
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
        await controller.init();
      } catch (error) {
        Logger.warn(
          `入力コントローラの初期化に失敗: ${(error as Error).message}`
        );
      }
      this.inputController = controller;
    }

    // 直結ストリーム（Phase 2）: フレームは webview の <img> が直接受ける
    if (this.isDirectStreamEnabled()) {
      try {
        const proxyPort = await this.ensureProxy();
        const url = `http://localhost:${proxyPort}/stream?device=${encodeURIComponent(
          deviceId
        )}`;
        this.postMessage({type: 'streamUrl', url});
        Logger.info(`Started direct MJPEG stream for device: ${device.name}`);

        // iOS: 帯域削減のため WDA の MJPEG 設定を調整（best-effort、WDA 起動後に適用）
        if (device.platform === 'ios') {
          const cfg = vscode.workspace.getConfiguration('secondarySimulator');
          const scale = cfg.get<number>('streamScale', 1);
          const quality = cfg.get<number>('streamQuality', 80);
          if (scale < 1 || quality < 100) {
            setTimeout(() => void WdaSettings.apply(scale, quality), 1500);
          }
        }
        return;
      } catch (error) {
        Logger.warn(
          `直結ストリーム開始に失敗、canvas 経路へフォールバック: ${
            (error as Error).message
          }`
        );
      }
    }

    // MJPEGストリーミング（canvas 経路）
    await this.createCaptureInstance();
    if (!this.currentCapture) {
      throw new Error('Failed to create capture instance');
    }

    this.currentCapture.setDevice(deviceId);
    this.currentCapture.onFrame((frame) => {
      this.postMessage({type: 'frame', data: frame});
    });

    try {
      await this.currentCapture.start();
      Logger.info(`Started MJPEG streaming for device: ${device.name}`);
    } catch (error) {
      Logger.error('Failed to start capture', error as Error);
      this.sendError((error as Error).message || 'Failed to start capture');
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

  private clamp01(value: number): number {
    if (Number.isNaN(value)) {
      return 0.5;
    }
    return Math.min(1, Math.max(0, value));
  }

  /**
   * 生ポインタイベントを処理する（Phase 1）。webview から届く down/move/up をそのまま
   * バックエンドへ流す。2本指のときは x2/y2 を伴う。座標は正規化 [0,1]。
   */
  private async handleTouch(
    phase: 'down' | 'move' | 'up',
    message: {[key: string]: unknown}
  ): Promise<void> {
    if (!this.currentDeviceId || !this.inputController) return;
    const x = message.x as number;
    const y = message.y as number;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const cx = this.clamp01(x);
    const cy = this.clamp01(y);

    const hasSecond =
      Number.isFinite(message.x2 as number) &&
      Number.isFinite(message.y2 as number);

    if (hasSecond) {
      const cx2 = this.clamp01(message.x2 as number);
      const cy2 = this.clamp01(message.y2 as number);
      if (phase === 'down') await this.inputController.touch2Down(cx, cy, cx2, cy2);
      else if (phase === 'move') await this.inputController.touch2Move(cx, cy, cx2, cy2);
      else await this.inputController.touch2Up(cx, cy, cx2, cy2);
      return;
    }

    if (phase === 'down') await this.inputController.touchDown(cx, cy);
    else if (phase === 'move') await this.inputController.touchMove(cx, cy);
    else await this.inputController.touchUp(cx, cy);
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
    if (this.inputController) {
      this.inputController.dispose();
      this.inputController = null;
    }
    // 直結 <img> の GET を閉じ、非表示中も MJPEG を流し続けない
    this.postMessage({type: 'pauseStream'});
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

  private getHtmlContent(webview: vscode.Webview, proxyPort?: number): string {
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
    // 直結ストリームは preferredPort から最大 20 ポートを試すため、範囲を CSP に含める
    // （HTML 生成後にプロキシが別ポートで起動しても img-src で止まらないようにする）
    const base = SimulatorWebviewProvider.PROXY_BASE_PORT;
    const proxyOrigins = Array.from(
      {length: MjpegProxy.MAX_PORT_TRIES},
      (_, i) => ` http://localhost:${base + i}`
    ).join('');
    const extra = proxyPort
      ? ` http://localhost:${proxyPort}`
      : this.isDirectStreamEnabled()
        ? proxyOrigins
        : '';
    const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:${extra}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">`;

    const html = fs.readFileSync(htmlPath.fsPath, 'utf8');
    return html
      .replace('{{scriptUri}}', scriptUri.toString())
      .replace('{{styleUri}}', styleUri.toString())
      .replace('{{nonce}}', nonce)
      .replace('{{cspMeta}}', cspMeta);
  }

  private getNonce(): string {
    return randomUUID().replace(/-/g, '');
  }

  onConfigurationChanged(): void {
    if (this.currentCapture) {
      this.currentCapture.updateConfig();
    }
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
    this.mjpegProxy?.dispose();
    this.mjpegProxy = null;
    this.mobileCliServer.stopServer();
    this.view = undefined;
    this.currentDeviceId = null;
    this.devices = [];
    this.screenSize = null;
    this.mobileCliClient = null;
  }
}
