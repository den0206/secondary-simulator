/**
 * webview から届いたメッセージの値を、型を確かめてから取り出す関数群。
 *
 * webview は自分たちの JS だが、`postMessage` の中身は構造化クローンなので
 * **何が入っていても型としては `unknown`** で、`as string` で受けると
 * そのまま mobilecli の params や `Buffer.from(data, 'base64')` へ流れる。
 * webview だけが作り直される経路（レンダラのクラッシュ・リロード）や、
 * 拡張の版と webview の版がずれた状態は実際に起きるので、境界で確かめて
 * 揃わないものは捨てる。
 *
 * `vscode` に触らないので、ここだけを単体テストできる
 * （`test/webview-message.test.js`）。
 */

/** 空でない文字列だけを通す。 */
export function asText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 有限の数値だけを通す（NaN / Infinity / 数字の文字列は落とす）。 */
export function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 0 以上の整数だけを通す（連番・幅などの「個数」向け）。 */
export function asIndex(value: unknown): number | null {
  const n = asFiniteNumber(value);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
}

/** 正の有限数だけを通す（表示幅など、0 では意味を持たない値向け）。 */
export function asPositiveNumber(value: unknown): number | null {
  const n = asFiniteNumber(value);
  return n !== null && n > 0 ? n : null;
}

/** 真偽値だけを通す（`'true'` や 1 は落とす）。 */
export function asFlag(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/**
 * 文字列だけの配列を通す。1 つでも文字列でない要素があれば落とす
 * （修飾キーの一覧のように、部分的に受けると意味が変わるもの向け）。
 */
export function asTextArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((v) => typeof v === 'string') ? (value as string[]) : null;
}
