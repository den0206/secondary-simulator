/**
 * `device.screenshot` の応答をバイト列へ直す。
 *
 * mobilecli の応答は版によって形が違い（生の base64 文字列 / data URL / `{data}` /
 * `{base64}` 等）、どれで返るかは版に依存する。ここで受け口を広げておけば、
 * 版が変わっても呼び出し側は触らずに済む。
 */

export interface DecodedScreenshot {
  bytes: Uint8Array;
  /** 保存時の拡張子（png / jpg）。判別できなければ要求した形式を使う。 */
  ext: 'png' | 'jpg';
}

const DATA_URL = /^data:image\/(png|jpe?g);base64,(.*)$/i;

/** PNG / JPEG のマジックナンバーから拡張子を決める。 */
function sniff(bytes: Uint8Array, fallback: 'png' | 'jpg'): 'png' | 'jpg' {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return 'jpg';
  }
  return fallback;
}

function fromBase64(value: string): Uint8Array {
  const buf = Buffer.from(value, 'base64');
  if (buf.length === 0) throw new Error('スクリーンショットが空');
  return new Uint8Array(buf);
}

/**
 * 応答本体（JSON-RPC の result）を受け取り、画像バイト列を返す。
 * 想定外の形なら例外を投げる。
 */
export function decodeScreenshotResult(
  result: unknown,
  requestedFormat: 'png' | 'jpeg' = 'png'
): DecodedScreenshot {
  const fallbackExt: 'png' | 'jpg' = requestedFormat === 'jpeg' ? 'jpg' : 'png';

  const pick = (value: unknown): string | null => {
    if (typeof value === 'string' && value.length > 0) return value;
    return null;
  };

  let payload: string | null = null;

  if (typeof result === 'string') {
    payload = result;
  } else if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    payload =
      pick(r.data) ??
      pick(r.base64) ??
      pick(r.image) ??
      pick(r.screenshot) ??
      pick(r.content) ??
      null;

    // {data: {data: "..."}} のような一段深い形も拾う
    if (!payload && r.data && typeof r.data === 'object') {
      const inner = r.data as Record<string, unknown>;
      payload = pick(inner.data) ?? pick(inner.base64) ?? null;
    }
  }

  if (!payload) {
    throw new Error(
      'device.screenshot の応答から画像データを取り出せなかった（応答形式が想定外）'
    );
  }

  const dataUrl = DATA_URL.exec(payload.trim());
  if (dataUrl) {
    const bytes = fromBase64(dataUrl[2]);
    return {bytes, ext: sniff(bytes, dataUrl[1].toLowerCase() === 'png' ? 'png' : 'jpg')};
  }

  const bytes = fromBase64(payload.trim());
  return {bytes, ext: sniff(bytes, fallbackExt)};
}

/** `secondary-simulator-20260816-134501.png` のような衝突しにくい既定名を作る。 */
export function defaultScreenshotName(
  deviceName: string,
  ext: 'png' | 'jpg',
  now: Date = new Date()
): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  // ファイル名に使えない文字を潰す
  const safe = deviceName.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');
  return `${safe || 'device'}-${stamp}.${ext}`;
}
