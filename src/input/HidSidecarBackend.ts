import {InputBackend, InputLabel} from './InputBackend';
import {SimhidSidecar} from './SimhidSidecar';

/**
 * HID 直接注入バックエンド。SimhidSidecar に UDID 付きコマンドを流すだけの薄いラッパ。
 * 座標変換は不要（サイドカーが正規化座標を受ける）。
 *
 * 高頻度の touchMove は応答を待たず送る（低レイテンシ・ドラッグ追従）。
 * down/up/button/key/text は応答を待ち、エラーを表面化させる。
 */
export class HidSidecarBackend implements InputBackend {
  readonly kind = 'hid' as const;
  readonly label: InputLabel = 'hid';

  /** 1 回の `text` コマンドで送る文字数。 */
  static readonly TEXT_CHUNK_CHARS = 48;
  /**
   * 1 文字あたりの見積り（ms）。native の `usleep` 合計は 32ms（Shift 付きで 48ms）。
   * 取りこぼしのウォームアップと転送を足して余裕を持たせる。
   */
  static readonly TEXT_MS_PER_CHAR = 60;
  /** 見積りの下駄（ms）。ウォームアップと往復のぶん。 */
  static readonly TEXT_BASE_MS = 1_500;

  /** 文字数から応答待ちの上限を決める（純粋関数。テストはここを見る）。 */
  static textTimeoutMs(length: number): number {
    const chars = Number.isFinite(length) ? Math.max(0, length) : 0;
    return HidSidecarBackend.TEXT_BASE_MS + chars * HidSidecarBackend.TEXT_MS_PER_CHAR;
  }

  constructor(
    private readonly sidecar: SimhidSidecar,
    private readonly deviceId: string
  ) {}

  private get dev(): {device: string} {
    return {device: this.deviceId};
  }

  touchDown(x: number, y: number): Promise<void> {
    return this.sidecar.send({cmd: 'touchDown', ...this.dev, x, y});
  }

  touchMove(x: number, y: number): Promise<void> {
    this.sidecar.sendNoWait({cmd: 'touchMove', ...this.dev, x, y});
    return Promise.resolve();
  }

  touchUp(x: number, y: number): Promise<void> {
    return this.sidecar.send({cmd: 'touchUp', ...this.dev, x, y});
  }

  touch2Down(x: number, y: number, x2: number, y2: number): Promise<void> {
    return this.sidecar.send({cmd: 'touch2Down', ...this.dev, x, y, x2, y2});
  }

  touch2Move(x: number, y: number, x2: number, y2: number): Promise<void> {
    this.sidecar.sendNoWait({cmd: 'touch2Move', ...this.dev, x, y, x2, y2});
    return Promise.resolve();
  }

  touch2Up(x: number, y: number, x2: number, y2: number): Promise<void> {
    return this.sidecar.send({cmd: 'touch2Up', ...this.dev, x, y, x2, y2});
  }

  button(name: 'home' | 'lock'): Promise<void> {
    return this.sidecar.send({cmd: 'button', ...this.dev, name});
  }

  key(usage: number, down: boolean): Promise<void> {
    return this.sidecar.send({cmd: down ? 'keyDown' : 'keyUp', ...this.dev, usage});
  }

  modifier(bit: number, down: boolean): Promise<void> {
    return this.sidecar.send({cmd: 'modifier', ...this.dev, bit, down});
  }

  /**
   * テキストを注入する。**刻んで送り、待ち時間は長さから決める。**
   *
   * サイドカーの `injectText` は 1 文字ずつ同期で待つ（`native/simhid-server.m`。
   * キー down/up の間に 12ms、文字の間に 20ms、Shift が要る文字はさらに ±8ms）。
   * 応答は注入を終えてから返るので、既定の 3 秒では**約 90 文字で必ず timeout する**
   * ——注入は続いているのに上位はエラー表示へ落ちる、という壊れ方になっていた。
   *
   * 刻むのは待ち時間の見積もりを短く保つためだけではない。サイドカーはコマンドを
   * 1 本のキューで捌くので、**長い 1 コマンドはその間タッチも止める**。
   * 1 チャンクぶん（最長でも数秒）で必ず順番が回るようにする。
   */
  async text(value: string): Promise<void> {
    for (let i = 0; i < value.length; i += HidSidecarBackend.TEXT_CHUNK_CHARS) {
      const part = value.slice(i, i + HidSidecarBackend.TEXT_CHUNK_CHARS);
      await this.sidecar.send(
        {cmd: 'text', ...this.dev, value: part},
        HidSidecarBackend.textTimeoutMs(part.length)
      );
    }
  }

  dispose(): void {
    // サイドカープロセスは共有なのでここでは止めない（SimulatorInputController が管理）
  }
}
