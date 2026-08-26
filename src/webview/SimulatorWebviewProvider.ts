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
import {
  keyLabel,
  SimulatorInputController,
} from '../input/SimulatorInputController';
import {pickAutoConnectDevice} from '../simulator/autoConnect';
import {defaultRecordingName} from '../simulator/RecordingName';
import {verifyRecording} from '../simulator/RecordingFile';
import {
  containerExtension,
  ViewRecordingAbort,
  ViewRecordingWriter,
} from '../simulator/ViewRecording';
import {resolveSaveDirectory, SaveLocation} from '../simulator/SaveDirectory';
import {Device, DeviceType} from '../simulator/types';
import {DeviceStatus, renderStatus} from '../ui/DeviceStatusBar';
import {JsonRpcClient} from '../utils/JsonRpcClient';
import {Logger} from '../utils/Logger';
import {MobileCliClient} from '../utils/MobileCliClient';
import {MobileCliServer} from '../utils/MobileCliServer';
import {collectResourceStats} from '../utils/ResourceStats';
import {statusStrings, webviewStrings} from '../utils/Strings';

/**
 * 録画の作り方。
 *
 * - `device`: 端末側の録画（mobilecli の `device.screenrecord`）。端末の解像度で
 *   録れるが、**マウスカーソルもタップも写らない**（入力は合成なので端末が指を描かない）。
 * - `view`: webview で「表示中のフレーム＋操作の表示」を合成して録る。見えている
 *   とおりが残る代わりに、画質は取り込みストリームに従う。
 */
export type RecordingSource = 'device' | 'view';

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
   * 保持するのは「どの端末を、どこへ、どちらの経路で書いているか」の 1 件だけ。
   */
  private recording: {
    deviceId: string;
    target: vscode.Uri;
    source: RecordingSource;
  } | null = null;
  /**
   * ビュー録画で webview が使える MIME。`init` が報告する（使えなければ null）。
   * MediaRecorder と canvas.captureStream の有無は Chromium の版に依るので、
   * こちら側で決め打たない。
   */
  private viewRecordingMime: string | null = null;
  /** ビュー録画の書き込み先。1 セッションに 1 つだけ持つ。 */
  private viewWriter: ViewRecordingWriter | null = null;
  /** webview の「始めた／始められない」の応答を待つ受け口（1 件だけ）。 */
  private viewStartWaiter:
    | ((result: {ok: boolean; message?: string}) => void)
    | null = null;
  /** webview の「最後のチャンクまで出し切った」応答を待つ受け口（1 件だけ）。 */
  private viewStopWaiter: (() => void) | null = null;
  /**
   * ビュー録画のあいだだけ直結配信をやめる。別オリジンの `<img>` を canvas へ
   * 描くと汚染され、`captureStream` が SecurityError で止まるため
   * （中継経路のフレームは data URL なので汚染しない）。
   */
  private forceRelayCapture = false;
  /** 直近の統計 tick から書けたバイト数。フッターの録画チップに出して 0 に戻す。 */
  private recordingBytesSinceTick = 0;
  /**
   * 止め忘れの保険。CLAUDE.md「上限と破棄条件をセットで書く」に従い、
   * 録画は必ず時間で終わる（切断・破棄でも止める）。
   */
  private recordingTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly MAX_RECORDING_MS = 10 * 60_000;
  /**
   * ビュー録画の総量の蓋。時間の上限とは別に持つ — ビットレートを固定してあるので
   * 10 分でも 300MB 程度に収まるが、**伸び方を言い切れる状態**にしておく。
   */
  private static readonly MAX_VIEW_RECORDING_BYTES = 512 * 1024 * 1024;
  /** webview が符号化するビットレート。ファイルの伸びを予測可能にするため固定する。 */
  private static readonly VIEW_RECORDING_BPS = 4_000_000;
  /** チャンクの間隔。無指定だと MediaRecorder が停止まで全部抱える。 */
  private static readonly VIEW_RECORDING_TIMESLICE_MS = 1_000;
  /** webview が抱えてよい未 ack チャンク数。超えたら**捨てずに**録画を止める。 */
  private static readonly VIEW_RECORDING_MAX_UNACKED = 8;
  /** チャンクが途切れたら webview が消えたとみなすまで（心拍は毎秒）。 */
  private static readonly VIEW_RECORDING_STALL_MS = 10_000;
  /** 開始・停止の応答待ち。返らない webview で録画状態を残さない。 */
  private static readonly VIEW_RECORDING_REPLY_MS = 10_000;
  /** 開始前に webview が出す秒読み。押した直後の画面が頭に写らないための猶予。 */
  private static readonly RECORDING_COUNTDOWN_SEC = 3;
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
        // 非表示のあいだ録画を続けると、止め忘れに気づけない。表示を止める前に止める。
        if (this.recording) {
          void this.stopRecording();
        }
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
    // 作り直しても録画は続いている。表示だけ復元する（非表示で止めた場合は無い）
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
    const elapsedMs = now - this.lastStatsAtMs;
    const rate = captureRate(this.frameCount, this.frameBytes, elapsedMs);
    this.frameCount = 0;
    this.frameBytes = 0;
    this.lastStatsAtMs = now;

    const pids = [
      this.mobileCliServer.getPid(),
      this.inputController?.sidecarPid,
      this.inputController?.adbTouchPid,
    ].filter((p): p is number => typeof p === 'number');
    // ビュー録画は webview（レンダラ）が符号化するので、その分の RSS は
    // collectResourceStats からは見えない。**ファイルの伸び方だけでも常に見せる** —
    // 上限に当たる前に異常へ気づける唯一の数字なので（CLAUDE.md「計測できる状態を保つ」）。
    const writer = this.viewWriter;
    const recording = writer
      ? {
          recMb: Math.round((writer.bytesWritten / (1024 * 1024)) * 10) / 10,
          recKbps: Math.round(
            this.recordingBytesSinceTick / 1024 / Math.max(1, elapsedMs / 1000)
          ),
        }
      : {};
    this.recordingBytesSinceTick = 0;

    try {
      const stats = await collectResourceStats(this.extensionUri.fsPath, pids);
      // 直結中はフレームを見ていないので、受信側の数字を出さない（0 と嘘をつかない）
      this.postMessage(
        this.directStreaming
          ? {type: 'resources', ...stats, ...recording, direct: true}
          : {type: 'resources', ...stats, ...recording, ...rate}
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
    // 録画のチャンクは毎秒 1 回だが、10 分で 600 行になるので同じく載せない。
    if (
      !message.type.startsWith('touch') &&
      message.type !== 'viewRecordingChunk'
    ) {
      Logger.debug(`Received message: ${message.type}`);
    }

    try {
      switch (message.type) {
        case 'init':
          // webview が作り直された。ビュー録画の生産者は前の webview にいたので、
          // 録画中なら続きは書かれない（10 秒待たずにここで畳む）。
          this.viewRecordingMime =
            typeof message.viewRecordingMime === 'string'
              ? message.viewRecordingMime
              : null;
          if (this.recording?.source === 'view') {
            await this.stopRecording({abort: {reason: 'stalled'}});
          }
          this.postAutoConnectState();
          this.postSettings();
          await this.refreshDevices();
          break;

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

        // ---- ビュー録画（webview が符号化し、ここが書く）--------------------
        case 'viewRecordingStarted':
          this.viewStartWaiter?.({ok: true});
          break;

        case 'viewRecordingChunk':
          await this.writeViewChunk(
            message.seq as number,
            message.data as string
          );
          break;

        case 'viewRecordingStopped':
          this.viewStopWaiter?.();
          break;

        case 'viewRecordingError': {
          const text = String(message.message ?? '');
          // 開始待ちならその結果として返す（録画中の扱いにしない）
          if (this.viewStartWaiter) {
            this.viewStartWaiter({ok: false, message: text});
            break;
          }
          Logger.error(`ビュー録画が webview 側で失敗: ${text}`);
          if (this.recording) {
            await this.stopRecording({
              abort: {reason: 'error', message: text},
            });
          }
          break;
        }

        // クリップボードの貼り付け。1 文字ずつのキー送出では URL 入力が現実的でない。
        case 'paste':
          await this.pasteText();
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
          // 内容は載せない。既定レベルで 1 打鍵 1 行を出力チャンネル（＝この拡張で
          // 唯一の無制限バッファ）へ書くと、パスワードまでセッション中残り続ける。
          Logger.debug(
            `keypress: ${keyLabel(message.key as string, message.special as boolean)}`
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
    // ビュー録画のあいだは中継経路に固定する（別オリジンの <img> は canvas を汚染し、
    // captureStream が SecurityError で止まる）。設定そのものは書き換えない。
    if (this.forceRelayCapture) return false;
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

  /**
   * 直結プロキシを畳む。HTTP リスナーとトークンを、使わなくなったあとも
   * セッション終了まで抱え続けない（CLAUDE.md「確保したものは必ず捨てる」）。
   */
  private disposeProxy(): void {
    if (!this.mjpegProxy) return;
    this.mjpegProxy.dispose();
    this.mjpegProxy = null;
  }

  // MJPEG 直結プロキシを起動して返す（未起動なら起動）
  private async ensureProxy(): Promise<MjpegProxy> {
    if (this.mjpegProxy?.isRunning()) return this.mjpegProxy;
    await this.mobileCliServer.launchServer();
    this.mjpegProxy = new MjpegProxy(this.mobileCliServer.getServerPort());
    const port = await this.mjpegProxy.start(
      SimulatorWebviewProvider.PROXY_BASE_PORT
    );
    // 上書きにするとサイドカー配信の許可を消してしまう。追記に寄せる。
    this.allowStreamPort(port);
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
   * 経路は 2 つある（`secondarySimulator.recordingSource`）。
   *
   * - `device`: `device.screenrecord` の `output` に保存先を渡し、mobilecli が
   *   直接そこへ書く。端末の解像度で録れるが**操作は写らない**。
   * - `view`: webview が「表示中のフレーム＋操作の表示」を合成して符号化し、
   *   チャンクをここへ流す。書き先はどちらもユーザーが選んだパスだけで、
   *   **拡張は一時ファイルを持たない**。
   *
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

    // 使えないときは黙って端末側へ落とさない。操作が写る前提で押しているので、
    // 写らないまま録れると（HID→WDA の無音降格と同じで）気づけない。
    let source = this.recordingSource();
    if (source === 'view' && !this.canRecordView()) {
      Logger.warn(
        `ビュー録画を使えないので端末側で録る（mime=${this.viewRecordingMime}, visible=${this.view?.visible}）`
      );
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Secondary Simulator: This view cannot be recorded here, so the device recorder is used instead (taps and the pointer will not appear).'
        )
      );
      source = 'device';
    }
    const ext =
      source === 'view'
        ? (containerExtension(this.viewRecordingMime) ?? 'webm')
        : 'mp4';

    const target = await vscode.window.showSaveDialog({
      title: vscode.l10n.t('Save recording to'),
      defaultUri: vscode.Uri.joinPath(
        this.defaultSaveDir(),
        defaultRecordingName(deviceName, ext)
      ),
      filters: {[vscode.l10n.t('Videos')]: [ext]},
    });
    if (!target) return; // キャンセル

    // 画面を整える猶予。保存ダイアログを閉じた直後の画面が必ず頭に写るのを避ける。
    // 待っている間に破棄されうるので、クライアントはここで押さえる。
    const client = this.mobileCliClient;
    // 「隠されたら始めない」を判定するための基準。コマンドパレットから畳んだまま
    // 始める使い方は従来どおり通す（元から見えていなければ比べない）。
    const visibleAtStart = this.view?.visible === true;
    this.recordingBusy = true;
    try {
      // 直結配信のままだと <img> が別オリジンになり canvas を汚染する。
      // 張り直しの数秒は秒読みで吸収される。
      if (source === 'view') await this.prepareViewCapture();
      await this.countdownBeforeRecording();
      // 秒読みのあいだに状況が変わったら始めない。非表示・切替・破棄の見張りは
      // `this.recording` を見るので、まだ載っていないこの数秒は素通りする
      // （隠したのに録り始める・切り替える前の端末を録る、が起きる）。
      if (
        this.currentDeviceId !== deviceId ||
        !this.mobileCliClient ||
        (visibleAtStart && !this.view?.visible)
      ) {
        Logger.info('秒読み中に状況が変わったので録画を始めない');
        await this.releaseViewCapture();
        return;
      }
      if (source === 'view') await this.startViewRecording(target);
      else await client.startScreenRecord(deviceId, target.fsPath);
    } catch (error) {
      Logger.error('録画を開始できなかった', error as Error);
      await this.releaseViewCapture();
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

    this.recording = {deviceId, target, source};
    Logger.info(`録画を開始（${source}）: ${target.fsPath}`);
    this.postMessage({type: 'recording', active: true});

    // 上限で必ず終わらせる（押し忘れても増え続けない）
    this.recordingTimer = setTimeout(() => {
      this.recordingTimer = null;
      Logger.warn('録画が上限時間に達したので停止する');
      void this.stopRecording();
    }, SimulatorWebviewProvider.MAX_RECORDING_MS);
    this.recordingTimer.unref?.();
  }

  private recordingSource(): RecordingSource {
    return vscode.workspace
      .getConfiguration('secondarySimulator')
      .get<string>('recordingSource', 'device') === 'view'
      ? 'view'
      : 'device';
  }

  /**
   * ビュー録画を始められるか。符号化するのは webview なので、
   * **見えていること**と MediaRecorder が使えることの両方が要る。
   */
  private canRecordView(): boolean {
    return this.viewRecordingMime !== null && this.view?.visible === true;
  }

  /**
   * 開始前のカウントダウン。webview が数字と音を出すだけで、進行はここが持つ
   * （webview にタイマーを置くと、非表示や再読み込みで置き去りになる）。
   */
  private async countdownBeforeRecording(): Promise<void> {
    for (let n = SimulatorWebviewProvider.RECORDING_COUNTDOWN_SEC; n > 0; n--) {
      this.postMessage({type: 'countdown', value: n});
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        timer.unref?.();
      });
    }
    this.postMessage({type: 'countdown', value: 0});
  }

  // ---- ビュー録画（webview が符号化し、ここが書く）------------------------------

  /** 直結配信をやめて中継経路へ戻す（canvas の汚染を避けるため）。 */
  private async prepareViewCapture(): Promise<void> {
    if (!this.isDirectStreamEnabled()) return;
    this.forceRelayCapture = true;
    this.disposeProxy();
    await this.restartDisplay();
  }

  /** 直結配信へ戻す。録画を始められなかったときも必ず通る。 */
  private async releaseViewCapture(): Promise<void> {
    if (!this.forceRelayCapture) return;
    this.forceRelayCapture = false;
    await this.restartDisplay();
  }

  /** 取り込みだけを張り直す（入力コントローラは同じ端末なら使い回される）。 */
  private async restartDisplay(): Promise<void> {
    const deviceId = this.currentDeviceId;
    if (!deviceId) return;
    const device = this.devices.find((d) => d.id === deviceId);
    if (!device) return;
    try {
      await this.startCaptureForDevice(deviceId, device);
    } catch (error) {
      Logger.error('取り込みの張り直しに失敗', error as Error);
    }
  }

  /**
   * webview に符号化を始めさせ、書き込み先を開く。
   * 始められなければ例外を投げる（呼び手がエラー表示を出す）。
   */
  private async startViewRecording(target: vscode.Uri): Promise<void> {
    const mimeType = this.viewRecordingMime;
    if (!mimeType) throw new Error('MediaRecorder is not available');

    const writer = new ViewRecordingWriter(target.fsPath, {
      maxBytes: SimulatorWebviewProvider.MAX_VIEW_RECORDING_BYTES,
      stallMs: SimulatorWebviewProvider.VIEW_RECORDING_STALL_MS,
      onAbort: (abort) => this.onViewRecordingAbort(abort),
    });
    await writer.open();
    this.viewWriter = writer;
    this.recordingBytesSinceTick = 0;

    const result = await new Promise<{ok: boolean; message?: string}>(
      (resolve) => {
        const timer = setTimeout(() => {
          this.viewStartWaiter = null;
          resolve({ok: false, message: 'timeout'});
        }, SimulatorWebviewProvider.VIEW_RECORDING_REPLY_MS);
        timer.unref?.();
        this.viewStartWaiter = (r) => {
          clearTimeout(timer);
          this.viewStartWaiter = null;
          resolve(r);
        };
        this.postMessage({
          type: 'startViewRecording',
          mimeType,
          bitsPerSecond: SimulatorWebviewProvider.VIEW_RECORDING_BPS,
          timesliceMs: SimulatorWebviewProvider.VIEW_RECORDING_TIMESLICE_MS,
          maxUnacked: SimulatorWebviewProvider.VIEW_RECORDING_MAX_UNACKED,
        });
      }
    );

    if (!result.ok) {
      this.viewWriter = null;
      // 返事が来なかっただけで webview 側は録っているかもしれない。止めさせる。
      this.postMessage({type: 'stopViewRecording'});
      await writer.close();
      // 1 バイトも書けていない空ファイルを、ユーザーが選んだ場所へ置き去りにしない
      if (writer.bytesWritten === 0) {
        try {
          await fs.promises.unlink(target.fsPath);
        } catch {
          // 消せなくても録画の失敗として扱う（ここでは何も言わない）
        }
      }
      throw new Error(result.message || 'webview did not start recording');
    }
    // ここから先はチャンクが毎秒届く。届かなくなったら webview が消えた合図。
    writer.startWatch();
  }

  /** webview から届いたチャンクを書き、書けたぶんだけ ack を返す。 */
  private async writeViewChunk(seq: number, data: string): Promise<void> {
    const writer = this.viewWriter;
    if (!writer || typeof data !== 'string') return;
    const bytes = Buffer.from(data, 'base64');
    // 書き終える（＝逆圧を受け切る）まで ack を返さない。webview は未 ack の
    // 上限を超えたら録画そのものを止める — **チャンクは捨てられない**ため。
    const written = await writer.write(seq, bytes);
    if (!written) return;
    this.recordingBytesSinceTick += bytes.length;
    this.postMessage({type: 'viewRecordingAck', seq});
  }

  /** 上限・欠落・停止で書き込み側が打ち切ったとき。録画セッションごと畳む。 */
  private onViewRecordingAbort(abort: ViewRecordingAbort): void {
    Logger.warn(`ビュー録画を打ち切る: ${JSON.stringify(abort)}`);
    void this.stopRecording({abort});
  }

  /** webview に符号化を止めさせ、最後のチャンクまで受け切る。 */
  private async requestViewStop(): Promise<void> {
    // webview が既に無ければ待たない（破棄・再作成の経路で 10 秒止まらない）
    if (!this.view) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.viewStopWaiter = null;
        Logger.warn('webview から録画停止の応答が無かった');
        resolve();
      }, SimulatorWebviewProvider.VIEW_RECORDING_REPLY_MS);
      timer.unref?.();
      this.viewStopWaiter = () => {
        clearTimeout(timer);
        this.viewStopWaiter = null;
        resolve();
      };
      this.postMessage({type: 'stopViewRecording'});
    });
  }

  /**
   * 録画を止めて書き出す。端末側の停止が成功してからだけ `recording` と UI を戻す
   * — 先に戻すと「止まったように見えるが端末では録り続けている」状態になる。
   *
   * @param options.abort 書き込み側が打ち切った理由。**中身が欠けている合図**なので、
   *   停止音も「保存できた」の通知も出さない。
   */
  private async stopRecording(options?: {
    abort?: ViewRecordingAbort;
  }): Promise<void> {
    const session = this.recording;
    if (!session) return;
    if (session.source === 'view') {
      await this.stopViewRecording(session, options?.abort);
      return;
    }

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
    await this.finishRecording(session);
  }

  /**
   * ビュー録画を止める。**webview の符号化を止めて最後のチャンクを受け切ってから**
   * ファイルを閉じる（先に閉じると末尾が落ちる）。
   */
  private async stopViewRecording(
    session: {deviceId: string; target: vscode.Uri; source: RecordingSource},
    abort?: ViewRecordingAbort
  ): Promise<void> {
    // 停止ボタンと打ち切りが重なっても 1 回で終わらせる
    if (this.recordingBusy) return;
    this.recordingBusy = true;
    const writer = this.viewWriter;
    try {
      // webview が消えた（stalled）以外は、出し切らせてから閉じる
      if (!abort || abort.reason === 'size') await this.requestViewStop();
      else this.postMessage({type: 'stopViewRecording'});
      await writer?.close();
    } finally {
      this.viewWriter = null;
      this.recordingBusy = false;
    }

    this.clearRecordingTimer();
    this.recording = null;
    await this.releaseViewCapture();
    // 停止の応答を待っているあいだに打ち切られた（停止と stall が重なった）場合、
    // 呼び手は abort を知らない。**書き込み側の記録を優先する** — 末尾が欠けた
    // ファイルを「保存できた」と言わないため。
    await this.finishRecording(session, abort ?? writer?.abortReason ?? undefined);
  }

  /**
   * 書き出し終わったファイルを検査して結果を出す（両経路で共通）。
   *
   * 停止が成功しても、端末側で finalize されていなければ moov の無い mp4 が残る
   * （映像は入っているのに再生できない）。**成功と言い切る前に中身を見る** —
   * 音と通知が「保存できた」の合図になっているので、黙って通すと利用者は
   * 壊れたことに気づけない（`RecordingFile.ts`）。
   */
  private async finishRecording(
    session: {deviceId: string; target: vscode.Uri; source: RecordingSource},
    abort?: ViewRecordingAbort
  ): Promise<void> {
    const check = await verifyRecording(session.target.fsPath);
    // 総量の上限は「そこまでは正しく録れている」なので成功として扱う。
    // 欠落・停止・エラーは末尾が落ちているので、成功の合図を出さない。
    const intact = check.ok && (!abort || abort.reason === 'size');
    this.postMessage({type: 'recording', active: false, ok: intact});

    if (!check.ok) {
      Logger.error(
        `録画が完成していない（${check.reason}）: ${session.target.fsPath}`
      );
      const showLogs = vscode.l10n.t('Show Logs');
      const answer = await vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Secondary Simulator: The recording was not finalized and cannot be played — {0}',
          session.target.fsPath
        ),
        showLogs
      );
      if (answer === showLogs) Logger.show();
      return;
    }

    if (abort && abort.reason !== 'size') {
      Logger.error(`録画が途中で切れた（${abort.reason}）: ${session.target.fsPath}`);
      const showLogs = vscode.l10n.t('Show Logs');
      const answer = await vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Secondary Simulator: The recording was cut short and may be missing the end — {0}',
          session.target.fsPath
        ),
        showLogs
      );
      if (answer === showLogs) Logger.show();
      return;
    }

    Logger.info(`録画を保存: ${session.target.fsPath}`);
    const openLabel = vscode.l10n.t('Open');
    const message =
      abort?.reason === 'size'
        ? vscode.l10n.t(
            'Recording stopped at the size limit and was saved: {0}',
            session.target.fsPath
          )
        : vscode.l10n.t('Recording saved: {0}', session.target.fsPath);
    const open = await vscode.window.showInformationMessage(message, openLabel);
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
   *
   * **クリップボードはここ（拡張ホスト）で読む。** webview は sandbox 化された
   * iframe で、`clipboardData` には外部アプリでコピーした内容がひとつ前のまま返る。
   * webview から来るのは「貼れ」という合図だけで、中身は載っていない。
   */
  private async pasteText(): Promise<void> {
    if (!this.currentDeviceId || !this.inputController) {
      Logger.warn('Cannot paste: no device selected');
      return;
    }
    const text = await vscode.env.clipboard.readText();
    if (!text) {
      // 黙って落とすと「貼ったのに反映されない」に見える。理由を残す。
      Logger.info('クリップボードが空なので貼り付けない');
      return;
    }
    // 貼り付けは 1 回の操作。上限を持つのはここだけになった
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
        this.defaultSaveDir(),
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
    this.postMessage({type: 'sound', sound: 'shutter'});
    const openLabel = vscode.l10n.t('Open');
    const open = await vscode.window.showInformationMessage(
      vscode.l10n.t('Screenshot saved: {0}', target.fsPath),
      openLabel
    );
    if (open === openLabel) {
      await vscode.commands.executeCommand('vscode.open', target);
    }
  }

  /** 保存ダイアログの初期フォルダ（`secondarySimulator.saveLocation`）。 */
  private defaultSaveDir(): vscode.Uri {
    const cfg = vscode.workspace.getConfiguration('secondarySimulator');
    const dir = resolveSaveDirectory({
      saveLocation: cfg.get<SaveLocation>('saveLocation', 'desktop'),
      customPath: cfg.get<string>('saveDirectory', ''),
      workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      homeDir: os.homedir(),
    });
    return vscode.Uri.file(dir);
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
    this.disposeProxy();
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
    // 直結を切ったらプロキシも畳む（張り直しは ensureProxy がやる）
    if (!this.isDirectStreamEnabled()) {
      this.disposeProxy();
    }
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
    this.clearRecordingTimer();

    this.stopCapture();
    this.disposeProxy();
    this.view = undefined;
    // view を落としてから。破棄済みの webview へ postMessage しない。
    this.setStatus({state: 'disconnected'});
    this.currentDeviceId = null;
    this.devices = [];
    this.screenSize = null;

    // mobilecli を先に落とすと stopScreenRecord が届かない。停止を待ってからサーバを止める。
    // ビュー録画はここで webview が既に無いので、待たずにファイルを閉じて終わる。
    const stopRecording = this.recording ? this.stopRecording() : Promise.resolve();
    void stopRecording.finally(() => {
      // 経路によらず、開いたままの書き込み先を残さない
      const writer = this.viewWriter;
      this.viewWriter = null;
      void writer?.close();
      this.mobileCliServer.stopServer();
      this.mobileCliClient = null;
    });
  }
}
