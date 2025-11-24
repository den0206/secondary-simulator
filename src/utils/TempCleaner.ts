import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {Logger} from './Logger';

/**
 * /tmp に残った sim-*.png をクリーンアップするユーティリティ。
 * 旧実装のスクリーンショット一時ファイルが残っている場合の保険。
 */
export class TempCleaner {
  private static readonly PREFIX = 'sim-';
  private static readonly SUFFIX = '.png';
  private static readonly MAX_RETRIES = 3;

  static async cleanOnce(): Promise<void> {
    const dir = os.tmpdir();
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      Logger.debug(`TempCleaner: readdir failed: ${(err as Error).message}`);
      return;
    }

    const targets = entries.filter(
      (name) =>
        name.startsWith(TempCleaner.PREFIX) && name.endsWith(TempCleaner.SUFFIX)
    );

    if (!targets.length) {
      return;
    }

    for (const name of targets) {
      const filePath = path.join(dir, name);
      await TempCleaner.removeWithRetry(filePath, TempCleaner.MAX_RETRIES);
    }
  }

  private static async removeWithRetry(
    filePath: string,
    retries: number
  ): Promise<void> {
    let attempt = 0;
    while (attempt < retries) {
      try {
        await fs.unlink(filePath);
        return;
      } catch (err) {
        attempt++;
        if (attempt >= retries) {
          Logger.debug(
            `TempCleaner: failed to unlink ${filePath} after ${attempt} attempts: ${(err as Error).message}`
          );
        } else {
          // 小さな遅延を入れて再試行
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    }
  }
}
