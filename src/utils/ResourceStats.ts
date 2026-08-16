import {execFile} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

export interface ResourceStats {
  /** 拡張ホストプロセス全体の RSS（他拡張と共有）MB */
  rssMb: number;
  /** 拡張ホストの JS ヒープ使用量（同上）MB */
  heapUsedMb: number;
  /** 子プロセス（mobilecli / simhid-server）の RSS 合計 MB */
  childrenMb: number;
  /** 拡張ディレクトリのサイズ MB */
  storageMb: number;
}

// ponytail: 拡張は永続ストレージへ一切書かないので、サイズは起動時に一度測ってキャッシュする。
// 実行時に書き込むようになったら毎回測り直しに変える。
let cachedStorageMb: number | null = null;
let storageInflight: Promise<number> | null = null;

const toMb = (bytes: number): number => Math.round(bytes / 1024 / 102.4) / 10;

// F5 時のリポジトリ直下を全部辿ると .git / 開発用 node_modules で数秒〜数十秒かかる。
// 配布物に入る依存（@mobilenext）だけ node_modules から拾う。
const SKIP_DIRS = new Set(['.git', '.cursor']);

/** ディレクトリの実ファイル合計サイズ。シンボリックリンクは辿らない。 */
export async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, {withFileTypes: true});
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name === 'node_modules') {
        const bundled = path.join(p, '@mobilenext');
        try {
          total += await dirSizeBytes(bundled);
        } catch {
          // 未インストールなら 0
        }
        continue;
      }
      total += await dirSizeBytes(p);
    } else if (entry.isFile()) {
      total += (await fs.stat(p)).size;
    }
  }
  return total;
}

/** ps で子プロセスの RSS 合計を取る（Windows では 0）。 */
async function childrenRssMb(pids: number[]): Promise<number> {
  if (pids.length === 0 || process.platform === 'win32') return 0;
  try {
    const {stdout} = await execFileAsync('ps', [
      '-o',
      'rss=',
      '-p',
      pids.join(','),
    ]);
    const kb = stdout
      .split('\n')
      .reduce((sum, line) => sum + (parseInt(line.trim(), 10) || 0), 0);
    return toMb(kb * 1024);
  } catch {
    return 0;
  }
}

export async function collectResourceStats(
  extensionPath: string,
  childPids: number[]
): Promise<ResourceStats> {
  if (cachedStorageMb === null) {
    // 失敗（権限エラーなど）はキャッシュしない。0 を表示して次の tick で測り直す。
    await (storageInflight ??= dirSizeBytes(extensionPath)
      .then((bytes) => (cachedStorageMb = toMb(bytes)))
      .catch(() => 0)
      .finally(() => (storageInflight = null)));
  }
  const mem = process.memoryUsage();
  return {
    rssMb: toMb(mem.rss),
    heapUsedMb: toMb(mem.heapUsed),
    childrenMb: await childrenRssMb(childPids),
    storageMb: cachedStorageMb ?? 0,
  };
}
