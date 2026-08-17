import {randomUUID} from 'node:crypto';
import * as os from 'node:os';
import * as fs from 'fs';
import * as vscode from 'vscode';
import {CaptureStrategy} from '../capture/CaptureStrategy';
import {MjpegCapture} from '../capture/MjpegCapture';
import {MjpegProxy} from '../capture/MjpegProxy';
import {
  DecodedScreenshot,
  decodeScreenshotResult,
  defaultScreenshotName,
} from '../capture/Screenshot';
import {SidecarCapture} from '../capture/SidecarCapture';
import {WdaSettings} from '../capture/WdaSettings';
import {SimulatorInputController} from '../input/SimulatorInputController';
import {pickAutoConnectDevice} from '../simulator/autoConnect';
import {Device, DeviceType} from '../simulator/types';
import {JsonRpcClient} from '../utils/JsonRpcClient';
import {Logger} from '../utils/Logger';
import {MobileCliClient} from '../utils/MobileCliClient';
import {MobileCliServer} from '../utils/MobileCliServer';
import {collectResourceStats} from '../utils/ResourceStats';

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
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly STATS_INTERVAL_MS = 30_000;
  // 未接続のあいだだけ回すデバイス探索。接続したら止める。
  private autoConnectTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly AUTO_CONNECT_INTERVAL_MS = 5_000;
  /** 直近に webview へ送ったデバイス一覧の署名。同じなら送らない（5秒ごとの再描画を避ける） */
  private lastDevicesSignature = '';

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
    // ビューが作り直される（別コンテナへ移動など）と再度呼ばれる。前回のリスナーを外す。
    this.disposeListeners();
    this.view = webviewView;

    // 直結ストリーム有効時は、CSP と portMapping に含めるためプロキシを先に起動する
    let portMapping: vscode.WebviewPortMapping[] | undefined;
    if (this.isDirectStreamEnabled()) {
      try {
        const proxyPort = (await this.ensureProxy()).getPort();
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
      this.stopStatsTimer();
      this.stopAutoConnectTimer();
      // 破棄されたビューを持ち続けない（webview の内容ごと参照が残る）。
      // 差し替えで resolveWebviewView が先に走っている場合は新しい方を消さない。
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });

    this.visibilityDisposable = webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.startStatsTimer();
        // 再表示時にキャプチャを再開する（以前は止めたままだった）
        if (this.currentDeviceId) {
          const device = this.devices.find((d) => d.id === this.currentDeviceId);
          if (device) {
            void this.startCaptureForDevice(this.currentDeviceId, device).catch(
              (e) => Logger.error('Failed to resume capture', e as Error)
            );
          }
        } else if (this.isAutoConnectEnabled()) {
          // タイマー開始を待たず、再表示の直後に探す
          void this.refreshDevices();
        }
      } else {
        this.stopCapture();
        this.stopStatsTimer();
      }
      this.syncAutoConnectTimer();
    });

    this.startStatsTimer();
    // HTML を作り直したので、一覧が同じでも webview へ送り直す
    this.lastDevicesSignature = '';
    this.refreshDevices();
  }

  // ---- リソース監視（30秒ごと）------------------------------------------------

  private startStatsTimer(): void {
    if (this.statsTimer) return;
    void this.reportStats();
    this.statsTimer = setInterval(
      () => void this.reportStats(),
      SimulatorWebviewProvider.STATS_INTERVAL_MS
    );
  }

  private stopStatsTimer(): void {
    if (!this.statsTimer) return;
    clearInterval(this.statsTimer);
    this.statsTimer = null;
  }

  // ---- 自動接続（未接続のあいだだけ 5 秒ごとに探す）----------------------------

  private isAutoConnectEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('secondarySimulator')
      .get<boolean>('autoConnect', true);
  }

  private postAutoConnectState(): void {
    this.postMessage({
      type: 'autoConnect',
      enabled: this.isAutoConnectEnabled(),
    });
  }

  /** 起動中のデバイスがあれば繋ぐ。Auto が OFF なら繋がない。 */
  private async autoConnect(): Promise<void> {
    const device = pickAutoConnectDevice(this.devices, {
      enabled: this.isAutoConnectEnabled(),
      currentDeviceId: this.currentDeviceId,
    });
    if (!device) return;
    Logger.info(`自動接続: ${device.name}`);
    this.postMessage({type: 'selectedDevice', deviceId: device.id});
    await this.startCaptureForDevice(device.id, device);
  }

  /** 未接続かつ表示中のときだけタイマーを回す。条件が崩れたら止める。 */
  private syncAutoConnectTimer(): void {
    const wanted =
      this.view?.visible === true &&
      !this.currentDeviceId &&
      this.isAutoConnectEnabled();
    if (wanted === !!this.autoConnectTimer) return;
    if (wanted) {
      this.autoConnectTimer = setInterval(
        () => void this.refreshDevices(),
        SimulatorWebviewProvider.AUTO_CONNECT_INTERVAL_MS
      );
      this.postMessage({type: 'searching', active: true});
    } else {
      this.stopAutoConnectTimer();
      // 繋がって止まったときは「Connecting…」を消さない。探すのをやめた場合だけ戻す。
      if (!this.currentDeviceId) {
        this.postMessage({type: 'searching', active: false});
      }
    }
  }

  private stopAutoConnectTimer(): void {
    if (!this.autoConnectTimer) return;
    clearInterval(this.autoConnectTimer);
    this.autoConnectTimer = null;
  }

  private async reportStats(): Promise<void> {
    if (!this.view) return;
    const pids = [
      this.mobileCliServer.getPid(),
      this.inputController?.sidecarPid,
    ].filter((p): p is number => typeof p === 'number');
    try {
      const stats = await collectResourceStats(this.extensionUri.fsPath, pids);
      this.postMessage({type: 'resources', ...stats});
    } catch (error) {
      Logger.warn(`リソース統計の取得に失敗: ${(error as Error).message}`);
    }
  }

  private async handleMessage(message: {
    type: string;
    [key: string]: unknown;
  }): Promise<void> {
    // touch* はドラッグ中 60Hz で届く。ログに流すと出力チャンネルが際限なく膨らむ。
    if (!message.type.startsWith('touch')) {
      Logger.debug(`Received message: ${message.type}`);
    }

    try {
      switch (message.type) {
        case 'init':
        case 'refresh':
          this.postAutoConnectState();
          await this.refreshDevices();
          break;

        case 'setAutoConnect':
          // 設定へ書き戻す。onDidChangeConfiguration 経由でタイマーと UI が揃う。
          await vscode.workspace
            .getConfiguration('secondarySimulator')
            .update(
              'autoConnect',
              message.enabled as boolean,
              vscode.ConfigurationTarget.Global
            );
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
          await this.disconnect();
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

  // MJPEG 直結プロキシを起動して返す（未起動なら起動）
  private async ensureProxy(): Promise<MjpegProxy> {
    if (this.mjpegProxy?.isRunning()) return this.mjpegProxy;
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
    return this.mjpegProxy;
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
        this.syncAutoConnectTimer();
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
      // 5秒ごとのポーリングで毎回送ると webview の <select> が作り直される。差分だけ送る。
      const signature = this.devices.map((d) => `${d.id}:${d.state}`).join(',');
      if (signature !== this.lastDevicesSignature) {
        this.lastDevicesSignature = signature;
        this.postMessage({type: 'devices', devices: this.devices});
        this.postMessage({
          type: 'status',
          text: `${this.devices.length} devices found`,
        });
      }
      await this.autoConnect();
    } catch (error) {
      Logger.error('Failed to list devices via mobilecli', error as Error);
      this.sendError(`Failed to list devices: ${(error as Error).message}`);
      this.devices = [];
      this.lastDevicesSignature = '';
      this.postMessage({type: 'devices', devices: []});
    }
    this.syncAutoConnectTimer();
  }

  async selectDevice(deviceId: string): Promise<void> {
    if (!deviceId) {
      // 選択中のデバイスが一覧から消えたとき。明示的な切断ではないので自動接続は残す。
      this.stopCapture();
      this.currentDeviceId = null;
      this.syncAutoConnectTimer();
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
    this.syncAutoConnectTimer();
  }

  private async startCaptureForDevice(
    deviceId: string,
    device: Device
  ): Promise<void> {
    this.stopCapture();

    // WDA 起動待ちで最初のフレームまで数秒かかる。待たせている理由を出す。
    this.postMessage({type: 'connecting', name: device.name});
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
        // 設定を毎回読む（切り替えに再接続を要らなくする）
        preferWdaKeys: () =>
          vscode.workspace
            .getConfiguration('secondarySimulator')
            .get<string>('keyInput', 'hid') === 'wda',
        onBackendChange: (kind) => {
          this.postMessage({
            type: 'status',
            text: kind === 'hid' ? '高速モード (HID)' : '互換モード (WDA)',
          });
          // HID が死ぬとサイドカー取り込みも止まる。映像だけ WDA へ切り替える。
          // startCaptureForDevice は呼ぶな — コントローラを作り直して HID を再試行し、
          // fatal が続くと spawn ループになる。
          if (kind === 'wda' && this.currentCapture instanceof SidecarCapture) {
            Logger.warn('サイドカー取り込みを終了し WDA 経路へ切り替える');
            void this.fallbackSidecarCaptureToWda(deviceId, device);
          }
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

    await this.startDisplayForDevice(deviceId, device);
  }

  /**
   * HID 降格後に映像だけ WDA へ付け替える。入力コントローラは触らない
   * （dispose → 再 init すると HID を再試行して fatal ループになる）。
   */
  private async fallbackSidecarCaptureToWda(
    deviceId: string,
    device: Device
  ): Promise<void> {
    if (!(this.currentCapture instanceof SidecarCapture)) return;
    this.currentCapture.dispose();
    this.currentCapture = null;
    await this.startDisplayForDevice(deviceId, device);
  }

  /** 直結 MJPEG または canvas キャプチャを開始する（入力コントローラは前提として用意済み）。 */
  private async startDisplayForDevice(
    deviceId: string,
    device: Device
  ): Promise<void> {
    // 直結ストリーム（Phase 2）: フレームは webview の <img> が直接受ける。
    // サイドカー取り込みが使えるときは、そちらが優先（WDA 経路にはキーボードが写らない）
    if (this.isDirectStreamEnabled() && !this.sidecarCaptureAvailable()) {
      try {
        const proxy = await this.ensureProxy();
        const url = proxy.streamUrl(deviceId);
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
      // base64 の文字列で渡す。Uint8Array のまま postMessage すると、シリアライザ次第で
      // `{"0":255,"1":216,...}` や `{type:'Buffer',data:[...]}` に化けて数倍に膨らむ
      // （webview 側が 3 通りの形を推測していたのはこのため）。
      this.postMessage({
        type: 'frame',
        encoding: 'base64',
        data: Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength).toString('base64'),
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

  /**
   * サイドカーの画面取り込みを使えるか。
   * HID 経路が生きている iOS Simulator のときだけ（設定で WDA に固定できる）。
   */
  private sidecarCaptureAvailable(): boolean {
    if (!this.inputController?.activeSidecar) return false;
    return (
      vscode.workspace
        .getConfiguration('secondarySimulator')
        .get<string>('captureSource', 'auto') !== 'wda'
    );
  }

  private async createCaptureInstance(): Promise<void> {
    // フレームバッファ直取り。WDA 経路と違いソフトウェアキーボードも写る
    const sidecar = this.sidecarCaptureAvailable()
      ? this.inputController?.activeSidecar
      : null;
    if (sidecar) {
      this.currentCapture = new SidecarCapture(sidecar, () => {
        const cfg = vscode.workspace.getConfiguration('secondarySimulator');
        return {
          fps: cfg.get<number>('captureFps', 30),
          maxWidth: cfg.get<number>('captureMaxWidth', 640),
          // streamQuality は 1-100、サイドカーは 0.1-1.0
          quality: cfg.get<number>('streamQuality', 80) / 100,
        };
      });
      Logger.info('Using sidecar framebuffer capture');
      return;
    }

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

  /** コマンド側（QuickPick）から見える一覧。参照だけ返す。 */
  getDevices(): readonly Device[] {
    return this.devices;
  }

  getCurrentDeviceId(): string | null {
    return this.currentDeviceId;
  }

  /**
   * 接続中のデバイスの画面を 1 枚取り、保存先を尋ねて書き出す。
   * 保存先はユーザーが選ぶので、拡張が勝手に永続ストレージを持つことにはならない。
   */
  async saveScreenshot(): Promise<void> {
    const deviceId = this.currentDeviceId;
    if (!deviceId || !this.mobileCliClient) {
      void vscode.window.showWarningMessage(
        'Secondary Simulator: デバイスに接続してからスクリーンショットを撮ってください。'
      );
      return;
    }
    const device = this.devices.find((d) => d.id === deviceId);
    const deviceName = device?.name ?? 'device';

    let shot: DecodedScreenshot;
    try {
      const result = await this.mobileCliClient.screenshot(deviceId, 'png');
      shot = decodeScreenshotResult(result, 'png');
    } catch (error) {
      Logger.error('スクリーンショットの取得に失敗', error as Error);
      void vscode.window.showErrorMessage(
        `Secondary Simulator: スクリーンショットを取得できませんでした — ${
          (error as Error).message
        }`
      );
      return;
    }

    const target = await vscode.window.showSaveDialog({
      title: 'スクリーンショットの保存先',
      defaultUri: vscode.Uri.joinPath(
        this.defaultScreenshotDir(),
        defaultScreenshotName(deviceName, shot.ext)
      ),
      filters: {画像: [shot.ext]},
    });
    if (!target) return; // キャンセル

    try {
      await vscode.workspace.fs.writeFile(target, shot.bytes);
    } catch (error) {
      Logger.error('スクリーンショットの保存に失敗', error as Error);
      void vscode.window.showErrorMessage(
        `Secondary Simulator: 保存できませんでした — ${(error as Error).message}`
      );
      return;
    }

    Logger.info(`スクリーンショットを保存: ${target.fsPath}`);
    const open = await vscode.window.showInformationMessage(
      `スクリーンショットを保存しました: ${target.fsPath}`,
      '開く'
    );
    if (open === '開く') {
      await vscode.commands.executeCommand('vscode.open', target);
    }
  }

  /** 保存ダイアログの初期位置。ワークスペースがあればその直下、無ければホーム。 */
  private defaultScreenshotDir(): vscode.Uri {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? folder.uri : vscode.Uri.file(os.homedir());
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

  private async disconnect(): Promise<void> {
    this.stopCapture();
    this.currentDeviceId = null;
    this.postMessage({type: 'disconnected'});
    Logger.info('Device disconnected');
    // 押した直後に繋ぎ直さないよう自動接続を切る。表示（Auto スイッチ）も OFF に揃う。
    await vscode.workspace
      .getConfiguration('secondarySimulator')
      .update('autoConnect', false, vscode.ConfigurationTarget.Global);
    this.syncAutoConnectTimer();
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
    // autoConnect の切り替えを即座に反映する（ON に戻したらその場で探しに行く）
    this.postAutoConnectState();
    this.syncAutoConnectTimer();
    if (this.isAutoConnectEnabled() && !this.currentDeviceId) {
      void this.autoConnect();
    }
  }

  /** イベントリスナーのクリーンアップ（メモリリーク防止） */
  private disposeListeners(): void {
    this.messageDisposable?.dispose();
    this.disposeDisposable?.dispose();
    this.visibilityDisposable?.dispose();
    this.messageDisposable = undefined;
    this.disposeDisposable = undefined;
    this.visibilityDisposable = undefined;
  }

  dispose(): void {
    this.disposeListeners();
    this.stopStatsTimer();
    this.stopAutoConnectTimer();
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
