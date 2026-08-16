import * as fs from 'node:fs';
import {Logger} from '../utils/Logger';
import {MobileCliClient} from '../utils/MobileCliClient';
import {HidSidecarBackend} from './HidSidecarBackend';
import {HidModifier, HidUsage, InputBackend} from './InputBackend';
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
}

/**
 * 入力の司令塔。
 *
 * - デバイス種別に応じて HID 注入 / WDA フォールバックを選ぶ
 * - HID が復帰不能になったら WDA へ降格する
 * - 既存 webview メッセージ（tap/swipe/gesture/longPress/doubleTap/keypress/home/back）を
 *   バックエンドの down/move/up 等へ変換する
 *
 * 設計は docs/sidecar-protocol.md。
 */
export class SimulatorInputController {
  private primary!: InputBackend;
  private readonly wdaFallback: WdaBackend;
  private sidecar: SimhidSidecar | null = null;

  constructor(private readonly opts: ControllerOptions) {
    this.wdaFallback = new WdaBackend(
      opts.mobileCliClient,
      opts.deviceId,
      opts.getScreenSize
    );
    // init 完了前に touch が来ても primary 未設定で落ちないようにする
    this.primary = this.wdaFallback;
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
    this.primary = this.wdaFallback;
    this.opts.onBackendChange?.('wda');
  }

  private degradeToWda(reason: string): void {
    if (this.primary.kind === 'wda') return;
    Logger.warn(`HID 経路を降格し WDA へ切替: ${reason}`);
    this.primary = this.wdaFallback;
    this.opts.onBackendChange?.('wda');
  }

  get backendKind(): 'hid' | 'wda' {
    return this.primary.kind;
  }

  get sidecarPid(): number | undefined {
    return this.sidecar?.pid;
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

  // ---- 高レベル操作（キーバインドコマンドや後方互換で使う）----

  async tap(x: number, y: number): Promise<void> {
    await this.primary.touchDown(x, y);
    await sleep(30);
    await this.primary.touchUp(x, y);
  }

  async doubleTap(x: number, y: number): Promise<void> {
    await this.tap(x, y);
    await sleep(80);
    await this.tap(x, y);
  }

  async longPress(x: number, y: number, durationMs = 600): Promise<void> {
    await this.primary.touchDown(x, y);
    await sleep(durationMs);
    await this.primary.touchUp(x, y);
  }

  async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs = 250
  ): Promise<void> {
    await this.primary.touchDown(x1, y1);
    // 中間点を補間して流す（HID は coalesce、WDA は蓄積される）
    const steps = 12;
    const stepDelay = Math.max(8, Math.min(durationMs, 600) / steps);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await this.primary.touchMove(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
      await sleep(stepDelay);
    }
    await this.primary.touchUp(x2, y2);
  }

  async gesture(
    points: Array<{x: number; y: number; duration: number}>
  ): Promise<void> {
    if (points.length === 0) return;
    await this.primary.touchDown(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      await this.primary.touchMove(points[i].x, points[i].y);
      const dt = points[i].duration - points[i - 1].duration;
      await sleep(Math.max(8, Math.min(dt, 100)));
    }
    const last = points[points.length - 1];
    await this.primary.touchUp(last.x, last.y);
  }

  async keypress(key: string, special?: boolean): Promise<void> {
    if (special) {
      const usage = SimulatorInputController.specialUsage(key);
      if (usage !== undefined) {
        await this.primary.key(usage, true);
        await sleep(10);
        await this.primary.key(usage, false);
        return;
      }
    }
    // 通常文字はテキストとして送る（ASCII/非ASCII の振り分けは text() が行う）
    await this.text(key);
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
    if (this.primary.kind === 'wda') {
      await this.primary.text(value);
      return;
    }
    // ASCII 連続部分と非 ASCII 部分に分割し、順に送る
    let buf = '';
    let bufIsAscii = SimulatorInputController.isAscii(value[0] ?? 'a');
    const flush = async () => {
      if (!buf) return;
      if (bufIsAscii) await this.primary.text(buf);
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

  /** 修飾キー（webview がホストのキーボード修飾を送る場合に使う） */
  async modifier(name: keyof typeof HidModifier, down: boolean): Promise<void> {
    await this.primary.modifier(HidModifier[name], down);
  }

  dispose(): void {
    this.primary?.dispose();
    this.wdaFallback.dispose();
    this.sidecar?.dispose();
    this.sidecar = null;
  }
}
