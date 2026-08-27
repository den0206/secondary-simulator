import {Device} from './types';

/**
 * 自動接続するデバイスを選ぶ。設定が無効・接続済みなら選ばない。
 * 起動中が複数あれば先頭（mobilecli の列挙順）。
 */
export function pickAutoConnectDevice(
  devices: Device[],
  state: {enabled: boolean; currentDeviceId: string | null}
): Device | null {
  if (!state.enabled || state.currentDeviceId) return null;
  return devices.find((d) => d.state === 'Booted') ?? null;
}

/** 探索の基本間隔。デバイスを繋ぐまでの待ちなので短い。 */
export const AUTO_CONNECT_BASE_MS = 5_000;
/** 失敗が続いたときの上限。ここまで空ければ放置しても増え方が緩やかになる。 */
export const AUTO_CONNECT_MAX_MS = 30_000;

/**
 * 連続失敗数から次の探索間隔を決める（5 秒から倍々で最大 30 秒）。
 *
 * mobilecli が入っていない・起動できないマシンでは、この探索が**毎回失敗する**。
 * 5 秒固定のままだと、サイドバーを開いて放置するだけで出力チャンネル
 * （拡張で唯一の無制限バッファ）へ 1 時間に 1,400 行以上が積み上がっていた。
 * `MjpegCapture.reconnectDelayFor` と同じ形で間隔を空ける
 * （CLAUDE.md「リトライループも高頻度パス」）。
 */
export function autoConnectDelayFor(failures: number): number {
  if (!Number.isFinite(failures) || failures <= 0) return AUTO_CONNECT_BASE_MS;
  const delay = AUTO_CONNECT_BASE_MS * 2 ** Math.floor(failures);
  return Math.min(delay, AUTO_CONNECT_MAX_MS);
}
