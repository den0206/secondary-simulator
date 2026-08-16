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

      const settings = {
        settings: {
          mjpegScalingFactor: Math.round(Math.max(0.1, Math.min(scale, 1)) * 100),
          mjpegServerScreenshotQuality: Math.round(
            Math.max(1, Math.min(quality, 100))
          ),
        },
      };
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
    const ports = new Set<number>();
    for (const line of stdout.split('\n')) {
      if (!/WebDriver/i.test(line)) continue;
      const m = line.match(/:(\d+)\s+\(LISTEN\)/);
      if (m) ports.add(parseInt(m[1], 10));
    }
    for (const port of ports) {
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
