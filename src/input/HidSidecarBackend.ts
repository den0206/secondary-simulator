import {InputBackend} from './InputBackend';
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

  text(value: string): Promise<void> {
    return this.sidecar.send({cmd: 'text', ...this.dev, value});
  }

  dispose(): void {
    // サイドカープロセスは共有なのでここでは止めない（SimulatorInputController が管理）
  }
}
