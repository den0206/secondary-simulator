import {captureRate, CaptureRate} from '../capture/CaptureStats';

/**
 * 中継経路のフレームを webview へ渡す。**描画待ちは 1 枚だけ**にし、ack 待ちの
 * あいだに届いたフレームは最新 1 枚へ上書きする（IPC に古い映像を溜めない）。
 *
 * 受け取った枚数とバイト数も数える。`takeRate` が読んで 0 に戻す
 * （増える一方の入れ物にしない）。数える以上のことはしない — 高頻度パスなので。
 */
export class FrameRelay {
  /**
   * ack がこの時間返らなければ次を送る。ack を 1 つ取りこぼすと中継表示が
   * 止まったままになり、`MjpegCapture` の死活監視（端末側のフレーム到着）では拾えない。
   */
  static readonly ACK_TIMEOUT_MS = 1000;

  private pending: string | null = null;
  private inFlight: number | null = null;
  private sentAtMs = 0;
  private seq = 0;
  private count = 0;
  private bytes = 0;
  private lastStatsAtMs = Date.now();

  /** @param post webview へ送る。送り先が無ければ false（フレームは持ったまま）。 */
  constructor(private readonly post: (message: unknown) => boolean) {}

  /** 毎秒 20〜30 回。ログも変換も挟まない。 */
  push(frameBase64: string): void {
    this.count++;
    this.bytes += frameBase64.length;
    this.pending = frameBase64;
    this.flush();
  }

  /** 描画完了の合図。今送っている番号でなければ無視する（古い ack）。 */
  ack(seq: number): void {
    if (seq !== this.inFlight) return;
    this.inFlight = null;
    this.flush();
  }

  /** 取り込みを止めたとき。遅れて届く ack は番号が進んでいるので当たらない。 */
  reset(): void {
    this.pending = null;
    this.inFlight = null;
    this.seq++;
  }

  /** 前回からの受信 fps / 帯域。計測値は必ず 0 に戻す（次の期間と混ぜない）。 */
  takeRate(now = Date.now()): {rate: CaptureRate; elapsedMs: number} {
    const elapsedMs = now - this.lastStatsAtMs;
    const rate = captureRate(this.count, this.bytes, elapsedMs);
    this.count = 0;
    this.bytes = 0;
    this.lastStatsAtMs = now;
    return {rate, elapsedMs};
  }

  private flush(): void {
    if (!this.pending) return;
    const now = Date.now();
    if (this.inFlight !== null && now - this.sentAtMs < FrameRelay.ACK_TIMEOUT_MS) {
      return;
    }
    const seq = this.seq + 1;
    const data = this.pending;
    if (!this.post({type: 'frame', encoding: 'base64', data, seq})) return;
    this.seq = seq;
    this.pending = null;
    this.inFlight = seq;
    this.sentAtMs = now;
  }
}
