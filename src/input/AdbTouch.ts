import {ChildProcess, execFile, spawn} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {promisify} from 'util';
import {Logger} from '../utils/Logger';

const execFileAsync = promisify(execFile);

/**
 * Android のタッチだけを `adb shell` の常駐セッションへ流す送信口。
 *
 * mobilecli の `device.io.gesture` は **1 アクションごとに `adb` を起動し直す**
 * （`devices/android.go`）。実測（Pixel 9 エミュレータ）では
 *
 * - `adb shell input touchscreen motionevent …` 単発 … 約 70ms
 * - 同じ `adb shell` の中で 2 回目以降 … 約 15〜20ms
 *
 * ＝ 費用のほとんどは `input` ではなく **adb の起動と往復**。ドラッグ中は
 * 「前の adb が返るまで次を出さない」ので、この差がそのままサンプリング周期
 * （14Hz と 45Hz）になる。ここでは `adb shell` を 1 本張りっぱなしにして、
 * 行を書き込むだけで済むようにする。
 *
 * ついでに mobilecli 経由では避けられなかった無駄も落ちる:
 * `input touchscreen motionevent DOWN|UP` は座標を引数に取れるのに、mobilecli は
 * 直前の `pointerMove` からしか座標を取れない。とくに指を離すとき、同じ座標の
 * MOVE を 1 回挟んでから UP になるため、**離す直前に「止まっている時間」が生まれ**
 * VelocityTracker の速度が落ちる（＝フリックが弱くなる）。
 *
 * 起動・解決に失敗したら黙って死ぬ。呼び手（{@link AndroidBackend}）は
 * mobilecli 経路へ戻すだけでよい。
 */
export class AdbTouch {
  /** 1 コマンドの完了目印。stdout にこれが出るまでを 1 往復とする。 */
  private static readonly MARK = '<<ss>>';
  /** 目印以外の出力（input のエラーなど）が溜まり続けないための上限。 */
  private static readonly MAX_BUF = 4096;
  /** 応答待ちの上限。これを超えたら詰まっているので諦める。 */
  private static readonly MAX_PENDING = 8;

  private proc: ChildProcess | null = null;
  private starting: Promise<boolean> | null = null;
  private buf = '';
  private pending: Array<() => void> = [];
  private dead = false;

  constructor(private readonly deviceId: string) {}

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /** もう使えない（起動に失敗した／落ちた）。呼び手は mobilecli へ戻す。 */
  get isDead(): boolean {
    return this.dead;
  }

  /**
   * `input touchscreen motionevent …` を 1 往復で送る。
   * 送れたら true、使えないなら false（呼び手が mobilecli へ落とす）。
   */
  async send(commands: string[]): Promise<boolean> {
    if (this.dead || commands.length === 0) return false;
    if (!(await this.start())) return false;
    if (this.pending.length >= AdbTouch.MAX_PENDING) {
      this.kill('adb shell の応答が滞留した');
      return false;
    }
    const proc = this.proc;
    if (!proc?.stdin?.writable) {
      this.kill('adb shell の stdin が閉じている');
      return false;
    }
    const done = new Promise<void>((resolve) => this.pending.push(resolve));
    proc.stdin.write(`${commands.join(';')};echo '${AdbTouch.MARK}'\n`);
    await done;
    return !this.dead;
  }

  dispose(): void {
    this.kill('');
  }

  // ---- 常駐セッション ------------------------------------------------------

  /** 未起動なら `adb -s <serial> shell` を立ち上げる。多重呼び出しは 1 本に畳む。 */
  private start(): Promise<boolean> {
    if (this.proc) return Promise.resolve(true);
    if (!this.starting) {
      this.starting = this.spawnShell().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async spawnShell(): Promise<boolean> {
    if (this.dead) return false;
    const adb = AdbTouch.findAdb();
    if (!adb) {
      this.kill('adb が見つからない');
      return false;
    }
    let serial: string;
    try {
      serial = await AdbTouch.resolveSerial(adb, this.deviceId);
    } catch (error) {
      this.kill(`adb のシリアル解決に失敗: ${(error as Error).message}`);
      return false;
    }

    const proc = spawn(adb, ['-s', serial, 'shell'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    proc.on('error', () => this.kill('adb shell の起動に失敗'));
    proc.on('exit', () => this.kill('adb shell が終了した'));
    this.proc = proc;
    Logger.info(`Android のタッチを adb shell 常駐セッションで送る（${serial}）`);
    return true;
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const i = this.buf.indexOf(AdbTouch.MARK);
      if (i < 0) break;
      this.buf = this.buf.slice(i + AdbTouch.MARK.length);
      this.pending.shift()?.();
    }
    // 目印を含まない出力（input のエラーなど）で伸び続けさせない
    if (this.buf.length > AdbTouch.MAX_BUF) {
      this.buf = this.buf.slice(-AdbTouch.MARK.length);
    }
  }

  /** 二度と使わない状態にして、待っている送信を全部起こす。 */
  private kill(reason: string): void {
    if (reason && !this.dead) {
      Logger.warn(`Android の adb 常駐セッションを閉じる: ${reason}`);
    }
    this.dead = true;
    const proc = this.proc;
    this.proc = null;
    this.buf = '';
    const waiting = this.pending;
    this.pending = [];
    for (const resolve of waiting) resolve();
    proc?.stdin?.end();
    proc?.kill();
  }

  // ---- adb の場所とシリアル ------------------------------------------------

  /** `ANDROID_HOME` → `ANDROID_SDK_ROOT` → macOS の既定位置 → PATH の順に探す。 */
  static findAdb(): string | null {
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
  static async resolveSerial(adb: string, deviceId: string): Promise<string> {
    const {stdout} = await execFileAsync(adb, ['devices'], {timeout: 5000});
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
        timeout: 5000,
      });
      if (avd.stdout.split('\n')[0].trim() === deviceId) return serial;
    }
    throw new Error(`${deviceId} に対応する adb デバイスが無い`);
  }
}
