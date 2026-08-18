import {Logger} from '../utils/Logger';
import {MobileCliClient} from '../utils/MobileCliClient';
import {InputBackend} from './InputBackend';

type Pt = {x: number; y: number};

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
 * mobilecli の `device.io.gesture` は Android では **1 アクション = adb 1 回**
 * （`adb shell input touchscreen motionevent down|move|up X Y`）に展開され、
 * 1 回あたり 100ms 前後かかる。**`duration` は Android では完全に無視される**
 * （mobilecli `devices/android.go` の `Gesture`。`pause` だけがホスト側の sleep になる）。
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
 * 座標は正規化 [0,1] で受け、ピクセル変換はこの中だけで行う。
 */
export class AndroidBackend implements InputBackend {
  // mobilecli/adb 経路なので入力経路の表示は WDA 系と同じ（互換モード）。
  readonly kind = 'wda' as const;

  /** これを超えて動いたらドラッグ扱い（px）。Android の touch slop より小さくする。 */
  static readonly SLOP_PX = 12;
  /** 画面サイズが取れないときの代替 slop（正規化）。 */
  static readonly SLOP_NORM = 0.01;
  /** 静止したまま押し続けたら長押しとして down を先出しする閾値（ms）。 */
  static readonly LONG_PRESS_MS = 400;
  /** 1 セッションあたりのエラーログ上限。ドラッグは高頻度パスなので出しすぎない。 */
  static readonly MAX_ERROR_LOGS = 3;

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

  constructor(
    private readonly client: MobileCliClient,
    private readonly deviceId: string,
    private readonly getScreenSize: () => {width: number; height: number} | null,
    /** キー・テキスト・ハードウェアボタンの委譲先（mobilecli 経路は共通）。 */
    private readonly keys: InputBackend
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
   */
  private pump(): Promise<void> {
    if (this.pumping) return this.pumping;
    this.pumping = this.runPump().finally(() => {
      this.pumping = null;
    });
    return this.pumping;
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

      let actions: GestureAction[];
      try {
        actions = this.takeActions();
      } catch (error) {
        // 画面サイズ未取得など。送りようがないので畳んで抜ける
        this.logError(error);
        this.resetPending();
        return;
      }
      if (actions.length === 0) return;

      const hadDown = actions.some((a) => a.type === 'pointerDown');
      try {
        await this.client.gesture(this.deviceId, actions);
      } catch (error) {
        // 失敗しても up は送り切る（指が押しっぱなしで残る方が害が大きい）
        this.logError(error);
      }
      if (hadDown) this.downAckMs = Date.now();
    }
  }

  /**
   * 今すぐ送るぶんのアクションを取り出す（取り出したフラグは落とす）。
   *
   * Android 側は `pointerDown` / `pointerUp` の座標を**直前の `pointerMove`** から取る
   * （mobilecli `devices/android.go`）ので、位置決めの `pointerMove` を必ず先に置く。
   */
  private takeActions(): GestureAction[] {
    const out: GestureAction[] = [];
    let downPx: {x: number; y: number} | null = null;

    if (this.needDown) {
      downPx = this.px(this.start);
      out.push({type: 'pointerMove', duration: 0, x: downPx.x, y: downPx.y});
      out.push({type: 'pointerDown', button: 0});
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
      // down と同じ点なら adb 1 回ぶん無駄なので置かない
      if (!downPx || downPx.x !== p.x || downPx.y !== p.y) {
        out.push({type: 'pointerMove', duration: 0, x: p.x, y: p.y});
      }
      this.needMove = false;
    }

    if (this.needUp) {
      out.push({type: 'pointerUp', button: 0});
      this.needUp = false;
      this.downSent = false;
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

  key(usage: number, down: boolean): Promise<void> {
    return this.keys.key(usage, down);
  }

  modifier(bit: number, down: boolean): Promise<void> {
    return this.keys.modifier(bit, down);
  }

  text(value: string): Promise<void> {
    return this.keys.text(value);
  }

  dispose(): void {
    this.clearPressTimer();
    this.clearHoldTimer();
    const stuck = this.downSent;
    const last = this.last;
    this.resetPending();
    if (!stuck) return;
    // 押しっぱなしの指を残さない（残ると次のタッチが別のジェスチャーになる）。
    // 切断中なので結果は待たない。
    try {
      const p = this.px(last);
      void this.client
        .gesture(this.deviceId, [
          {type: 'pointerMove', duration: 0, x: p.x, y: p.y},
          {type: 'pointerUp', button: 0},
        ])
        .catch(() => {});
    } catch {
      // 画面サイズ未取得なら送りようがない
    }
  }
}
