import * as fs from 'node:fs';
import {Logger} from '../utils/Logger';
import {MobileCliClient} from '../utils/MobileCliClient';
import {AdbTouch} from './AdbTouch';
import {AndroidBackend} from './AndroidBackend';
import {HidSidecarBackend} from './HidSidecarBackend';
import {
  HidModifier,
  HidUsage,
  InputBackend,
  MODIFIER_BITS,
  usageForAsciiChar,
} from './InputBackend';
import {SimhidSidecar} from './SimhidSidecar';
import {WdaBackend} from './WdaBackend';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ControllerOptions {
  deviceId: string;
  platform: 'ios' | 'android';
  type: 'simulator' | 'emulator' | 'real';
  mobileCliClient: MobileCliClient;
  getScreenSize: () => {width: number; height: number} | null;
  sidecarBinaryPath: string;
  /** バックエンドが切り替わったとき（初期選択・降格）に呼ばれる。status 表示用。 */
  onBackendChange?: (kind: 'hid' | 'wda') => void;
  /**
   * キーボード入力だけ WDA 経路にするか（タッチは HID のまま）。
   * HID のキー注入はシミュレータに「ハードウェアキーボード」として入るため、
   * iOS がソフトウェアキーボードを出さなくなる。出したいときはこちらを true にする。
   * 設定を即時反映させるため、値ではなく関数で受ける。
   */
  preferWdaKeys?: () => boolean;
  /**
   * Android の速いタッチ口。省略時は `AdbTouch` を作る。
   * 単体テストで実 adb を起こしたくないときは `null` を渡す（mobilecli 経路だけになる）。
   */
  adbTouch?: AdbTouch | null;
}

/**
 * 入力の司令塔。
 *
 * - デバイス種別に応じて HID 注入 / Android(adb) / WDA フォールバックを選ぶ
 * - HID が復帰不能になったら WDA へ降格する
 * - webview から届く生ポインタ（touchDown/Move/Up・2本指）をバックエンドへ素通しする
 * - keypress/home/back をバックエンドの key/button 等へ変換する
 *
 * 設計は docs/sidecar-protocol.md。
 */
export class SimulatorInputController {
  private primary!: InputBackend;
  private readonly wdaFallback: WdaBackend;
  private androidBackend: AndroidBackend | null = null;
  private adbTouch: AdbTouch | null = null;
  private sidecar: SimhidSidecar | null = null;

  constructor(private readonly opts: ControllerOptions) {
    this.wdaFallback = new WdaBackend(
      opts.mobileCliClient,
      opts.deviceId,
      opts.getScreenSize
    );
    // init 完了前に touch が来ても primary 未設定で落ちないようにする
    this.primary = this.defaultBackend();
  }

  /** バックエンドを選択して初期化する。iOS Simulator なら HID を試み、失敗時は WDA。 */
  async init(): Promise<void> {
    const canUseHid =
      this.opts.platform === 'ios' &&
      this.opts.type === 'simulator' &&
      fs.existsSync(this.opts.sidecarBinaryPath);

    if (canUseHid) {
      try {
        const sidecar = new SimhidSidecar(this.opts.sidecarBinaryPath);
        sidecar.onFatal = (reason) => this.degradeToWda(reason);
        await sidecar.start();
        this.sidecar = sidecar;
        this.primary = new HidSidecarBackend(sidecar, this.opts.deviceId);
        Logger.info('入力バックエンド: HID 直接注入');
        this.opts.onBackendChange?.('hid');
        return;
      } catch (error) {
        Logger.warn(
          `HID サイドカーの起動に失敗、WDA へフォールバック: ${
            (error as Error).message
          }`
        );
      }
    }
    this.primary = this.defaultBackend();
    this.opts.onBackendChange?.('wda');
  }

  /**
   * HID を使わないときの主経路。
   *
   * Android は `AndroidBackend`（adb の motionevent を押している間ずっと送る）。
   * `WdaBackend` の「touchUp まで貯めて一括送信」は、Android では 1 アクションが
   * adb 1 回に展開され duration も無視されるため、ドラッグが数十秒かけて再生され
   * フリックも効かない（AndroidBackend の冒頭コメント）。
   */
  private defaultBackend(): InputBackend {
    if (this.opts.platform === 'android') {
      if (!this.androidBackend) {
        this.adbTouch =
          this.opts.adbTouch === undefined
            ? new AdbTouch(this.opts.deviceId)
            : this.opts.adbTouch;
        this.androidBackend = new AndroidBackend(
          this.opts.mobileCliClient,
          this.opts.deviceId,
          this.opts.getScreenSize,
          this.wdaFallback,
          this.adbTouch
        );
      }
      return this.androidBackend;
    }
    return this.wdaFallback;
  }

  private degradeToWda(reason: string): void {
    if (this.primary.kind === 'wda') return;
    Logger.warn(`HID 経路を降格し WDA へ切替: ${reason}`);
    this.primary = this.defaultBackend();
    this.opts.onBackendChange?.('wda');
  }

  get backendKind(): 'hid' | 'wda' {
    return this.primary.kind;
  }

  get sidecarPid(): number | undefined {
    return this.sidecar?.pid;
  }

  /** Android のタッチ用 adb 常駐セッション。ResourceStats の集計対象。 */
  get adbTouchPid(): number | undefined {
    return this.adbTouch?.pid;
  }

  /** HID 経路が生きているときだけ非 null。画面取り込み（SidecarCapture）が使う。 */
  get activeSidecar(): SimhidSidecar | null {
    return this.primary.kind === 'hid' ? this.sidecar : null;
  }

  /** キー・テキストの送り先。設定が WDA 指定なら HID を使っていても WDA へ回す。 */
  private keyBackend(): InputBackend {
    return this.opts.preferWdaKeys?.() ? this.wdaFallback : this.primary;
  }

  // ---- 生ポインタ（Phase 1: webview の pointerdown/move/up をそのまま流す）----
  // これにより HID 経路ではドラッグに画面が追従する（タップ/スワイプ判定は端末が行う）。

  touchDown(x: number, y: number): Promise<void> {
    return this.primary.touchDown(x, y);
  }
  touchMove(x: number, y: number): Promise<void> {
    return this.primary.touchMove(x, y);
  }
  touchUp(x: number, y: number): Promise<void> {
    return this.primary.touchUp(x, y);
  }
  touch2Down(x: number, y: number, x2: number, y2: number): Promise<void> {
    return this.primary.touch2Down(x, y, x2, y2);
  }
  touch2Move(x: number, y: number, x2: number, y2: number): Promise<void> {
    return this.primary.touch2Move(x, y, x2, y2);
  }
  touch2Up(x: number, y: number, x2: number, y2: number): Promise<void> {
    return this.primary.touch2Up(x, y, x2, y2);
  }

  /**
   * キー入力。`modifiers` に Cmd/Ctrl/Option/Shift が入っていれば組み合わせとして送る
   * （Cmd+A / Cmd+C など）。修飾キーを扱えるのは HID 経路だけ。
   */
  async keypress(
    key: string,
    special?: boolean,
    modifiers?: readonly string[]
  ): Promise<void> {
    const bits = SimulatorInputController.modifierBits(modifiers);
    if (bits.length > 0) {
      await this.keyCombo(key, special, bits);
      return;
    }
    if (special) {
      const usage = SimulatorInputController.specialUsage(key);
      if (usage !== undefined) {
        const backend = this.keyBackend();
        await backend.key(usage, true);
        await sleep(10);
        await backend.key(usage, false);
        return;
      }
    }
    // 通常文字はテキストとして送る（ASCII/非ASCII の振り分けは text() が行う）
    await this.text(key);
  }

  /** 修飾キー名を bit へ。未知の名前は捨て、同じ bit は 1 つに畳む。 */
  private static modifierBits(names?: readonly string[]): number[] {
    if (!names || names.length === 0) return [];
    const bits: number[] = [];
    for (const name of names) {
      const bit = MODIFIER_BITS[name];
      // 二重に押すと「押した数」と「離した数」が合わなくなる
      if (bit !== undefined && !bits.includes(bit)) bits.push(bit);
    }
    return bits;
  }

  /**
   * 修飾キー付きの組み合わせを送る。
   *
   * `text` コマンドは使えない（Shift の捨てイベントを先に送るため、Cmd 押下中だと
   * 別の組み合わせが成立する。InputBackend.usageForAsciiChar のコメント参照）ので、
   * usage を自前で引いて keyDown/keyUp を組む。
   *
   * WDA（`device.io.text`）は修飾キーを扱えないため、HID 経路のときだけ送る。
   */
  private async keyCombo(
    key: string,
    special: boolean | undefined,
    bits: number[]
  ): Promise<void> {
    const backend = this.keyBackend();
    if (backend.kind !== 'hid') {
      Logger.warn(
        `修飾キー付きの入力は HID 経路でしか送れない（無視: ${key}）。` +
          'secondarySimulator.keyInput を hid にすると送れる。'
      );
      return;
    }

    let usage: number | undefined;
    if (special) {
      usage = SimulatorInputController.specialUsage(key);
    } else {
      const ascii = usageForAsciiChar(key);
      usage = ascii?.usage;
      // 大文字などシフトが要る文字は、指定が無くても Shift を足す
      if (ascii?.shift && !bits.includes(HidModifier.Shift)) {
        bits = [...bits, HidModifier.Shift];
      }
    }
    if (usage === undefined) {
      Logger.warn(`HID の usage に対応しないキーなので送らない: ${key}`);
      return;
    }

    // 押した修飾キーは必ず離す。途中で失敗しても押しっぱなしを残さない
    // （残ると以降の入力が全て Cmd 付きとして扱われる）。
    const pressed: number[] = [];
    try {
      for (const bit of bits) {
        await backend.modifier(bit, true);
        pressed.push(bit);
      }
      await backend.key(usage, true);
      await sleep(10);
      await backend.key(usage, false);
    } finally {
      for (const bit of pressed.reverse()) {
        // 1 つ失敗しても残りの解放は続ける
        await backend.modifier(bit, false).catch(() => {});
      }
    }
  }

  private static specialUsage(key: string): number | undefined {
    switch (key) {
      case 'delete':
        return HidUsage.Backspace;
      case 'return':
        return HidUsage.Enter;
      case 'escape':
        return HidUsage.Escape;
      default:
        return undefined;
    }
  }

  /**
   * テキスト入力。HID が主経路のとき、ASCII 部分は HID、非 ASCII 部分は WDA(inputText) へ委譲する
   * （docs/sidecar-protocol.md §10.3）。WDA が主経路なら全て WDA。
   */
  async text(value: string): Promise<void> {
    const backend = this.keyBackend();
    if (backend.kind === 'wda') {
      await backend.text(value);
      return;
    }
    // ASCII 連続部分と非 ASCII 部分に分割し、順に送る
    let buf = '';
    let bufIsAscii = SimulatorInputController.isAscii(value[0] ?? 'a');
    const flush = async () => {
      if (!buf) return;
      if (bufIsAscii) await backend.text(buf);
      else await this.wdaFallback.text(buf);
      buf = '';
    };
    for (const ch of value) {
      const ascii = SimulatorInputController.isAscii(ch);
      if (ascii !== bufIsAscii) {
        await flush();
        bufIsAscii = ascii;
      }
      buf += ch;
    }
    await flush();
  }

  private static isAscii(ch: string): boolean {
    const c = ch.charCodeAt(0);
    return c >= 0x20 && c <= 0x7e;
  }

  async home(): Promise<void> {
    await this.primary.button('home');
  }

  async back(): Promise<void> {
    if (this.opts.platform === 'ios') {
      // iOS に Back は存在しない（docs/sidecar-protocol.md §10.2）
      Logger.debug('iOS では back は no-op');
      return;
    }
    // Android の BACK は mobilecli が担当（HID 経路でも back は WDA へ委譲）
    await this.opts.mobileCliClient.pressButton(this.opts.deviceId, 'BACK');
  }

  dispose(): void {
    this.primary?.dispose();
    // adb 常駐セッションは AndroidBackend.dispose() が
    // 「押しっぱなしの指を外す UP」を送り切ってから閉じる
    // （primary と両方捨てるので 2 回来るが、2 回目は無視される）
    this.androidBackend?.dispose();
    this.adbTouch = null;
    this.wdaFallback.dispose();
    this.sidecar?.dispose();
    this.sidecar = null;
  }
}
