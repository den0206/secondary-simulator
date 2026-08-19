import {randomUUID} from 'node:crypto';
import * as os from 'node:os';
import * as fs from 'fs';
import * as vscode from 'vscode';
import {captureConfigAction, captureRate} from '../capture/CaptureStats';
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
import {defaultRecordingName} from '../simulator/RecordingName';
import {Device, DeviceType} from '../simulator/types';
import {DeviceStatus, renderStatus} from '../ui/DeviceStatusBar';
import {JsonRpcClient} from '../utils/JsonRpcClient';
import {Logger} from '../utils/Logger';
import {MobileCliClient} from '../utils/MobileCliClient';
import {MobileCliServer} from '../utils/MobileCliServer';
import {collectResourceStats} from '../utils/ResourceStats';
import {statusStrings, webviewStrings} from '../utils/Strings';

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
  /**
   * 受け取ったフレームの数とバイト数。`reportStats` が読んで 0 に戻す
   * （増える一方の入れ物にしない）。取り込みが効いているかを見る唯一の手段。
   * これが無いと同期の改善を評価できない。
   * 数える以上のことはしない — フレームは高頻度パスなので。
   */
  private frameCount = 0;
  private frameBytes = 0;
  private lastStatsAtMs = Date.now();
  /**
   * 直結表示中か。フレームが拡張ホストを通らないので、**受信 fps と帯域は測れない**。
   * 測れないものを 0 と出すと「止まっている」と誤解されるため、webview 側へ伝えて
   * 描画 fps だけを出させる。
   */
  private directStreaming = false;
  /** 非表示のまま残した入力コントローラを解放するまでの猶予。 */
  private inputReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly INPUT_RELEASE_MS = 120_000;
  // 未接続のあいだだけ回すデバイス探索。接続したら止める。
  private autoConnectTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly AUTO_CONNECT_INTERVAL_MS = 5_000;
  // device.boot 後に Booted を待つ上限（2 秒 × 45 = 90 秒）
  private static readonly BOOT_POLL_TRIES = 45;
  private static readonly BOOT_POLL_INTERVAL_MS = 2_000;
  /** 直近に webview へ送ったデバイス一覧の署名。同じなら送らない（5秒ごとの再描画を避ける） */
  private lastDevicesSignature = '';
  /** ステータスバーへ流す接続状態。webview を作り直したときの再送にも使う。 */
  private status: DeviceStatus = {state: 'disconnected'};
  /**
   * `bootAndConnect` が対象 UDID の Booted を待っているあいだだけセットする。
   * この間 `refreshDevices` → `autoConnect` が別の起動済み端末へ先に繋ぐのを防ぐ。
   */
  private bootWaitDeviceId: string | null = null;
  /**
   * 録画中のセッション。**増える一方の入れ物にしない**ため、
   * 保持するのは「どの端末を、どこへ書いているか」の 1 件だけ。
   */
  private recording: {deviceId: string; target: vscode.Uri} | null = null;
  /**
   * 止め忘れの保険。CLAUDE.md「上限と破棄条件をセットで書く」に従い、
   * 録画は必ず時間で終わる（切断・破棄でも止める）。
   */
  private recordingTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly MAX_RECORDING_MS = 10 * 60_000;
  /**
   * 開始／停止の RPC が飛んでいる最中か。停止は端末からの引き上げがあり数秒かかるので、
   * その間にもう一度押されると**止め終える前に新しい録画を始めて**しまう。
   */
  private recordingBusy = false;
  /** 1 回の貼り付けで受ける文字数の上限（HID は 1 文字ずつ送るため）。 */
  private static readonly MAX_PASTE_CHARS = 4096;

  /**
   * @param onStatusChange ステータスバーの更新先。webview の外に出す唯一の状態。
   */
  constructor(
    extensionUri: vscode.Uri,
    private readonly onStatusChange?: (status: DeviceStatus) => void
  ) {
    this.extensionUri = extensionUri;
    // mobilecliサーバーを初期化（必須）
    this.mobileCliServer = new MobileCliServer();
  }

  /** 接続状態を 1 か所で更新する（ステータスバーと webview のフッターが揃う）。 */
  private setStatus(status: DeviceStatus): void {
    this.status = status;
    this.onStatusChange?.(status);
    this.postMessage({
      type: 'mode',
      text: renderStatus(status, statusStrings()).mode,
    });
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

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

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
        // 表示だけ止め、入力（サイドカープロセスと HID クライアント）は残す。
        // タブを行き来するたびに作り直すと ready 待ちのぶん復帰が遅い。
        // ただし畳んだまま放置される場合があるので、時間で解放する。
        this.stopCapture({keepInput: true});
        this.armInputRelease();
        this.stopStatsTimer();
      }
      this.syncAutoConnectTimer();
    });

    this.startStatsTimer();
    // HTML を作り直したので、一覧が同じでも webview へ送り直す
    this.lastDevicesSignature = '';
    this.postSettings();
    this.postMessage({
      type: 'mode',
      text: renderStatus(this.status, statusStrings()).mode,
    });
    // 作り直しても録画は続いている。表示だけ復元する
    if (this.recording) this.postMessage({type: 'recording', active: true});
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
    // boot 待ち中は対象 UDID 以外へ繋がない（別の Booted 端末への横取り防止）
    if (this.bootWaitDeviceId) return;
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
    // 計測値は取得の成否に関わらず、この tick で必ず 0 に戻す（次の期間と混ぜない）
    const now = Date.now();
    const rate = captureRate(
      this.frameCount,
      this.frameBytes,
      now - this.lastStatsAtMs
    );
    this.frameCount = 0;
    this.frameBytes = 0;
    this.lastStatsAtMs = now;

    const pids = [
      this.mobileCliServer.getPid(),
      this.inputController?.sidecarPid,
      this.inputController?.adbTouchPid,
    ].filter((p): p is number => typeof p === 'number');
    try {
      const stats = await collectResourceStats(this.extensionUri.fsPath, pids);
      // 直結中はフレームを見ていないので、受信側の数字を出さない（0 と嘘をつかない）
      this.postMessage(
        this.directStreaming
          ? {type: 'resources', ...stats, direct: true}
          : {type: 'resources', ...stats, ...rate}
      );
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
          this.postSettings();
          await this.refreshDevices();
          break;

        // エラー表示からの復帰。一覧を取り直し、選択中があれば繋ぎ直す。
        case 'retry':
          this.postSettings();
          await this.refreshDevices();
          if (this.currentDeviceId) {
            const device = this.devices.find(
              (d) => d.id === this.currentDeviceId
            );
            if (device) {
              await this.startCaptureForDevice(this.currentDeviceId, device);
            }
          }
          break;

        case 'showLogs':
          Logger.show();
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

        // 停止中のデバイスを選んだとき。コマンドパレット側と同じ確認を出して起動する
        // （以前は webview からだけ「起動していません」で終わっていた）。
        case 'bootDevice':
          await this.confirmAndBoot(message.deviceId as string);
          break;

        case 'record':
          await this.toggleRecording();
          break;

        // クリップボードの貼り付け。1 文字ずつのキー送出では URL 入力が現実的でない。
        case 'paste':
          await this.pasteText(message.text as string);
          break;

        // 表示中の実ピクセル幅。サイドバーの幅に合わせて取り込みの幅を決める。
        case 'viewport':
          if (this.currentCapture instanceof SidecarCapture) {
            this.currentCapture.setViewportWidth(message.width as number);
          }
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
            message.special as boolean,
            message.modifiers as string[] | undefined
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

        case 'screenshot':
          await this.saveScreenshot();
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

  /**
   * サイドカーの配信ポートを webview から見えるようにする。
   *
   * `portMapping` はリモート開発（Remote SSH / Codespaces）で localhost 直結を
   * 成立させるために要る。http のみ対応なので、直結を WebSocket ではなく
   * multipart にしてある（`docs/sidecar-protocol.md` §3.6）。
   */
  private allowStreamPort(port: number): void {
    if (!port || !this.view) return;
    const current = this.view.webview.options.portMapping ?? [];
    if (current.some((m) => m.webviewPort === port)) return;
    this.view.webview.options = {
      ...this.view.webview.options,
      portMapping: [...current, {webviewPort: port, extensionHostPort: port}],
    };
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
      this.setStatus({state: 'disconnected'});
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
    // 同じデバイスへ繋ぎ直すなら入力はそのまま使う（再表示・設定変更で作り直さない）。
    // 判定は currentDeviceId を書き換える前に行う。
    const reuseInput =
      this.inputController !== null && this.currentDeviceId === deviceId;
    this.stopCapture({keepInput: reuseInput});
    this.clearInputReleaseTimer();

    // 別の端末へ移るなら、録画中の端末から離れるなら止める（別端末を録り続けることにならない）
    if (this.recording && this.recording.deviceId !== deviceId) {
      await this.stopRecording();
    }

    // WDA 起動待ちで最初のフレームまで数秒かかる。待たせている理由を出す。
    this.postMessage({type: 'connecting', name: device.name});
    this.setStatus({state: 'connecting', name: device.name});
    this.currentDeviceId = deviceId;

    if (reuseInput) {
      // 画面サイズも取得済み。device.info の往復（実測 280ms）を省く。
      this.setStatus({
        state: 'connected',
        name: device.name,
        backend: this.inputController!.backendKind,
      });
      await this.startDisplayForDevice(deviceId, device);
      return;
    }

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
          this.setStatus({state: 'connected', name: device.name, backend: kind});
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
      // init が onBackendChange を呼べずに終わっても「接続中」で止めない
      this.setStatus({
        state: 'connected',
        name: device.name,
        backend: controller.backendKind,
      });
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
    // 直結ストリーム: フレームは webview の <img> が直接受ける。
    // サイドカー取り込みのときはサイドカー自身が配信するので、この分岐は
    // WDA/mobilecli 経路（MjpegProxy）専用。取り込み元と転送は独立に選べる。
    if (this.isDirectStreamEnabled() && !this.sidecarCaptureAvailable()) {
      try {
        const proxy = await this.ensureProxy();
        const url = proxy.streamUrl(deviceId);
        this.directStreaming = true;
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

    // サイドカーの直結配信。フレームは拡張ホストを通らないので onFrame は呼ばれない。
    // 張り直しでポートが変わることがあるため、開始のたびに URL を送り直す。
    if (this.currentCapture instanceof SidecarCapture) {
      this.currentCapture.onStreamChange = (url) => {
        if (!url) return;
        this.allowStreamPort(
          this.currentCapture instanceof SidecarCapture ? this.currentCapture.port : 0
        );
        this.directStreaming = true;
        this.postMessage({type: 'streamUrl', url});
      };
    }

    this.currentCapture.onFrame((frameBase64) => {
      // 高頻度パス（毎秒 20〜30 回）。ログも変換も挟まない。
      // base64 の文字列で渡す。Uint8Array のまま postMessage すると、シリアライザ次第で
      // `{"0":255,"1":216,...}` や `{type:'Buffer',data:[...]}` に化けて数倍に膨らむ
      // （webview 側が 3 通りの形を推測していたのはこのため）。
      this.frameCount++;
      this.frameBytes += frameBase64.length;
      this.postMessage({
        type: 'frame',
        encoding: 'base64',
        data: frameBase64,
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
      const cfg = vscode.workspace.getConfiguration('secondarySimulator');
      this.currentCapture = new SidecarCapture(
        sidecar,
        () => {
          const c = vscode.workspace.getConfiguration('secondarySimulator');
          return {
            fps: c.get<number>('captureFps', 30),
            maxWidth: c.get<number>('captureMaxWidth', 640),
            // streamQuality は 1-100、サイドカーは 0.1-1.0
            quality: c.get<number>('streamQuality', 80) / 100,
          };
        },
        {
          // 直結はサイドカー自身が配信する。拡張ホストはフレームに触らない
          sink: this.isDirectStreamEnabled() ? 'http' : 'stdout',
          mode: cfg.get<string>('captureMode', 'auto') === 'poll' ? 'poll' : 'auto',
        }
      );
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

    // 押している間だけ取り込みを速くする。move では呼ばない（60Hz で届くため）。
    if (phase !== 'move' && this.currentCapture instanceof SidecarCapture) {
      this.currentCapture.setInteracting(phase === 'down');
    }
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

  private async handleKeypress(
    key: string,
    special?: boolean,
    modifiers?: string[]
  ): Promise<void> {
    if (!this.currentDeviceId || !this.inputController) {
      Logger.warn('Cannot send key: no device selected');
      return;
    }
    await this.inputController.keypress(key, special, modifiers);
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
   * 停止中のデバイスを起動して接続する。
   *
   * 以前は「起動していません」で終わりだったので、シミュレータを自分で立ち上げて
   * から戻ってくる必要があった（docs/project-review.md §5.4）。
   *
   * `device.boot` の応答は起動要求の受理までしか保証しないため、一覧に `Booted`
   * として現れるまで待つ。無限には待たない。
   */
  async bootAndConnect(deviceId: string): Promise<void> {
    if (!this.mobileCliClient) {
      await this.refreshDevices();
    }
    if (!this.mobileCliClient) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Secondary Simulator: Could not initialize mobilecli.')
      );
      return;
    }
    const name =
      this.devices.find((d) => d.id === deviceId)?.name ?? deviceId;

    // ポーリング中の refreshDevices → autoConnect が別端末へ繋ぐのを止める
    this.bootWaitDeviceId = deviceId;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t('Secondary Simulator: Booting {0}…', name),
          cancellable: false,
        },
        async () => {
          try {
            await this.mobileCliClient!.boot(deviceId);
          } catch (error) {
            Logger.error('デバイスの起動に失敗', error as Error);
            void vscode.window.showErrorMessage(
              vscode.l10n.t(
                'Secondary Simulator: Could not boot {0} — {1}',
                name,
                (error as Error).message
              )
            );
            return;
          }

          // 起動要求が通っても一覧に載るまで間がある。上限付きで待つ。
          for (let i = 0; i < SimulatorWebviewProvider.BOOT_POLL_TRIES; i++) {
            await this.refreshDevices();
            if (
              this.devices.find((d) => d.id === deviceId)?.state === 'Booted'
            ) {
              await this.selectDevice(deviceId);
              return;
            }
            await new Promise((r) =>
              setTimeout(r, SimulatorWebviewProvider.BOOT_POLL_INTERVAL_MS)
            );
          }
          void vscode.window.showWarningMessage(
            vscode.l10n.t(
              'Secondary Simulator: Waited for {0} but it never reached Booted. Refresh the list and pick it again.',
              name
            )
          );
        }
      );
    } finally {
      this.bootWaitDeviceId = null;
    }
  }

  /**
   * 接続中のデバイスでディープリンク／URL を開く。
   * アプリ開発の反復で、シミュレータへ切り替えずに遷移を試せるようにする。
   */
  async openUrl(url: string): Promise<void> {
    const deviceId = this.currentDeviceId;
    if (!deviceId || !this.mobileCliClient) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Secondary Simulator: Connect to a device before opening a URL.'
        )
      );
      return;
    }
    try {
      await this.mobileCliClient.openUrl(deviceId, url);
      Logger.info(`URL を開いた: ${url}`);
    } catch (error) {
      Logger.error('URL を開けなかった', error as Error);
      void vscode.window.showErrorMessage(
        vscode.l10n.t(
          'Secondary Simulator: Could not open the URL — {0}',
          (error as Error).message
        )
      );
    }
  }

  /**
   * 録画の開始・停止をトグルする。
   *
   * 開始前に保存先を尋ね、そのパスを `device.screenrecord` の `output` に渡す
   * （mobilecli が直接そこへ書くので、拡張は一時ファイルを抱えない）。
   * **止め忘れを作らない**ため、上限時間・切断・破棄のいずれでも必ず止める。
   */
  async toggleRecording(): Promise<void> {
    // 連打で二重に開始しない（停止の引き上げは数秒かかる）
    if (this.recordingBusy) {
      Logger.debug('録画の開始/停止が処理中なので無視する');
      return;
    }
    if (this.recording) {
      await this.stopRecording();
      return;
    }

    const deviceId = this.currentDeviceId;
    if (!deviceId || !this.mobileCliClient) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Secondary Simulator: Connect to a device before recording.'
        )
      );
      return;
    }
    const deviceName =
      this.devices.find((d) => d.id === deviceId)?.name ?? 'device';

    const target = await vscode.window.showSaveDialog({
      title: vscode.l10n.t('Save recording to'),
      defaultUri: vscode.Uri.joinPath(
        this.defaultScreenshotDir(),
        defaultRecordingName(deviceName)
      ),
      filters: {[vscode.l10n.t('Videos')]: ['mp4']},
    });
    if (!target) return; // キャンセル

    this.recordingBusy = true;
    try {
      await this.mobileCliClient.startScreenRecord(deviceId, target.fsPath);
    } catch (error) {
      Logger.error('録画を開始できなかった', error as Error);
      void vscode.window.showErrorMessage(
        vscode.l10n.t(
          'Secondary Simulator: Could not start recording — {0}',
          (error as Error).message
        )
      );
      return;
    } finally {
      this.recordingBusy = false;
    }

    this.recording = {deviceId, target};
    Logger.info(`録画を開始: ${target.fsPath}`);
    this.postMessage({type: 'recording', active: true});

    // 上限で必ず終わらせる（押し忘れても増え続けない）
    this.recordingTimer = setTimeout(() => {
      this.recordingTimer = null;
      Logger.warn('録画が上限時間に達したので停止する');
      void this.stopRecording();
    }, SimulatorWebviewProvider.MAX_RECORDING_MS);
    this.recordingTimer.unref?.();
  }

  /**
   * 録画を止めて書き出す。mobilecli 側の停止が成功してからだけ
   * `recording` と UI を戻す — 先に戻すと「止まったように見えるが
   * 端末では録り続けている」状態になる。
   */
  private async stopRecording(): Promise<void> {
    const session = this.recording;
    if (!session) return;

    if (!this.mobileCliClient) {
      this.clearRecordingTimer();
      this.recording = null;
      this.postMessage({type: 'recording', active: false});
      return;
    }
    // 引き上げと変換で数秒かかる。その間に始め直させない
    this.recordingBusy = true;
    try {
      await this.mobileCliClient.stopScreenRecord(session.deviceId);
    } catch (error) {
      Logger.error('録画の停止に失敗', error as Error);
      const retry = vscode.l10n.t('Retry');
      const answer = await vscode.window.showErrorMessage(
        vscode.l10n.t(
          'Secondary Simulator: Could not stop the recording — {0}',
          (error as Error).message
        ),
        retry
      );
      if (answer === retry) {
        this.recordingBusy = false;
        await this.stopRecording();
      }
      return;
    } finally {
      this.recordingBusy = false;
    }

    this.clearRecordingTimer();
    this.recording = null;
    this.postMessage({type: 'recording', active: false});

    Logger.info(`録画を保存: ${session.target.fsPath}`);
    const openLabel = vscode.l10n.t('Open');
    const open = await vscode.window.showInformationMessage(
      vscode.l10n.t('Recording saved: {0}', session.target.fsPath),
      openLabel
    );
    if (open === openLabel) {
      await vscode.commands.executeCommand('vscode.open', session.target);
    }
  }

  private clearRecordingTimer(): void {
    if (!this.recordingTimer) return;
    clearTimeout(this.recordingTimer);
    this.recordingTimer = null;
  }

  /**
   * クリップボードのテキストをデバイスへ流す。
   * 1 文字ずつのキー送出（`keypress`）では URL の入力が現実的でないため。
   */
  private async pasteText(text: string): Promise<void> {
    if (!this.currentDeviceId || !this.inputController) {
      Logger.warn('Cannot paste: no device selected');
      return;
    }
    if (typeof text !== 'string' || text.length === 0) return;
    // 貼り付けは 1 回の操作。長さは webview 側でも切るが、ここでも上限を持つ
    // （巨大なテキストを HID で 1 文字ずつ流すと数分間ブロックする）。
    const value = text.slice(0, SimulatorWebviewProvider.MAX_PASTE_CHARS);
    if (value.length < text.length) {
      Logger.warn(
        `貼り付けが長いので ${SimulatorWebviewProvider.MAX_PASTE_CHARS} 文字で切った`
      );
    }
    await this.inputController.text(value);
  }

  /**
   * 停止中のデバイスを選んだときの確認と起動。コマンドパレット側（`pickDevice`）と
   * 同じ文言・同じ振る舞いにする（導線で結果が変わらないようにする）。
   */
  private async confirmAndBoot(deviceId: string): Promise<void> {
    if (!deviceId) return;
    const name = this.devices.find((d) => d.id === deviceId)?.name ?? deviceId;
    const boot = vscode.l10n.t('Boot and connect');
    const answer = await vscode.window.showInformationMessage(
      vscode.l10n.t('{0} is not running. Boot it?', name),
      boot,
      vscode.l10n.t('Cancel')
    );
    if (answer !== boot) {
      // 起動しないなら選択を戻す（「選んだのに何も起きない」を残さない）
      this.postMessage({type: 'selectedDevice', deviceId: this.currentDeviceId ?? ''});
      return;
    }
    await this.bootAndConnect(deviceId);
  }

  /** 見た目の好み（設定が持つもの）を webview へ渡す。 */
  private postSettings(): void {
    const cfg = vscode.workspace.getConfiguration('secondarySimulator');
    this.postMessage({
      type: 'settings',
      showDeviceFrame: cfg.get<boolean>('showDeviceFrame', true),
      showResourceStats: cfg.get<boolean>('showResourceStats', false),
    });
  }

  /**
   * 接続中のデバイスの画面を 1 枚取り、保存先を尋ねて書き出す。
   * 保存先はユーザーが選ぶので、拡張が勝手に永続ストレージを持つことにはならない。
   */
  async saveScreenshot(): Promise<void> {
    const deviceId = this.currentDeviceId;
    if (!deviceId || !this.mobileCliClient) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Secondary Simulator: Connect to a device before taking a screenshot.'
        )
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
        vscode.l10n.t(
          'Secondary Simulator: Could not capture a screenshot — {0}',
          (error as Error).message
        )
      );
      return;
    }

    const target = await vscode.window.showSaveDialog({
      title: vscode.l10n.t('Save screenshot to'),
      defaultUri: vscode.Uri.joinPath(
        this.defaultScreenshotDir(),
        defaultScreenshotName(deviceName, shot.ext)
      ),
      filters: {[vscode.l10n.t('Images')]: [shot.ext]},
    });
    if (!target) return; // キャンセル

    try {
      await vscode.workspace.fs.writeFile(target, shot.bytes);
    } catch (error) {
      Logger.error('スクリーンショットの保存に失敗', error as Error);
      void vscode.window.showErrorMessage(
        vscode.l10n.t(
          'Secondary Simulator: Could not save — {0}',
          (error as Error).message
        )
      );
      return;
    }

    Logger.info(`スクリーンショットを保存: ${target.fsPath}`);
    const openLabel = vscode.l10n.t('Open');
    const open = await vscode.window.showInformationMessage(
      vscode.l10n.t('Screenshot saved: {0}', target.fsPath),
      openLabel
    );
    if (open === openLabel) {
      await vscode.commands.executeCommand('vscode.open', target);
    }
  }

  /** 保存ダイアログの初期位置。ワークスペースがあればその直下、無ければホーム。 */
  private defaultScreenshotDir(): vscode.Uri {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? folder.uri : vscode.Uri.file(os.homedir());
  }

  /**
   * @param options.keepInput 入力コントローラ（＝サイドカープロセス）を残す。
   *   非表示や同じデバイスへの繋ぎ直しで、`ready` 待ちと HID クライアント生成を
   *   やり直さないため。
   */
  private stopCapture(options?: {keepInput?: boolean}): void {
    if (this.currentCapture) {
      this.currentCapture.dispose();
      this.currentCapture = null;
    }
    this.directStreaming = false;
    if (!options?.keepInput) {
      this.clearInputReleaseTimer();
      if (this.inputController) {
        this.inputController.dispose();
        this.inputController = null;
      }
    }
    // 直結 <img> の GET を閉じ、非表示中も MJPEG を流し続けない
    this.postMessage({type: 'pauseStream'});
  }

  /**
   * 非表示のまま放置されたら入力コントローラを解放する。
   * 使い回しは「すぐ戻ってくる」場合のためのもので、畳んだままの子プロセスを
   * 抱え続ける理由は無い（CLAUDE.md「確保したものは必ず捨てる」）。
   */
  private armInputRelease(): void {
    this.clearInputReleaseTimer();
    if (!this.inputController) return;
    this.inputReleaseTimer = setTimeout(() => {
      this.inputReleaseTimer = null;
      if (this.view?.visible) return; // その間に戻ってきた
      Logger.info('非表示が続いたため入力コントローラを解放する');
      this.inputController?.dispose();
      this.inputController = null;
    }, SimulatorWebviewProvider.INPUT_RELEASE_MS);
    // 解放待ちで拡張ホストの終了を遅らせない
    this.inputReleaseTimer.unref?.();
  }

  private clearInputReleaseTimer(): void {
    if (!this.inputReleaseTimer) return;
    clearTimeout(this.inputReleaseTimer);
    this.inputReleaseTimer = null;
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
    // 切断で録画を宙に浮かせない（止めないと mobilecli 側のセッションが残る）
    await this.stopRecording();
    this.stopCapture();
    this.currentDeviceId = null;
    this.setStatus({state: 'disconnected'});
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
    // 直結ストリームは preferredPort から最大 20 ポートを試すため、範囲を CSP に含める。
    // 設定の ON/OFF で HTML を作り直さないので、使わないときも範囲を許可しておく
    // （トークンが無いと絵は取れない。localhost 以外には開かない）。
    const range = (base: number, count: number) =>
      Array.from({length: count}, (_, i) => ` http://localhost:${base + i}`).join('');
    const proxyOrigins = range(
      SimulatorWebviewProvider.PROXY_BASE_PORT,
      MjpegProxy.MAX_PORT_TRIES
    );
    // サイドカーの直結配信も同じ理由で範囲を許可する（開始時にポートが未定のため）
    const sidecarOrigins = range(
      SidecarCapture.STREAM_BASE_PORT,
      SidecarCapture.MAX_PORT_TRIES
    );
    const extra = proxyOrigins + sidecarOrigins;
    const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:${extra}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">`;

    const html = fs.readFileSync(htmlPath.fsPath, 'utf8');
    return html
      .replace('{{scriptUri}}', scriptUri.toString())
      .replace('{{styleUri}}', styleUri.toString())
      .replace('{{nonce}}', nonce)
      .replace('{{cspMeta}}', cspMeta)
      .replace('{{l10n}}', SimulatorWebviewProvider.embedJson(webviewStrings()));
  }

  /**
   * `<script type="application/json">` へ埋める JSON。
   *
   * `<` を `\u003c` へ逃がす。文言に `</script>` が入るとその場でブロックが閉じ、
   * 後続が HTML として解釈されてしまう（今の文言には無いが、翻訳を足すのは人なので
   * 埋め込む側で断つ）。
   */
  private static embedJson(value: unknown): string {
    return JSON.stringify(value).replace(/</g, '\\u003c');
  }

  private getNonce(): string {
    return randomUUID().replace(/-/g, '');
  }

  /**
   * @param event 何が変わったかを判定する。取り込みに関係ない設定
   *   （`autoConnect` / `logLevel` / `keyInput`）で画面を切らないため。
   */
  onConfigurationChanged(event?: vscode.ConfigurationChangeEvent): void {
    const action = captureConfigAction(
      event && ((s) => event.affectsConfiguration(s))
    );
    if (action === 'recreate' && this.currentDeviceId) {
      const device = this.devices.find((d) => d.id === this.currentDeviceId);
      if (device) {
        void this.startCaptureForDevice(this.currentDeviceId, device).catch(
          (error) =>
            Logger.error('設定変更後の取り込み再開に失敗', error as Error)
        );
      }
    } else if (action === 'tune') {
      this.currentCapture?.updateConfig();
    }
    // autoConnect と見た目の設定を即座に反映する（ON に戻したらその場で探しに行く）
    this.postAutoConnectState();
    this.postSettings();
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
    // 録画は非同期だが dispose は同期。結果は待てないので送るだけ送る
    // （待たずに落ちても、次の接続で mobilecli 側のセッションは張り直される）。
    this.clearRecordingTimer();
    const recording = this.recording;
    this.recording = null;
    if (recording) {
      void this.mobileCliClient
        ?.stopScreenRecord(recording.deviceId)
        .catch(() => {});
    }
    this.stopCapture();
    this.mjpegProxy?.dispose();
    this.mjpegProxy = null;
    this.mobileCliServer.stopServer();
    this.view = undefined;
    // view を落としてから。破棄済みの webview へ postMessage しない。
    this.setStatus({state: 'disconnected'});
    this.currentDeviceId = null;
    this.devices = [];
    this.screenSize = null;
    this.mobileCliClient = null;
  }
}
