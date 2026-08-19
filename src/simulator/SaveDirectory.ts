import * as path from 'path';

/** `secondarySimulator.saveLocation` の値。 */
export type SaveLocation = 'workspace' | 'home' | 'desktop' | 'custom';

/**
 * スクリーンショット・録画の保存ダイアログの初期フォルダ。
 * 実在確認はしない（ダイアログ側に任せる）。
 */
export function resolveSaveDirectory(options: {
  saveLocation: SaveLocation;
  /** `saveLocation` が `custom` のときだけ使う。空なら `home` に落とす。 */
  customPath: string;
  workspaceFolder?: string;
  homeDir: string;
}): string {
  const {saveLocation, customPath, workspaceFolder, homeDir} = options;
  switch (saveLocation) {
    case 'workspace':
      return workspaceFolder ?? homeDir;
    case 'home':
      return homeDir;
    case 'desktop':
      return path.join(homeDir, 'Desktop');
    case 'custom': {
      const trimmed = customPath.trim();
      return trimmed.length > 0 ? trimmed : homeDir;
    }
    default:
      return path.join(homeDir, 'Desktop');
  }
}
