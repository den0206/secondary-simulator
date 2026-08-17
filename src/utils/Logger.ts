import * as vscode from 'vscode';

export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug';

/** 数が大きいほど詳しい。閾値以下のものだけを書き出す。 */
const SEVERITY: Record<LogLevel, number> = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const DEFAULT_LEVEL: LogLevel = 'info';

export class Logger {
  private static outputChannel: vscode.OutputChannel | null = null;
  /**
   * 設定の写し。log() は高頻度パス（メッセージ受信ごと）から呼ばれるので、
   * 毎回 getConfiguration せずここを見る。設定変更時に refreshLevel() で更新する。
   */
  private static currentLevel: LogLevel = DEFAULT_LEVEL;

  static initialize(): void {
    if (!Logger.outputChannel) {
      Logger.outputChannel = vscode.window.createOutputChannel(
        'Secondary Simulator'
      );
    }
    Logger.refreshLevel();
  }

  /**
   * `secondarySimulator.logLevel` を読み直す。設定変更時に extension.ts が呼ぶ。
   *
   * OutputChannel は VS Code が全文をメモリに持ち、古い行を捨てる API が無い
   * （docs/project-review.md §3.5.7）。書く量を絞れるのがこの設定の役目で、
   * 既定を info にして debug を落とすのが効き所。
   */
  static refreshLevel(): void {
    const configured = vscode.workspace
      .getConfiguration('secondarySimulator')
      .get<string>('logLevel', DEFAULT_LEVEL);
    Logger.currentLevel = Logger.normalizeLevel(configured);
  }

  static get level(): LogLevel {
    return Logger.currentLevel;
  }

  /** 未知の値は既定へ倒す（設定を手書きされても落ちないように）。 */
  private static normalizeLevel(value: string | undefined): LogLevel {
    return value !== undefined && value in SEVERITY
      ? (value as LogLevel)
      : DEFAULT_LEVEL;
  }

  static info(message: string): void {
    Logger.log('info', message);
  }

  static warn(message: string): void {
    Logger.log('warn', message);
  }

  static error(message: string, error?: Error): void {
    Logger.log('error', message);
    if (error) {
      Logger.log('error', error.stack || error.message);
    }
  }

  static debug(message: string): void {
    Logger.log('debug', message);
  }

  /** 書き出すかどうか。呼び出し側が文字列を組み立てる前に判定したいとき用。 */
  static isEnabled(level: LogLevel): boolean {
    return SEVERITY[level] <= SEVERITY[Logger.currentLevel];
  }

  private static log(level: Exclude<LogLevel, 'off'>, message: string): void {
    // 閾値の判定を先に済ませる。off のときは OutputChannel すら作らない。
    if (!Logger.isEnabled(level)) return;
    if (!Logger.outputChannel) {
      Logger.initialize();
    }
    const timestamp = new Date().toISOString();
    Logger.outputChannel!.appendLine(
      `[${timestamp}] [${level.toUpperCase()}] ${message}`
    );
  }

  static show(): void {
    Logger.outputChannel?.show();
  }

  /**
   * 出力チャンネルを空にする。
   *
   * OutputChannel の中身は VS Code がメモリに保持し、古い行を捨てる API が無い。
   * 拡張側で減らす手段はこれだけなので、コマンドとして導線を出している
   * （docs/project-review.md §3.5.7）。
   */
  static clear(): void {
    Logger.outputChannel?.clear();
  }

  static dispose(): void {
    Logger.outputChannel?.dispose();
    Logger.outputChannel = null;
    Logger.currentLevel = DEFAULT_LEVEL;
  }
}
