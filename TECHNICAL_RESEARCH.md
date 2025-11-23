# 技術調査レポート: VSCode/Cursor拡張機能でのiOS/Androidシミュレータ表示

## 技術的可能性の調査結果

### ✅ 実現可能な要素

1. **ビュー表示（代替方法）**
   - ⚠️ **注意**: VSCodeの標準APIでは、セカンダリサイドバー（右側）に直接ビューを追加する方法は提供されていません
   - **代替案1**: `WebviewPanel`を使用して、エディタエリアの右側（`vscode.ViewColumn.Beside`）に表示
   - **代替案2**: プライマリサイドバー（左側）に`TreeView`や`WebviewView`を追加
   - どちらの方法でも、シミュレータの画面表示と操作は実現可能

2. **シミュレータのスクリーンキャプチャ**
   - **iOS**: `xcrun simctl io <device-id> screenshot` コマンドでスクリーンショット取得可能
   - **Android**: `adb exec-out screencap -p` コマンドでスクリーンショット取得可能
   - 定期的にキャプチャを取得してWebviewに表示可能

3. **シミュレータの制御**
   - **iOS**: `xcrun simctl io <device-id> tap <x> <y>` でタップ操作可能
   - **Android**: `adb shell input tap <x> <y>` でタップ操作可能
   - その他の操作（スワイプ、キー入力など）もコマンドラインから制御可能

4. **Webviewでの表示**
   - VSCodeのWebview APIを使用して、HTML/CSS/JavaScriptでUIを構築可能
   - 画像の表示、インタラクティブな操作（クリック、ドラッグなど）を実装可能

### ⚠️ 制約事項

1. **シミュレータの直接埋め込みは不可**
   - iOS/Androidシミュレータは独立したアプリケーションとして動作
   - VSCode内に直接埋め込むことは技術的に不可能

2. **パフォーマンスへの配慮**
   - スクリーンキャプチャの頻度を適切に制御する必要がある
   - 高頻度のキャプチャはCPU/メモリに負荷をかける

3. **プラットフォーム依存**
   - iOSシミュレータはmacOSでのみ利用可能
   - AndroidエミュレータはWindows/macOS/Linuxで利用可能

## 実現方法

### アプローチ: スクリーンキャプチャ + Webview表示

1. **定期的なスクリーンキャプチャ**
   - バックグラウンドで定期的に（例: 1秒ごと）シミュレータのスクリーンショットを取得
   - 取得した画像をBase64エンコードしてWebviewに送信

2. **Webviewでの表示と操作**
   - **推奨**: `WebviewPanel`を使用して、エディタエリアの右側に表示（`vscode.ViewColumn.Beside`）
   - または、プライマリサイドバーに`WebviewView`を追加
   - ユーザーのクリック/タップ操作を検知し、座標をシミュレータに送信

3. **シミュレータの起動・管理**
   - 利用可能なシミュレータの一覧を取得
   - シミュレータの起動・停止を制御

### 表示方法の選択

#### 方法1: WebviewPanel（推奨）
```typescript
const panel = vscode.window.createWebviewPanel(
  'simulatorView',
  'Simulator',
  vscode.ViewColumn.Beside, // 右側に表示
  { enableScripts: true }
);
```
- ✅ 確実に実装可能
- ✅ 大きな表示領域を確保
- ⚠️ エディタタブとして表示（サイドバーではない）

#### 方法2: WebviewView（プライマリサイドバー）
```typescript
// package.json
"views": {
  "explorer": [{
    "id": "simulatorView",
    "name": "Simulator"
  }]
}
```
- ✅ 標準的な方法
- ✅ サイドバーに表示
- ⚠️ 左側のサイドバーに表示される

## 結論

**技術的に実現可能です。**

スクリーンキャプチャとWebviewを組み合わせることで、セカンダリサイドバーにシミュレータの画面を表示し、操作することが可能です。

