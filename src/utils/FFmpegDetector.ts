import {CommandExecutor} from './CommandExecutor';
import {Logger} from './Logger';

/**
 * ffmpegの検出とバージョン確認を行うユーティリティ
 */
export class FFmpegDetector {
  private static cachedVersion: string | null = null;
  private static cachedAvailable: boolean | null = null;

  /**
   * ffmpegが利用可能かどうかを確認
   */
  static async isAvailable(): Promise<boolean> {
    if (this.cachedAvailable !== null) {
      return this.cachedAvailable;
    }

    try {
      const {stdout} = await CommandExecutor.execute('ffmpeg', ['-version']);
      this.cachedAvailable = stdout.includes('ffmpeg version');
      if (this.cachedAvailable) {
        const versionMatch = stdout.match(/ffmpeg version ([^\s]+)/);
        if (versionMatch) {
          this.cachedVersion = versionMatch[1];
          Logger.info(`ffmpeg detected: version ${this.cachedVersion}`);
        }
      }
      return this.cachedAvailable;
    } catch {
      this.cachedAvailable = false;
      Logger.debug('ffmpeg is not available');
      return false;
    }
  }

  /**
   * ffmpegのバージョンを取得
   */
  static getVersion(): string | null {
    return this.cachedVersion;
  }

  /**
   * キャッシュをクリア（再検出が必要な場合）
   */
  static clearCache(): void {
    this.cachedVersion = null;
    this.cachedAvailable = null;
  }
}

