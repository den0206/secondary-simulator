/**
 * 入力バックエンドの抽象。
 *
 * 座標は全て正規化 [0.0, 1.0]。HID 経路はそのまま注入でき、ピクセル変換は各バックエンドの内側。
 * タッチは down/move/up の粒度で受ける:
 *   - HidSidecarBackend はこれをそのまま HID に流し、ドラッグに画面が追従する
 *   - AndroidBackend は押しているあいだ最新点を送り、内部でピクセルへ直す
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

/** webview から届く修飾キー名 → bit。未知の名前は無視する。 */
export const MODIFIER_BITS: Readonly<Record<string, number>> = {
  shift: HidModifier.Shift,
  control: HidModifier.Control,
  option: HidModifier.Option,
  command: HidModifier.Command,
};

/**
 * ASCII 1 文字 → USB HID usage code。対応しない文字は undefined。
 *
 * `native/simhid-server.m` の `usageForChar` と同じ表を持つ。表を二重に持つのは、
 * **修飾キー付きの組み合わせ（Cmd+A 等）に `text` コマンドを使えない**ため。
 * `text` はバースト先頭の取りこぼし対策として Shift の捨てイベントを先に送るので、
 * Cmd を押したまま呼ぶと Cmd+Shift の組み合わせが成立してしまう。
 * 組み合わせは keyDown/keyUp で送る必要があり、usage は拡張ホスト側で決める。
 */
export function usageForAsciiChar(
  ch: string
): {usage: number; shift: boolean} | undefined {
  if (ch.length !== 1) return undefined;
  const c = ch.charCodeAt(0);
  const A = 'A'.charCodeAt(0);
  const a = 'a'.charCodeAt(0);
  if (c >= a && c <= a + 25) return {usage: 4 + (c - a), shift: false};
  if (c >= A && c <= A + 25) return {usage: 4 + (c - A), shift: true};
  if (ch >= '1' && ch <= '9') {
    return {usage: 0x1e + (c - '1'.charCodeAt(0)), shift: false};
  }
  const fixed: Record<string, number> = {
    '0': 0x27,
    ' ': 0x2c,
    '\n': 0x28,
    '\t': 0x2b,
    '-': 0x2d,
    '.': 0x37,
    ',': 0x36,
    '/': 0x38,
    ';': 0x33,
  };
  const usage = fixed[ch];
  return usage === undefined ? undefined : {usage, shift: false};
}
