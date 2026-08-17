import * as vscode from 'vscode';

export class Logger {
  private static outputChannel: vscode.OutputChannel | null = null;

  static initialize(): void {
    if (!Logger.outputChannel) {
      Logger.outputChannel = vscode.window.createOutputChannel('Secondary Simulator');
    }
  }

  static info(message: string): void {
    Logger.log('INFO', message);
  }

  static warn(message: string): void {
    Logger.log('WARN', message);
  }

  static error(message: string, error?: Error): void {
    Logger.log('ERROR', message);
    if (error) {
      Logger.log('ERROR', error.stack || error.message);
    }
  }

  static debug(message: string): void {
    Logger.log('DEBUG', message);
  }

  private static log(level: string, message: string): void {
    if (!Logger.outputChannel) {
      Logger.initialize();
    }
    const timestamp = new Date().toISOString();
    Logger.outputChannel!.appendLine(`[${timestamp}] [${level}] ${message}`);
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
  }
}
