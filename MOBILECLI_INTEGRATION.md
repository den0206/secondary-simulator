# mobilecli統合ガイド

## 概要

mobilecliのみを統合することで、実機デバイスサポートと統一されたAPIを実現しました。既存の`simctl`/`adb`直接実行方式と並行運用が可能です。

## 実装内容

### 1. 新しいクラス

#### `JsonRpcClient` (`src/utils/JsonRpcClient.ts`)
- JSON-RPC 2.0 クライアント実装
- mobilecliサーバーとの通信に使用

#### `MobileCliClient` (`src/utils/MobileCliClient.ts`)
- mobilecliのデバイス操作APIをラップ
- 統一されたインターフェースでデバイス操作を実行

#### `MobileCliServer` (`src/utils/MobileCliServer.ts`)
- mobilecliサーバーの起動・管理
- ポート管理とヘルスチェック

#### `MjpegCapture` (`src/capture/MjpegCapture.ts`)
- MJPEGストリーミング方式のキャプチャ
- mobilecliのMJPEGストリームを使用

### 2. SimulatorWebviewProviderの更新

- `useMobileCli`設定でmobilecli経由の操作を有効化
- デバイス操作（tap, swipe, pressHome, pressBack）をmobilecli経由に統一
- 既存の方式との並行運用が可能

## 使用方法

### 1. 設定を有効化

VSCodeの設定で以下を有効にします：

```json
{
  "secondarySimulator.useMobileCli": true,
  "secondarySimulator.useMjpegStreaming": true
}
```

**注意**: `useMjpegStreaming`が有効な場合、自動的に`useMobileCli`も有効になります。

### 2. mobilecliの準備

mobilecliはnpx経由で自動的にダウンロードされます：

```bash
# 手動で確認する場合
npx @mobilenext/mobilecli --version
```

### 3. 動作確認

1. デバイスを選択
2. mobilecliサーバーが自動的に起動
3. デバイス操作がmobilecli経由で実行される
4. MJPEGストリーミングで画面が表示される

## アーキテクチャ

### 既存の方式（simctl/adb直接実行）
```
Extension Host → SimulatorManager → simctl/adb → デバイス
```

### mobilecli統合方式
```
Extension Host → MobileCliClient → JSON-RPC → MobileCliServer → mobilecli → デバイス
```

## メリット

1. **実機デバイスサポート**: mobilecli経由で実機デバイスもサポート
2. **統一されたAPI**: iOS/Androidの操作が統一されたAPIで実行
3. **並行運用可能**: 既存の方式と並行して使用可能
4. **低レイテンシ**: MJPEGストリーミングによるリアルタイム表示

## フォールバック

mobilecliサーバーが起動できない場合、または`useMobileCli`が無効な場合、既存の`simctl`/`adb`直接実行方式に自動的にフォールバックします。

## 設定オプション

### `secondarySimulator.useMobileCli`
- **型**: `boolean`
- **デフォルト**: `false`
- **説明**: mobilecliを使用してデバイス操作を統一する

### `secondarySimulator.useMjpegStreaming`
- **型**: `boolean`
- **デフォルト**: `false`
- **説明**: MJPEGストリーミングを使用する（mobilecliが必要）

## 実装の詳細

### デバイス操作の統一

すべてのデバイス操作がmobilecli経由で実行されます：

- **タップ**: `MobileCliClient.tap()`
- **スワイプ**: `MobileCliClient.gesture()`
- **ホームボタン**: `MobileCliClient.pressButton('HOME')`
- **バックボタン**: `MobileCliClient.pressButton('BACK')`
- **デバイス一覧**: `MobileCliClient.listDevices()`

### 既存方式との切り替え

設定で`useMobileCli`を変更すると、自動的に適切な方式に切り替わります：

```typescript
// mobilecliを使用する場合
if (this.useMobileCli && this.mobileCliClient) {
  await this.mobileCliClient.tap(deviceId, x, y);
} else {
  // 既存の方式を使用
  await this.currentManager.tap(deviceId, x, y);
}
```

## トラブルシューティング

### mobilecliサーバーが起動しない

1. `npx @mobilenext/mobilecli --version`でmobilecliが利用可能か確認
2. ポート12000が使用されていないか確認
3. ログを確認（Output: Secondary Simulator）

### デバイス操作が動作しない

1. mobilecliサーバーが正常に起動しているか確認
2. デバイスが接続されているか確認
3. フォールバックが発生していないか確認（ログを確認）

## 今後の改善

1. **デバイス管理の統一**: デバイスの起動・停止もmobilecli経由に統一
2. **エラーハンドリングの改善**: より詳細なエラーメッセージとリカバリー
3. **パフォーマンス最適化**: ストリーミング品質の動的調整

