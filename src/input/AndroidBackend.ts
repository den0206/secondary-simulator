import {Logger} from '../utils/Logger';
import {ButtonType, MobileCliClient} from '../utils/MobileCliClient';
import {AdbTouch} from './AdbTouch';
import {HidUsage, InputBackend, InputLabel} from './InputBackend';

type Pt = {x: number; y: number};

/** 端末へ送る 1 イベント。座標はデバイスピクセル。 */
type Touch = {t: 'DOWN' | 'MOVE' | 'UP'; x: number; y: number};

type GestureAction = {
  type: string;
  duration?: number;
  x?: number;
  y?: number;
  button?: number;
};

/**
 * Android（adb）向けタッチバックエンド。
 *
 * mobilecli の `device.io.gesture` は Android では **1 アクション = adb 1 起動**
 * （`adb shell input touchscreen motionevent down|move|up X Y`）に展開される。
 * **`duration` は Android では完全に無視される**（mobilecli `devices/android.go` の
 * `Gesture`。`pause` だけがホスト側の sleep になる）。
 *
 * そのため `WdaBackend` のように「touchUp まで軌跡を貯めて一括送信」すると:
 *
 * 1. 240 点のドラッグが 240 回の adb 起動になり、指を離してから数十秒かけて再生される
 * 2. 各イベントの時刻が指の実際の動きと無関係になるため、Android の VelocityTracker が
 *    速度を拾えず、フリック（慣性スクロール）が一切効かない
 *
 * ＝ これが「ドラッグ／スクロールの感度が酷い」の正体。タップ（`input tap` 1 回）と
 * 画面同期は別経路なので影響を受けない。
 *
 * ここでは貯めずに**押している間ずっと送り続ける**:
 *
 * - `down` は「タップかドラッグか」が決まるまで送らない。タップは `input tap` 1 回で
 *   済ませたい（今のタップの速さを落とさない）ため
 * - ドラッグに入ったら常に**最新の 1 点だけ**を送る。前の adb が返るまで次を出さない
 *   （溜めない・詰まらせない。webview の `MAX_FRAME_QUEUE = 1` と同じ考え方）
 * - `up` は指を離した時点で送る。down..up の実時間が指の実時間と一致するので
 *   速度が正しく伝わり、フリックが効く
 * - 動かないまま {@link LONG_PRESS_MS} 押し続けたら `down` を先出しして「押しっぱなし」に
 *   する（長押し、および長押し→ドラッグのため）
 *
 * それでも mobilecli 経由では **1 イベント = adb 1 起動**（実測 約 70ms ＝ 14Hz）で、
 * ドラッグはまだ粗い。{@link AdbTouch} が使えるときは `adb shell` の常駐セッションへ
 * 直接流し（同 約 20ms ＝ 45Hz）、`UP` にも座標を持たせて「離す直前に止まっている時間」
 * を無くす。使えなければ mobilecli 経路へそのまま落ちる。
 *
 * 座標は正規化 [0,1] で受け、ピクセル変換はこの中だけで行う。
 */
export class AndroidBackend implements InputBackend {
  // HID の特別扱いをしない側なので kind は wda と同じ扱いになる。
  // ただし**表示は分ける** — Android の経路に WebDriverAgent は登場しない。
  readonly kind = 'wda' as const;
  readonly label: InputLabel = 'adb';

  /** これを超えて動いたらドラッグ扱い（px）。Android の touch slop より小さくする。 */
  static readonly SLOP_PX = 12;
  /** 画面サイズが取れないときの代替 slop（正規化）。 */
  static readonly SLOP_NORM = 0.01;
  /** 静止したまま押し続けたら長押しとして down を先出しする閾値（ms）。 */
  static readonly LONG_PRESS_MS = 400;
  /** 1 セッションあたりのエラーログ上限。ドラッグは高頻度パスなので出しすぎない。 */
  static readonly MAX_ERROR_LOGS = 3;
  /** HID usage → Android のハードウェアキー。矢印は文字にできないのでこちらへ回す。 */
  static readonly DPAD_BY_USAGE: Readonly<Record<number, ButtonType>> = {
    [HidUsage.ArrowUp]: 'DPAD_UP',
    [HidUsage.ArrowDown]: 'DPAD_DOWN',
    [HidUsage.ArrowLeft]: 'DPAD_LEFT',
    [HidUsage.ArrowRight]: 'DPAD_RIGHT',
  };

  private phase: 'idle' | 'pending' | 'down' = 'idle';
  private start: Pt = {x: 0, y: 0};
  private last: Pt = {x: 0, y: 0};
  /** 長押し判定で down を先出しした（＝押しっぱなしを作った）。 */
  private holdDown = false;
  /** 先出しした down が実際に LONG_PRESS_MS 押された。 */
  private holdSatisfied = false;
  /** down を送り終えた時刻。0 は未送信。 */
  private downAckMs = 0;

  // 送信待ち。move は「最新の 1 点」だけを持ち、キューには積まない。
  private needDown = false;
  private needMove = false;
  private needUp = false;
  private downSent = false;
  /** 実行中の送信ループ。同時に走るのは常に 1 本だけ。 */
  private pumping: Promise<void> | null = null;

  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private holdResolve: (() => void) | null = null;
  private errorLogs = 0;
  private disposed = false;

  constructor(
    private readonly client: MobileCliClient,
    private readonly deviceId: string,
    private readonly getScreenSize: () => {width: number; height: number} | null,
    /** キー・テキスト・ハードウェアボタンの委譲先（mobilecli 経路は共通）。 */
    private readonly keys: InputBackend,
    /** 速い送信口。null か死んでいたら mobilecli 経路で送る。 */
    private readonly adb: AdbTouch | null = null
  ) {}

  // ---- 1本指タッチ ---------------------------------------------------------

  async touchDown(x: number, y: number): Promise<void> {
    // pointerup を取りこぼして前のセッションが残っていたら、必ず離してから始める
    if (this.phase !== 'idle') await this.touchUp(this.last.x, this.last.y);
    // 前のセッションの未送信ぶんを出し切ってから始める。start / last を先に
    // 上書きすると、まだ送っていない up が新しい指の座標で出てしまう
    // （素早い連打で起きる）。
    await this.pump();

    this.start = {x, y};
    this.last = {x, y};
    this.holdDown = false;
    this.holdSatisfied = false;
    this.downAckMs = 0;
    this.errorLogs = 0;
    this.phase = 'pending';

    this.clearPressTimer();
    this.pressTimer = setTimeout(() => {
      this.pressTimer = null;
      if (this.phase !== 'pending') return;
      // 動かないまま閾値を超えた。ここで down を出して「押しっぱなし」を作る。
      this.phase = 'down';
      this.holdDown = true;
      this.needDown = true;
      void this.pump();
    }, AndroidBackend.LONG_PRESS_MS);
  }

  async touchMove(x: number, y: number): Promise<void> {
    if (this.phase === 'idle') return;
    this.last = {x, y};

    if (this.phase === 'pending') {
      // slop を超えるまでは何も送らない（タップを `input tap` 1 回で済ませるため）
      if (!this.movedBeyondSlop()) return;
      this.clearPressTimer();
      this.phase = 'down';
      this.needDown = true;
    }

    this.needMove = true;
    // 待たない。60Hz で届く move を送信待ちで詰まらせない（最新点だけが残る）
    void this.pump();
  }

  async touchUp(x: number, y: number): Promise<void> {
    this.clearPressTimer();
    if (this.phase === 'idle') return;
    this.last = {x, y};
    const phase = this.phase;
    this.phase = 'idle';

    if (phase === 'pending') {
      if (this.movedBeyondSlop()) {
        // 速すぎて move が 1 度も slop を超えないまま離れた（短いフリック）
        this.needDown = true;
        this.needMove = true;
        this.needUp = true;
        await this.pump();
        return;
      }
      // 動いていない・長押しにも届いていない → タップ（adb 1 回で済む）
      await this.tap(this.start);
      return;
    }

    this.needMove = true;
    this.needUp = true;
    await this.pump();
  }

  // WDA/adb 経路ではマルチタッチ（ピンチ）を表現できない。1本目だけ追う近似に留める。
  async touch2Down(x: number, y: number): Promise<void> {
    return this.touchDown(x, y);
  }
  async touch2Move(x: number, y: number): Promise<void> {
    return this.touchMove(x, y);
  }
  async touch2Up(x: number, y: number): Promise<void> {
    Logger.debug('AndroidBackend: ピンチは非対応（1本指として処理）');
    return this.touchUp(x, y);
  }

  // ---- 送信 ----------------------------------------------------------------

  /**
   * 送信待ちが無くなるまで送り続ける。同時に走るのは常に 1 本だけで、
   * 実行中に届いた move は「最新の 1 点」に畳まれる（adb の往復に合わせて自動的に間引かれる）。
   *
   * 実行中の Promise をそのまま返すと、ループが空で抜けた直後に `needUp` が
   * 立った場合に UP が落ちる。終わったあともフラグが残っていればもう 1 周する。
   */
  private async pump(): Promise<void> {
    if (this.pumping) await this.pumping;
    if (this.pumping) return this.pump();
    if (!this.needDown && !this.needMove && !this.needUp) return;
    this.pumping = this.runPump().finally(() => {
      this.pumping = null;
    });
    await this.pumping;
    if (this.needDown || this.needMove || this.needUp) return this.pump();
  }

  /** {@link pump} の本体。送信待ちが無くなるまで回る。 */
  private async runPump(): Promise<void> {
    for (;;) {
      // 長押しで先出しした down は、実際に LONG_PRESS_MS 押されるまで次を出さない。
      // すぐ move / up を出すと「速いタップ」になり長押しが成立しない。
      if (
        this.holdDown &&
        !this.holdSatisfied &&
        this.downAckMs > 0 &&
        (this.needMove || this.needUp)
      ) {
        const held = Date.now() - this.downAckMs;
        if (held < AndroidBackend.LONG_PRESS_MS) {
          await this.wait(AndroidBackend.LONG_PRESS_MS - held);
        }
        this.holdSatisfied = true;
      }

      let touches: Touch[];
      try {
        touches = this.takeTouches();
      } catch (error) {
        // 画面サイズ未取得など。送りようがないので畳んで抜ける
        this.logError(error);
        this.resetPending();
        return;
      }
      if (touches.length === 0) return;

      const hadDown = touches.some((t) => t.t === 'DOWN');
      try {
        await this.send(touches);
      } catch (error) {
        // 失敗しても up は送り切る（指が押しっぱなしで残る方が害が大きい）
        this.logError(error);
      }
      if (hadDown) this.downAckMs = Date.now();
    }
  }

  /** 今すぐ送るぶんを取り出す（取り出したフラグは落とす）。 */
  private takeTouches(): Touch[] {
    const out: Touch[] = [];
    let downPx: Pt | null = null;

    if (this.needDown) {
      downPx = this.px(this.start);
      out.push({t: 'DOWN', ...downPx});
      this.needDown = false;
      this.downSent = true;
    }

    if (this.needMove || this.needUp) {
      if (!this.downSent) {
        // down を出せていないなら move も up も意味がない
        this.needMove = false;
        this.needUp = false;
        return out;
      }
      const p = this.px(this.last);
      const up = this.needUp;
      this.needMove = false;
      this.needUp = false;
      if (up) {
        // UP 自身が座標を運ぶ。同じ点の MOVE を挟むと「離す直前に止まっていた」
        // ことになり VelocityTracker の速度が落ちる（＝フリックが弱くなる）
        out.push({t: 'UP', ...p});
        this.downSent = false;
      } else if (!downPx || downPx.x !== p.x || downPx.y !== p.y) {
        // down と同じ点なら 1 イベントぶん無駄なので置かない
        out.push({t: 'MOVE', ...p});
      }
    }
    return out;
  }

  /** 速い adb 経路で送り、使えなければ mobilecli 経路へ落とす。 */
  private async send(touches: Touch[]): Promise<void> {
    if (this.adb && !this.adb.isDead) {
      const sent = await this.adb.send(
        touches.map((t) => `input touchscreen motionevent ${t.t} ${t.x} ${t.y}`)
      );
      if (sent) return;
    }
    await this.client.gesture(this.deviceId, AndroidBackend.toActions(touches));
  }

  /**
   * mobilecli の gesture アクションへ直す。
   *
   * mobilecli は `pointerDown` / `pointerUp` の座標を**直前の `pointerMove`** からしか
   * 取れない（`devices/android.go`）ので、位置決めの `pointerMove` を必ず先に置く。
   */
  private static toActions(touches: Touch[]): GestureAction[] {
    const out: GestureAction[] = [];
    let at: Pt | null = null;
    for (const t of touches) {
      if (!at || at.x !== t.x || at.y !== t.y) {
        out.push({type: 'pointerMove', duration: 0, x: t.x, y: t.y});
        at = {x: t.x, y: t.y};
      }
      if (t.t === 'DOWN') out.push({type: 'pointerDown', button: 0});
      if (t.t === 'UP') out.push({type: 'pointerUp', button: 0});
    }
    return out;
  }

  private async tap(p: Pt): Promise<void> {
    try {
      const q = this.px(p);
      await this.client.tap(this.deviceId, q.x, q.y);
    } catch (error) {
      // ここで投げると webview にエラー表示が出る。ログに残して握り潰す
      this.logError(error);
    }
  }

  /** 始点からの移動量が slop を超えたか。画面サイズがあれば px、無ければ正規化で見る。 */
  private movedBeyondSlop(): boolean {
    const dx = this.last.x - this.start.x;
    const dy = this.last.y - this.start.y;
    const s = this.getScreenSize();
    if (!s) return Math.hypot(dx, dy) >= AndroidBackend.SLOP_NORM;
    return Math.hypot(dx * s.width, dy * s.height) >= AndroidBackend.SLOP_PX;
  }

  private px(p: Pt): {x: number; y: number} {
    const s = this.getScreenSize();
    if (!s) {
      throw new Error('画面サイズ未取得のため Android 経路で座標変換できない');
    }
    // 1.0 をそのまま掛けると画面外の 1px になるので端に丸める
    return {
      x: Math.min(Math.max(Math.round(p.x * s.width), 0), s.width - 1),
      y: Math.min(Math.max(Math.round(p.y * s.height), 0), s.height - 1),
    };
  }

  // ---- タイマー・後始末 ----------------------------------------------------

  /** clearTimeout で捨てても待っている pump が止まらないよう、resolve も持っておく。 */
  private wait(ms: number): Promise<void> {
    this.clearHoldTimer();
    return new Promise<void>((resolve) => {
      this.holdResolve = resolve;
      this.holdTimer = setTimeout(() => {
        this.holdTimer = null;
        this.holdResolve = null;
        resolve();
      }, ms);
    });
  }

  private clearPressTimer(): void {
    if (!this.pressTimer) return;
    clearTimeout(this.pressTimer);
    this.pressTimer = null;
  }

  private clearHoldTimer(): void {
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    if (this.holdResolve) {
      const resolve = this.holdResolve;
      this.holdResolve = null;
      resolve();
    }
  }

  private resetPending(): void {
    this.needDown = false;
    this.needMove = false;
    this.needUp = false;
    this.downSent = false;
    this.phase = 'idle';
  }

  private logError(error: unknown): void {
    if (this.errorLogs >= AndroidBackend.MAX_ERROR_LOGS) return;
    this.errorLogs++;
    Logger.warn(`Android のタッチ送信に失敗: ${(error as Error).message}`);
  }

  // ---- タッチ以外は mobilecli 共通経路へ委譲 --------------------------------

  button(name: 'home' | 'lock'): Promise<void> {
    return this.keys.button(name);
  }

  /**
   * 矢印キーだけは `device.io.button` の DPAD へ回す。
   *
   * 委譲先の `WdaBackend.key` は usage を文字へ直して `device.io.text` へ流す作りで、
   * 矢印は対応する文字が無いため**黙って捨てられていた**。Android には
   * `KEYCODE_DPAD_*` があるので、ここで拾えば実際に効く。
   * 押し下げだけ送る（`device.io.button` は押して離すまでで 1 回）。
   */
  key(usage: number, down: boolean): Promise<void> {
    const dpad = AndroidBackend.DPAD_BY_USAGE[usage];
    if (dpad) {
      if (!down) return Promise.resolve();
      return this.client.pressButton(this.deviceId, dpad).catch((error) => {
        this.logError(error);
      });
    }
    return this.keys.key(usage, down);
  }

  modifier(bit: number, down: boolean): Promise<void> {
    return this.keys.modifier(bit, down);
  }

  text(value: string): Promise<void> {
    return this.keys.text(value);
  }

  dispose(): void {
    // SimulatorInputController は primary と androidBackend の両方を捨てるので
    // Android では 2 回来る。2 回目で adb を閉じると、1 回目が送っている
    // 「押しっぱなしを外す UP」が書かれる前にセッションが死ぬ。
    if (this.disposed) return;
    this.disposed = true;
    this.clearPressTimer();
    this.clearHoldTimer();
    const stuck = this.downSent;
    const last = this.last;
    this.resetPending();
    const closeAdb = () => this.adb?.dispose();
    if (!stuck) {
      closeAdb();
      return;
    }
    // 押しっぱなしの指を残さない（残ると次のタッチが別のジェスチャーになる）。
    // 切断中なので結果は待たないが、送り終えるまで adb は閉じない。
    try {
      void this.send([{t: 'UP', ...this.px(last)}])
        .catch(() => {})
        .finally(closeAdb);
    } catch {
      // 画面サイズ未取得なら送りようがない
      closeAdb();
    }
  }
}
