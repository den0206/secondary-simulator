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
