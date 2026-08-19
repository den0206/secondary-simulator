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
