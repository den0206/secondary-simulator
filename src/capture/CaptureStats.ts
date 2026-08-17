/**
 * 取り込みの実効レート。フッターへ出して「同期が効いているか」を見えるようにする。
 *
 * この拡張はメモリを測れる状態を保っているのに、**同期そのものは測れていなかった**
 * （docs/sync-enhancement.md §2.13）。改善を入れる前に、効果を確かめる手段を用意する。
 *
 * vscode に触らない純粋関数なので単体テストできる（`DeviceStatusBar.renderStatus` と同じ方針）。
 */
export interface CaptureRate {
  /** 拡張ホストが受け取ったフレーム数 / 秒。画面が変わらない間は 0 に近づく（正常）。 */
  fps: number;
  /**
   * webview へ渡したバイト数 / 秒（KB）。**base64 の文字数**で数える。
   * JPEG 本体はこの 3/4 で、実際に転送しているのは base64 の方だから。
   */
  kbps: number;
}

/**
 * 変わったときに取り込みを張り直す必要がある設定。
 *
 * 以前は `secondarySimulator.*` の**どれが変わっても**張り直していた。
 * 拡張自身が `autoConnect` を書き戻す経路が 2 つある（Auto ボタン・Disconnect）ため、
 * **接続中に Auto を押すと画面がいったん切れていた**（docs/sync-enhancement.md §2.8）。
 */
const CAPTURE_KEYS = [
  'secondarySimulator.captureSource',
  'secondarySimulator.captureFps',
  'secondarySimulator.captureMaxWidth',
  'secondarySimulator.streamScale',
  'secondarySimulator.streamQuality',
  'secondarySimulator.directStream',
] as const;

/**
 * 設定変更で取り込みを張り直すべきか。
 *
 * @param affects `vscode.ConfigurationChangeEvent.affectsConfiguration` 相当。
 *   イベントを渡さずに呼ばれた場合（呼び出し元が旧シグネチャ）は、
 *   従来どおり張り直す側に倒す。
 */
export function shouldRestartCapture(
  affects?: (section: string) => boolean
): boolean {
  if (!affects) return true;
  return CAPTURE_KEYS.some((key) => affects(key));
}

/**
 * 集計期間の合計から毎秒あたりへ直す。
 *
 * @param frames 期間中に受け取ったフレーム数
 * @param base64Length 同 base64 の合計文字数
 * @param elapsedMs 期間の長さ。0 以下なら測れていないので 0 を返す
 */
export function captureRate(
  frames: number,
  base64Length: number,
  elapsedMs: number
): CaptureRate {
  if (!(elapsedMs > 0) || !Number.isFinite(elapsedMs)) {
    return {fps: 0, kbps: 0};
  }
  const seconds = elapsedMs / 1000;
  return {
    // 0.1 刻み。静止画面では 0.x fps になるので整数へ丸めない
    fps: Math.round((frames / seconds) * 10) / 10,
    kbps: Math.round(base64Length / 1024 / seconds),
  };
}
