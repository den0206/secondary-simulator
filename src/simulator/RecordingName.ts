/**
 * `secondary-simulator-20260819-134501.mp4` のような既定の録画ファイル名。
 *
 * 拡張子は経路で変わる（端末側は mp4、ビュー録画は MediaRecorder が通した
 * コンテナ次第で mp4 / webm）。**中身と合わない拡張子を付けない**ため引数で受ける。
 */
export function defaultRecordingName(
  deviceName: string,
  ext: 'mp4' | 'webm' = 'mp4',
  now: Date = new Date()
): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const safe = deviceName.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');
  return `${safe || 'device'}-${stamp}.${ext}`;
}
