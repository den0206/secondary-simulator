import {ChildProcess, spawn} from 'node:child_process';
import * as fs from 'node:fs';
import {Logger} from '../utils/Logger';

/**
 * simhid-server（HID 注入サイドカー）の常駐プロセスを管理する。
 *
 * - stdin/stdout に JSON Lines（1行=1メッセージ）でやり取りする（docs/sidecar-protocol.md）
 * - 全デバイス1プロセス。コマンドは device(UDID) を含む
 * - ready/fatal/portLost/recovered の通知を監視する
 * - プロセスが死んだら1回だけ再起動を試みる
 */
export interface SidecarCommand {
  cmd: string;
  device?: string;
  [key: string]: unknown;
}

type Pending = {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export class SimhidSidecar {
  private static readonly REQUEST_TIMEOUT_MS = 3000;
  private static readonly READY_TIMEOUT_MS = 5000;
  private static readonly MAX_RESTARTS = 1;

  private proc: ChildProcess | null = null;
  private stdoutBuf = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private restarts = 0;
  private disposed = false;
  private fatalReason: string | null = null;

  /** 復帰不能になったときに呼ばれる（上位が WDA 経路へ降格する） */
  public onFatal?: (reason: string) => void;

  constructor(private readonly binaryPath: string) {}

  isFatal(): boolean {
    return this.fatalReason !== null;
  }

  /** プロセスを起動し ready を待つ。失敗時は例外。 */
  async start(): Promise<void> {
    if (!fs.existsSync(this.binaryPath)) {
      throw new Error(`simhid-server が見つからない: ${this.binaryPath}`);
    }
    await this.spawnAndWaitReady();
  }

  private spawnAndWaitReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const proc = spawn(this.binaryPath, [], {stdio: ['pipe', 'pipe', 'pipe']});
      this.proc = proc;
      this.stdoutBuf = '';

      let settled = false;
      const readyTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('simhid-server の ready がタイムアウト'));
        }
      }, SimhidSidecar.READY_TIMEOUT_MS);

      const onReady = () => {
        if (!settled) {
          settled = true;
          clearTimeout(readyTimer);
          resolve();
        }
      };
      const onFatalEarly = (reason: string) => {
        if (!settled) {
          settled = true;
          clearTimeout(readyTimer);
          reject(new Error(`simhid-server fatal: ${reason}`));
        }
      };

      proc.stdout?.on('data', (chunk: Buffer) =>
        this.onStdout(chunk, onReady, onFatalEarly)
      );
      proc.stderr?.on('data', (chunk: Buffer) =>
        Logger.debug(`[simhid] ${chunk.toString().trimEnd()}`)
      );
      proc.on('exit', (code) => this.onExit(code));
      proc.on('error', (err) => {
        Logger.error('simhid-server 起動エラー', err);
        if (!settled) {
          settled = true;
          clearTimeout(readyTimer);
          reject(err);
        }
      });
    });
  }

  private onStdout(
    chunk: Buffer,
    onReady: () => void,
    onFatalEarly: (reason: string) => void
  ): void {
    this.stdoutBuf += chunk.toString('utf8');
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        Logger.warn(`[simhid] 不正な JSON: ${line}`);
        continue;
      }
      this.dispatch(msg, onReady, onFatalEarly);
    }
  }

  private dispatch(
    msg: Record<string, unknown>,
    onReady: () => void,
    onFatalEarly: (reason: string) => void
  ): void {
    // 応答（id 付き）
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve();
        else p.reject(new Error(String(msg.error ?? 'unknown error')));
      }
      return;
    }
    // 通知（event）
    switch (msg.event) {
      case 'ready':
        Logger.info(`simhid-server ready (pid=${msg.pid})`);
        onReady();
        break;
      case 'fatal':
        this.fatalReason = String(msg.reason ?? 'unknown');
        Logger.error(`simhid-server fatal: ${this.fatalReason}`);
        onFatalEarly(this.fatalReason);
        this.onFatal?.(this.fatalReason);
        break;
      case 'portLost':
        Logger.warn(`simhid-server portLost (device=${msg.device})`);
        break;
      case 'recovered':
        Logger.info(`simhid-server recovered (device=${msg.device})`);
        break;
      default:
        Logger.debug(`[simhid] 未知の通知: ${JSON.stringify(msg)}`);
    }
  }

  private onExit(code: number | null): void {
    Logger.info(`simhid-server プロセス終了 (code=${code})`);
    this.proc = null;
    // 保留中のリクエストを全て失敗させる
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('simhid-server プロセスが終了'));
    }
    this.pending.clear();

    if (this.disposed || this.fatalReason) return;
    if (this.restarts >= SimhidSidecar.MAX_RESTARTS) {
      const reason = 'simhid-server が繰り返し終了';
      this.fatalReason = reason;
      this.onFatal?.(reason);
      return;
    }
    this.restarts++;
    Logger.info(`simhid-server を再起動します (${this.restarts})`);
    this.spawnAndWaitReady().catch((err) => {
      this.fatalReason = err.message;
      this.onFatal?.(err.message);
    });
  }

  /** 応答を待つコマンド送信。ok で resolve、error/timeout で reject。 */
  send(command: SidecarCommand): Promise<void> {
    if (this.fatalReason) {
      return Promise.reject(new Error(`simhid-server fatal: ${this.fatalReason}`));
    }
    const proc = this.proc;
    if (!proc?.stdin) {
      return Promise.reject(new Error('simhid-server が起動していない'));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({id, ...command}) + '\n';
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`simhid コマンド timeout: ${command.cmd}`));
      }, SimhidSidecar.REQUEST_TIMEOUT_MS);
      this.pending.set(id, {resolve, reject, timer});
      proc.stdin!.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  /** 応答を待たない送信（高頻度の touchMove 用。stdin の順序は保たれる）。 */
  sendNoWait(command: SidecarCommand): void {
    if (this.fatalReason || !this.proc?.stdin) return;
    this.proc.stdin.write(JSON.stringify(command) + '\n');
  }

  dispose(): void {
    this.disposed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('disposed'));
    }
    this.pending.clear();
    this.proc?.kill();
    this.proc = null;
  }
}
