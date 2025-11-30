# MJPEGストリーミング方式への移行ガイド

## 概要

スクリーンショット形式の表示をMJPEGストリーミング方式に完全に書き換えました。これにより、より効率的で低レイテンシな画面表示が可能になります。

## 実装内容

### 1. 新しいクラス

#### `MjpegCapture` (`src/capture/MjpegCapture.ts`)
- mobilecliのMJPEGストリームを使用
- ImageBitmapを使用した効率的な描画
- 既存の`CaptureStrategy`インターフェースを実装

#### `MobileCliServer` (`src/utils/MobileCliServer.ts`)
- mobilecliサーバーの起動・管理
- ポート管理とヘルスチェック
- npx経由での実行もサポート

### 2. 統合方法

#### SimulatorWebviewProvider
- `useMjpegStreaming`設定でMJPEGストリーミングを有効化
- mobilecliサーバーが利用できない場合は、既存の方式にフォールバック

## 使用方法

### 1. 設定を有効化

VSCodeの設定で以下を有効にします：

```json
{
  "secondarySimulator.useMjpegStreaming": true
}
```

### 2. mobilecliのインストール

MJPEGストリーミングを使用するには、mobilecliが必要です：

```bash
# npx経由で自動的にダウンロードされます
# または、拡張機能のassetsディレクトリにmobilecliバイナリを配置
```

### 3. 動作確認

1. デバイスを選択
2. MJPEGストリーミングが有効な場合、自動的にmobilecliサーバーが起動
3. MJPEGストリームが開始され、画面が表示されます

## アーキテクチャ

### 既存の方式（スクリーンショット）
```
Extension Host → ScreenshotCapture → JPEG変換 → Webview
```

### 新しい方式（MJPEGストリーミング）
```
Extension Host → MobileCliServer → mobilecli → MJPEG Stream
                                              ↓
Webview ← ImageBitmap ← MJPEG解析 ← HTTP Stream
```

## メリット

1. **低レイテンシ**: MJPEGストリーミングにより、リアルタイムに近い表示
2. **実機サポート**: mobilecli経由で実機デバイスもサポート
3. **効率的な描画**: ImageBitmapを使用したメモリ効率の良い描画
4. **統一されたAPI**: mobilecli経由でiOS/Androidの操作が統一

## フォールバック

mobilecliサーバーが起動できない場合、または`useMjpegStreaming`が無効な場合、既存のスクリーンショット方式に自動的にフォールバックします。

## トラブルシューティング

### mobilecliサーバーが起動しない

1. `npx @mobilenext/mobilecli --version`でmobilecliが利用可能か確認
2. ポート12000が使用されていないか確認
3. ログを確認（Output: Secondary Simulator）

### MJPEGストリームが表示されない

1. デバイスが起動しているか確認
2. mobilecliサーバーが正常に起動しているか確認
3. ブラウザの開発者ツールでネットワークエラーを確認

## 今後の改善

1. **Webview側での直接接続**: Extension Hostを経由せず、Webviewから直接mobilecliサーバーに接続
2. **ストリーム品質の調整**: フレームレートや解像度の動的調整
3. **エラーハンドリングの改善**: より詳細なエラーメッセージとリカバリー

