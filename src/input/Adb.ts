import {execFile} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {promisify} from 'util';

const execFileAsync = promisify(execFile);

/**
 * adb を起こす唯一の入口。
 *
 * mobilecli が面倒を見てくれない操作（タッチの実測 20ms 化・`show_touches`）だけが
 * ここを通る。**adb を生やす場所を 1 か所に閉じ込める**のが目的で、呼び手が増えても
 * 「どこから adb が出ているか」は grep 一発で分かる状態を保つ（CLAUDE.md「守る境界」）。
 *
 * 見つからない・解決できないときは静かに諦める。呼び手は mobilecli 経路へ落とすか、
 * その機能を見送る。
 */

/** 1 往復の待ち上限（ms）。返らない adb で操作全体を止めない。 */
const TIMEOUT_MS = 5000;

/** `ANDROID_HOME` → `ANDROID_SDK_ROOT` → macOS の既定位置 → PATH の順に探す。 */
export function findAdb(): string | null {
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), 'Library', 'Android', 'sdk'),
  ];
  for (const root of roots) {
    if (!root) continue;
    const p = path.join(root, 'platform-tools', 'adb');
    if (fs.existsSync(p)) return p;
  }
  return process.env.PATH ? 'adb' : null;
}

/**
 * mobilecli のデバイス ID を adb のシリアルに直す。
 * mobilecli はエミュレータだけ **AVD 名** を ID に使う（`devices/android.go`）。
 */
export async function resolveSerial(
  adb: string,
  deviceId: string
): Promise<string> {
  const {stdout} = await execFileAsync(adb, ['devices'], {timeout: TIMEOUT_MS});
  const serials = stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 2 && parts[1] === 'device')
    .map((parts) => parts[0]);

  if (serials.includes(deviceId)) return deviceId;
  for (const serial of serials) {
    if (!serial.startsWith('emulator-')) continue;
    const avd = await execFileAsync(adb, ['-s', serial, 'emu', 'avd', 'name'], {
      timeout: TIMEOUT_MS,
    });
    if (avd.stdout.split('\n')[0].trim() === deviceId) return serial;
  }

  throw new Error(`${deviceId} に対応する adb デバイスが無い`);
}

/**
 * `adb -s <serial> <args...>` を 1 回叩いて stdout を返す。
 *
 * 常駐セッション（{@link AdbTouch}）が要らない、単発の設定変更などに使う。
 */
export async function runAdb(
  adb: string,
  serial: string,
  args: string[]
): Promise<string> {
  const {stdout} = await execFileAsync(adb, ['-s', serial, ...args], {
    timeout: TIMEOUT_MS,
  });
  return stdout;
}

/** 単発コマンドを叩く関数。テストから差し替えるためだけに型を切っている。 */
export type AdbRunner = (args: string[]) => Promise<string>;

/**
 * デバイス ID から {@link AdbRunner} を作る。adb が無い・解決できないなら null。
 * 例外は投げない（呼び手は「その機能を見送る」を選べる）。
 */
export async function runnerFor(deviceId: string): Promise<AdbRunner | null> {
  const adb = findAdb();
  if (!adb) return null;
  try {
    const serial = await resolveSerial(adb, deviceId);
    return (args: string[]) => runAdb(adb, serial, args);
  } catch {
    return null;
  }
}
