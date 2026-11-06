import {autoConnectDelayFor} from '../simulator/autoConnect';
import {Logger} from '../utils/Logger';

/**
 * デバイス一覧を定期的に取り直すタイマーと、失敗が続いたときの絞り込み。
 *
 * 間隔は連続失敗数で伸びる（`autoConnectDelayFor`）。伸びたときはタイマーを
 * 張り直す —— mobilecli が起動できない環境で 5 秒ごとに失敗し続けると、
 * ログも webview へのエラー送信も止まらないため。
 */
export class DevicePoller {
  /** 失敗を記録し続ける回数。これを超えたら黙る（出力チャンネルは消えない）。 */
  static readonly MAX_ERROR_LOGS = 3;

  private timer: ReturnType<typeof setInterval> | null = null;
  /** 今のタイマーに使っている間隔。失敗で伸びたら張り直す合図になる。 */
  delayMs = 0;
  /** 一覧の取得に連続して失敗した回数。1 回でも成功したら 0 に戻す。 */
  failures = 0;
  /**
   * 直近に webview へ送った「一覧が取れない」の文言。同じものを送り直さない。
   *
   * **この探索の失敗だけを対象にする。** `sendError` 全体で畳むと、いちど画面が
   * 出て（フレームが届いてオーバーレイが消えて）から同じ失敗が再発したときに、
   * 何も表示されないまま黙ることになる。
   */
  private lastError: string | null = null;

  constructor(
    private readonly tick: () => void,
    private readonly sendError: (text: string) => void
  ) {}

  get running(): boolean {
    return this.timer !== null;
  }

  /**
   * 回すべきかに合わせてタイマーを張る・止める。
   * @returns 回り始めたら 'started'、止めたら 'stopped'、何もしなければ null
   *   （間隔だけ張り直したときも 'started'）。
   */
  sync(wanted: boolean): 'started' | 'stopped' | null {
    const delay = autoConnectDelayFor(this.failures);
    // 回っていないときに間隔だけ比べない（毎回止める側へ落ちて searching を送り直す）
    if (wanted === this.running && (!this.running || delay === this.delayMs)) {
      return null;
    }
    this.stop();
    if (!wanted) return 'stopped';
    this.delayMs = delay;
    this.timer = setInterval(this.tick, delay);
    return 'started';
  }

  stop(): void {
    this.delayMs = 0;
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** 1 回でも取れたら間隔もログも元に戻す。 */
  succeeded(): void {
    this.failures = 0;
    this.lastError = null;
  }

  /**
   * 一覧の取得に失敗したときの記録。**失敗が続く間は黙る。**
   *
   * 出力チャンネルは全文がメモリに残り、拡張から古い行を捨てる手段が無い
   * （`docs/project-review.md` §3.5.7）。記録するのは最初の数回だけにし、
   * 間隔そのものは `sync` が伸ばす。
   */
  failed(logMessage: string, error: Error, userText: string): void {
    this.failures++;
    if (this.failures <= DevicePoller.MAX_ERROR_LOGS) {
      Logger.error(logMessage, error);
    }
    // 同じ失敗を 5 秒ごとに送り直しても表示は変わらない（往復が増えるだけ）
    if (userText === this.lastError) return;
    this.lastError = userText;
    this.sendError(userText);
  }

  /** 次の失敗を必ず出す（webview の作り直し・明示的な更新）。 */
  forgetError(): void {
    this.lastError = null;
  }
}
