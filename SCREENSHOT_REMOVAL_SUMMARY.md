# スクリーンショット形式の描写機能削除サマリー

## 削除内容

スクリーンショット形式でのシミュレータ描写機能を完全に削除し、MJPEGストリーミング方式のみに統一しました。

### 削除されたファイル

1. **`src/capture/ScreenshotCapture.ts`**
   - スクリーンショットベースのキャプチャ実装
   - 定期的にスクリーンショットを取得してJPEGに変換

2. **`src/capture/StreamingCapture.ts`**
   - 高速スクリーンショット方式のストリーミング実装
   - ScreenshotCaptureの高速版

3. **`src/capture/FrameBuffer.ts`**
   - フレームバッファ管理（ScreenshotCaptureのみで使用）

### 削除された設定項目

`package.json`から以下の設定を削除：

- `secondarySimulator.refreshInterval` - スクリーンショット更新間隔
- `secondarySimulator.imageQuality` - JPEG圧縮品質
- `secondarySimulator.adaptiveRefresh` - 適応的リフレッシュレート
- `secondarySimulator.captureMode` - キャプチャモード（screenshot/streaming）
- `secondarySimulator.streamingFps` - ストリーミングFPS
- `secondarySimulator.streamingLowLatency` - 低遅延モード

### 削除されたUI要素

- `media/webview/index.html`からキャプチャモード選択ドロップダウンを削除
- `media/webview/main.js`からキャプチャモード関連のイベントハンドラを削除

### 変更されたコード

#### SimulatorWebviewProvider.ts

- `ScreenshotCapture`と`StreamingCapture`のimportを削除
- `currentManager`プロパティを削除（mobilecli経由の操作に統一）
- `createCaptureInstance()`メソッドを簡素化（MJPEGストリーミングのみ）
- `handleCaptureModeChange()`メソッドを無効化（モード変更不要）
- デバイス操作（tap, swipe等）をmobilecli経由に統一（フォールバックあり）

## 現在の実装

### キャプチャ方式

**MJPEGストリーミングのみ**を使用：
- `MjpegCapture`クラスを使用
- mobilecliサーバー経由でMJPEGストリームを取得
- ImageBitmapを使用した効率的な描画

### デバイス操作

**mobilecli経由**で統一：
- タップ、スワイプ、ロングプレス
- ホームボタン、バックボタン
- キー入力
- スクリーンショット保存

**フォールバック**：
- mobilecliが使えない場合、既存の`IOSSimulator`/`AndroidEmulator`を使用
- デバイスリスト取得も同様にフォールバック対応

## メリット

1. **コードの簡素化**: スクリーンショット方式の複雑なロジックを削除
2. **統一されたAPI**: mobilecli経由でiOS/Androidの操作が統一
3. **実機サポート**: mobilecli経由で実機デバイスもサポート
4. **低レイテンシ**: MJPEGストリーミングによるリアルタイム表示

## 注意事項

- **mobilecliが必須**: MJPEGストリーミングを使用するにはmobilecliが必要
- **フォールバック**: mobilecliが使えない場合、デバイス操作は既存の方式にフォールバック
- **設定の変更**: 以前のキャプチャモード関連の設定は無効になりました

## 移行ガイド

以前の設定を使用していた場合：

1. `useMobileCli`と`useMjpegStreaming`を有効化
2. キャプチャモード選択UIは削除されました（常にMJPEGストリーミング）
3. 不要になった設定項目は無視されます

