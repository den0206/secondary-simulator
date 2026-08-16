/**
 * 入力バックエンドの抽象。
 *
 * 座標は全て正規化 [0.0, 1.0]。HID 経路はそのまま注入でき、WDA 経路は内部でピクセル変換する。
 * タッチは down/move/up の粒度で受ける:
 *   - HidSidecarBackend はこれをそのまま HID に流し、ドラッグに画面が追従する
 *   - WdaBackend は up まで蓄積し、tap/gesture に変換して送る（従来どおり指を離してから反映）
 *
 * 設計の根拠は docs/sidecar-protocol.md を参照。
 */
export interface InputBackend {
  readonly kind: 'hid' | 'wda';

  // 1本指タッチ
  touchDown(x: number, y: number): Promise<void>;
  touchMove(x: number, y: number): Promise<void>;
  touchUp(x: number, y: number): Promise<void>;

  // 2本指タッチ（ピンチ等）。2点目を伴う
  touch2Down(x: number, y: number, x2: number, y2: number): Promise<void>;
  touch2Move(x: number, y: number, x2: number, y2: number): Promise<void>;
  touch2Up(x: number, y: number, x2: number, y2: number): Promise<void>;

  // ハードウェアボタン
  button(name: 'home' | 'lock'): Promise<void>;

  // キーボード（usage は USB HID usage code、bit は 16..20 の修飾キー）
  key(usage: number, down: boolean): Promise<void>;
  modifier(bit: number, down: boolean): Promise<void>;

  // テキスト入力。ASCII 以外を含む場合の扱いは実装依存（HID は ASCII のみ、非対応分は上位で WDA へ委譲）
  text(value: string): Promise<void>;

  dispose(): void;
}

/** USB HID Keyboard usage page の主要コード（docs/ios-hid-injection.md §6） */
export const HidUsage = {
  Enter: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
} as const;

/** 修飾キーの bit（docs/ios-hid-injection.md §6。16..20 のみ有効） */
export const HidModifier = {
  CapsLock: 16,
  Shift: 17,
  Control: 18,
  Option: 19,
  Command: 20,
} as const;
