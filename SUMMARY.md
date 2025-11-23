# 調査結果サマリー

## 結論

**技術的に実現可能です。** ただし、VSCodeの標準APIではセカンダリサイドバー（右側）に直接ビューを追加する方法は提供されていないため、代替方法を使用します。

## 実現方法

### 推奨アプローチ: WebviewPanelを使用

1. **スクリーンキャプチャ方式**
   - iOS: `xcrun simctl io <device-id> screenshot` で定期的にスクリーンショットを取得
   - Android: `adb exec-out screencap -p` で定期的にスクリーンショットを取得
   - 取得した画像をBase64エンコードしてWebviewに送信

2. **表示方法**
   - `WebviewPanel`を使用して、エディタエリアの右側（`vscode.ViewColumn.Beside`）に表示
   - これにより、ユーザーの要望（右側に表示）に最も近い実装が可能

3. **操作機能**
   - ユーザーのクリック/タップ操作を検知
   - 座標を計算してシミュレータに送信（`xcrun simctl io tap` / `adb shell input tap`）

## 技術スタック

- **言語**: TypeScript
- **フレームワーク**: VSCode Extension API
- **主要機能**:
  - `child_process` でコマンド実行
  - `WebviewPanel` でUI表示
  - 定期的なスクリーンキャプチャ（setInterval）

## 制約事項

1. **セカンダリサイドバーへの直接追加は不可**
   - 標準APIではサポートされていない
   - 代替として、エディタエリアの右側に表示（実質的に同じ効果）

2. **プラットフォーム依存**
   - iOSシミュレータはmacOSでのみ利用可能
   - AndroidエミュレータはWindows/macOS/Linuxで利用可能

3. **パフォーマンス**
   - スクリーンキャプチャの頻度を適切に制御する必要がある
   - デフォルト: 1秒ごと（設定可能）

## 次のステップ

1. プロジェクトの初期化（`yo code` など）
2. 基本的な拡張機能の骨組み作成
3. iOSシミュレータの検出・起動機能
4. スクリーンキャプチャ機能
5. WebviewPanelでの表示
6. タップ操作の実装

詳細は `DESIGN.md` と `IMPLEMENTATION_NOTES.md` を参照してください。

