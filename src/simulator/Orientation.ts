/**
 * 画面の向きの解釈。
 *
 * 送る側の値は **`portrait` / `landscape` の小文字で確定している** — mobilecli の
 * 検証メッセージが `invalid orientation value '%s', must be 'portrait' or 'landscape'`
 * なので、それ以外は弾かれる。
 *
 * 一方 **`device.io.orientation.get` の応答の形は版に依存する**（生の文字列 /
 * `{orientation}` / `{value}` / 一段深い `{data:{orientation}}`）。ここで受け口を
 * 広げておけば、版が変わっても呼び出し側は触らずに済む
 * （`decodeScreenshotResult` と同じ方針）。
 *
 * `PORTRAIT_UPSIDEDOWN` のような派生も端末側からは返りうるので、**前方一致**で見る。
 * 取り出せなければ `null` を返す — 分からないことを「縦」と決めつけない
 * （トグルの向きが逆になるより、次の向きを推測で決めない方がよい）。
 */

import {Orientation} from '../utils/MobileCliClient';

/** 反対の向き。トグル 1 つで回すために使う。 */
export function flipOrientation(current: Orientation): Orientation {
  return current === 'portrait' ? 'landscape' : 'portrait';
}

function pick(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 文字列 1 つを向きへ。判別できなければ `null`。 */
function parse(value: string): Orientation | null {
  const v = value.trim().toLowerCase();
  // PORTRAIT_UPSIDEDOWN / LANDSCAPE_LEFT なども素の向きへ畳む
  if (v.startsWith('portrait')) return 'portrait';
  if (v.startsWith('landscape')) return 'landscape';
  return null;
}

/**
 * `device.io.orientation.get` の応答（JSON-RPC の result）から向きを取り出す。
 * 想定外の形なら `null`（例外は投げない — 向きが読めないだけで接続は続く）。
 */
export function decodeOrientation(result: unknown): Orientation | null {
  if (typeof result === 'string') return parse(result);
  if (!result || typeof result !== 'object') return null;

  const r = result as Record<string, unknown>;
  const direct =
    pick(r.orientation) ?? pick(r.value) ?? pick(r.result) ?? pick(r.data);
  if (direct) return parse(direct);

  // {data: {orientation: "..."}} のような一段深い形も拾う
  for (const key of ['data', 'device', 'result'] as const) {
    const inner = r[key];
    if (inner && typeof inner === 'object') {
      const o = inner as Record<string, unknown>;
      const nested = pick(o.orientation) ?? pick(o.value);
      if (nested) return parse(nested);
    }
  }
  return null;
}

/** `secondary-simulator-20260819-134501.mp4` のような既定の録画ファイル名。 */
export function defaultRecordingName(
  deviceName: string,
  now: Date = new Date()
): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const safe = deviceName.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');
  return `${safe || 'device'}-${stamp}.mp4`;
}
