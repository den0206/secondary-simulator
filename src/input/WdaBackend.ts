import {Logger} from '../utils/Logger';
import {MobileCliClient} from '../utils/MobileCliClient';
import {HidUsage, InputBackend, InputLabel} from './InputBackend';

type Pt = {x: number; y: number; t: number};

/**
 * WDA/mobilecli フォールバックバックエンド。
 *
 * HID 注入が使えない場合（実機・Android・HID 経路の降格時）の従来経路。
 * down/move/up を up まで蓄積し、tap または gesture に変換して送る
 * （＝従来どおり指を離してから反映される。ドラッグ追従はしない）。
 * 座標は正規化で受け取り、screenSize でピクセルへ変換する。
 *
 * ピンチ・単一キー・修飾キーは WDA では表現できないため best-effort（ログのみ/近似）。
 */
export class WdaBackend implements InputBackend {
  readonly kind = 'wda' as const;
  readonly label: InputLabel = 'wda';

  private static readonly TAP_MOVE_THRESHOLD = 0.01; // 正規化。これ未満の移動は tap 扱い
  private static readonly LONG_PRESS_MS = 400; // 静止ホールドは gesture にして long press を維持
  /**
   * 蓄積する軌跡点の上限。touchMove は 60Hz で届くため、上限が無いと
   * 長いドラッグでそのまま伸び、touchUp を取りこぼすと永久に残る
   * （実測: 60 秒のドラッグで 3,601 点・約 190KB の RPC ペイロード）。
   * 超えたら間引くので、上限に達しても始点・終点と所要時間は保たれる。
   */
  private static readonly MAX_POINTS = 240; // 60Hz で約 4 秒ぶん

  private points: Pt[] = [];
  private startMs = 0;

  constructor(
    private readonly client: MobileCliClient,
    private readonly deviceId: string,
    private readonly getScreenSize: () => {width: number; height: number} | null
  ) {}

  private px(x: number, y: number): {x: number; y: number} {
    const s = this.getScreenSize();
    if (!s) {
      throw new Error('画面サイズ未取得のため WDA 経路で座標変換できない');
    }
    return {x: Math.round(x * s.width), y: Math.round(y * s.height)};
  }

  async touchDown(x: number, y: number): Promise<void> {
    this.startMs = Date.now();
    this.points = [{x, y, t: 0}];
  }

  async touchMove(x: number, y: number): Promise<void> {
    if (this.points.length === 0) {
      this.points = [{x, y, t: 0}];
      return;
    }
    this.points.push({x, y, t: Date.now() - this.startMs});
    if (this.points.length > WdaBackend.MAX_POINTS) {
      this.points = WdaBackend.decimate(this.points);
    }
  }

  /**
   * 中間点を 1 つおきに間引いて半分にする。始点と終点は必ず残すので、
   * ドラッグの向き・距離・所要時間（各点の t）は保たれる。
   */
  private static decimate(points: Pt[]): Pt[] {
    const out: Pt[] = [points[0]];
    for (let i = 1; i < points.length - 1; i += 2) {
      out.push(points[i]);
    }
    out.push(points[points.length - 1]);
    return out;
  }

  async touchUp(x: number, y: number): Promise<void> {
    this.points.push({x, y, t: Date.now() - this.startMs});
    const pts = this.points;
    this.points = [];
    if (pts.length === 0) return;

    // 総移動量で tap / gesture を判定。静止でも長押しなら gesture にする
    // （生 pointer 経路では webview が longPress メッセージを送らないため）
    const first = pts[0];
    const last = pts[pts.length - 1];
    const dist = Math.hypot(last.x - first.x, last.y - first.y);
    const holdMs = last.t;
    if (dist < WdaBackend.TAP_MOVE_THRESHOLD && holdMs < WdaBackend.LONG_PRESS_MS) {
      const p = this.px(first.x, first.y);
      await this.client.tap(this.deviceId, p.x, p.y);
      return;
    }

    // gesture へ変換（pointerMove → down → 中間 move → up）
    const actions: Array<{
      type: string;
      duration?: number;
      x?: number;
      y?: number;
      button?: number;
    }> = [];
    const p0 = this.px(pts[0].x, pts[0].y);
    actions.push({type: 'pointerMove', duration: 0, x: p0.x, y: p0.y});
    actions.push({type: 'pointerDown', button: 0});
    for (let i = 1; i < pts.length; i++) {
      const p = this.px(pts[i].x, pts[i].y);
      const dur = Math.max(1, Math.min(pts[i].t - pts[i - 1].t, 500));
      actions.push({type: 'pointerMove', duration: dur, x: p.x, y: p.y});
    }
    actions.push({type: 'pointerUp', button: 0});
    await this.client.gesture(this.deviceId, actions);
  }

  // WDA ではマルチタッチ（ピンチ）を表現できない。1本目だけ追う近似に留める。
  async touch2Down(x: number, y: number): Promise<void> {
    return this.touchDown(x, y);
  }
  async touch2Move(x: number, y: number): Promise<void> {
    return this.touchMove(x, y);
  }
  async touch2Up(x: number, y: number): Promise<void> {
    Logger.debug('WdaBackend: ピンチは非対応（1本指として処理）');
    return this.touchUp(x, y);
  }

  async button(name: 'home' | 'lock'): Promise<void> {
    await this.client.pressButton(this.deviceId, name === 'home' ? 'HOME' : 'POWER');
  }

  // WDA には単一キーの直接注入がない。主要な usage のみ inputText で近似、他は no-op。
  async key(usage: number, down: boolean): Promise<void> {
    if (!down) return;
    const map: Record<number, string> = {
      [HidUsage.Enter]: '\n',
      [HidUsage.Space]: ' ',
      [HidUsage.Tab]: '\t',
      // XCTest の typeText は \b を delete キーとして解釈する
      [HidUsage.Backspace]: '\b',
    };
    const ch = map[usage];
    if (ch) await this.client.inputText(this.deviceId, ch);
    else Logger.debug(`WdaBackend: usage 0x${usage.toString(16)} は非対応`);
  }

  async modifier(): Promise<void> {
    // 修飾キー単独は WDA では扱えない
  }

  async text(value: string): Promise<void> {
    await this.client.inputText(this.deviceId, value);
  }

  dispose(): void {
    this.points = [];
  }
}
