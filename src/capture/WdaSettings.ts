import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Logger} from '../utils/Logger';

const execFileAsync = promisify(execFile);

/**
 * WebDriverAgent の MJPEG 設定を調整して帯域を削減する（iOS のみ・Phase 2）。
 *
 * mobilecli は内部で WDA の MJPEG サーバ（:132xx）を中継しているため、
 * WDA の `mjpegScalingFactor` / `mjpegServerScreenshotQuality` を設定すると
 * 中継されるフレームサイズが小さくなり、直結プロキシの帯域も下がる。
 *
 * WDA の HTTP ポートは可変なので、LISTEN 中のポートを lsof で列挙し `/status` で判別する。
 * 全て best-effort（失敗しても表示は継続する）。
 */
export class WdaSettings {
  /**
   * WDA へ送る値へ丸める（純粋関数なので単体テストできる）。
   *
   * `scale` は WDA では **%**（`mjpegScalingFactor`）で、設定は 0.1〜1.0 の
   * 割合で持っている。設定スキーマが範囲を持っているとはいえ、
   * `settings.json` は手で書けるので**ここでも閉じる** —
   * NaN をそのまま渡すと WDA 側で JSON の `null` になり、
   * 「設定したのに何も変わらない」を無音で作る。
   */
  static clampMjpegSettings(
    scale: number,
    quality: number
  ): {mjpegScalingFactor: number; mjpegServerScreenshotQuality: number} {
    const s = Number.isFinite(scale) ? scale : 1;
    const q = Number.isFinite(quality) ? quality : 100;
    return {
      mjpegScalingFactor: Math.round(Math.max(0.1, Math.min(s, 1)) * 100),
      mjpegServerScreenshotQuality: Math.round(Math.max(1, Math.min(q, 100))),
    };
  }

  /**
   * `lsof -nP -iTCP -sTCP:LISTEN` の出力から WebDriverAgent の LISTEN ポートを拾う。
   *
   * WDA は HTTP と MJPEG の 2 つを開くので**候補は複数返る**（どちらが HTTP かは
   * `/status` に聞いて判別する）。行の形は lsof の版で揺れるため、
   * プロセス名に WebDriver を含む行の `:<port> (LISTEN)` だけを見る。
   */
  static parseListenPorts(stdout: string): number[] {
    const ports = new Set<number>();
    for (const line of stdout.split('\n')) {
      if (!/WebDriver/i.test(line)) continue;
      const m = line.match(/:(\d+)\s+\(LISTEN\)/);
      if (m) ports.add(parseInt(m[1], 10));
    }
    return [...ports];
  }

  /** scale: 0.1〜1.0、quality: 1〜100 */
  static async apply(scale: number, quality: number): Promise<boolean> {
    try {
      const port = await this.findHttpPort();
      if (!port) {
        Logger.debug('WDA HTTP ポートが見つからない（設定調整をスキップ）');
        return false;
      }
      const sessionId = await this.getSessionId(port);
      if (!sessionId) return false;

      const settings = {settings: this.clampMjpegSettings(scale, quality)};
      const res = await fetch(
        `http://localhost:${port}/session/${sessionId}/appium/settings`,
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(settings),
          signal: AbortSignal.timeout(2000),
        }
      );
      Logger.info(
        `WDA MJPEG 設定を適用: scale=${settings.settings.mjpegScalingFactor}%, quality=${settings.settings.mjpegServerScreenshotQuality} (ok=${res.ok})`
      );
      return res.ok;
    } catch (e) {
      Logger.debug(`WDA 設定調整に失敗: ${(e as Error).message}`);
      return false;
    }
  }

  // LISTEN 中の WebDriverAgent のポートを列挙し、/status が応答する HTTP ポートを返す
  private static async findHttpPort(): Promise<number | null> {
    let stdout: string;
    try {
      const r = await execFileAsync('lsof', [
        '-nP',
        '-iTCP',
        '-sTCP:LISTEN',
      ]);
      stdout = r.stdout;
    } catch {
      return null;
    }
    for (const port of this.parseListenPorts(stdout)) {
      try {
        const res = await fetch(`http://localhost:${port}/status`, {
          signal: AbortSignal.timeout(1000),
        });
        if (res.ok) {
          const body = (await res.json()) as {value?: {ready?: boolean}};
          if (body?.value?.ready !== undefined) return port;
        }
      } catch {
        // MJPEG ポート等は /status に応答しない
      }
    }
    return null;
  }

  private static async getSessionId(port: number): Promise<string | null> {
    try {
      const res = await fetch(`http://localhost:${port}/status`, {
        signal: AbortSignal.timeout(1000),
      });
      const body = (await res.json()) as {sessionId?: string};
      return body?.sessionId ?? null;
    } catch {
      return null;
    }
  }
}
