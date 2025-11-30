# Mobile Deck リポジトリ分析レポート

## 概要

Mobile Deck (https://github.com/mobile-next/mobiledeck) は、VSCode拡張機能としてAndroid/iOSの実機・エミュレータ・シミュレータをIDE内で表示・制御するツールです。

## アーキテクチャ分析

### 1. コアコンポーネント

#### Mobile CLI Server (`MobileCliServer.ts`)
- **役割**: `@mobilenext/mobilecli` バイナリを起動し、JSON-RPCサーバーとして動作
- **ポート**: デフォルト12000、利用可能なポートを自動検出
- **機能**: デバイス操作をJSON-RPC経由で抽象化

#### Device View Provider (`DeviceViewProvider.ts`)
- **役割**: デバイス表示用のWebviewPanelを管理
- **機能**: デバイス選択、スクリーンストリーミング表示

#### Sidebar View Provider (`SidebarViewProvider.ts`)
- **役割**: サイドバーにデバイスリストを表示
- **機能**: デバイス一覧、接続状態管理

#### Mobile CLI Client (`MobilecliClient.ts`)
- **役割**: JSON-RPCクライアントとしてデバイス操作を実行
- **主要メソッド**:
  - `listDevices()`: デバイス一覧取得
  - `tap()`, `gesture()`, `inputText()`: 入力操作
  - `pressButton()`: ハードウェアボタン操作
  - `takeScreenshot()`: スクリーンショット取得

### 2. ストリーミング方式

#### MJPEGストリーミング
- **実装**: `MjpegStream.ts` クラス
- **方式**: HTTPレスポンスボディからMJPEGストリームを読み取り、ImageBitmapに変換
- **利点**:
  - ブラウザネイティブサポート
  - 低レイテンシ
  - メモリ効率が良い（ImageBitmapを使用）

### 3. デバイスサポート

#### デバイスタイプ
```typescript
enum DeviceType {
  REAL = "real",        // 実機デバイス
  EMULATOR = "emulator", // Androidエミュレータ
  SIMULATOR = "simulator" // iOSシミュレータ
}
```

#### プラットフォーム
- **iOS**: シミュレータ + 実機
- **Android**: エミュレータ + 実機

### 4. 主要機能

1. **リアルタイムスクリーンミラーリング**: MJPEGストリーミング
2. **マルチタッチ・ジェスチャー制御**: タップ、スワイプ、ロングプレス
3. **ハードウェアボタン制御**: Home、Back、App Switch、Power、音量
4. **デバイス管理**: 起動、再起動、シャットダウン
5. **スクリーンショット**: デバッグ用キャプチャ

## 現在のプロジェクトとの比較

### 現在のプロジェクト (secondary-simulator)

| 項目 | 実装方式 |
|------|----------|
| デバイス通信 | 直接 `simctl` / `adb` コマンド実行 |
| キャプチャ方式 | スクリーンショットベース / ストリーミング |
| ストリーミング | H.264 (実験的) / JPEG |
| デバイスサポート | シミュレータ/エミュレータのみ |
| アーキテクチャ | 直接コマンド実行型 |

### Mobile Deck

| 項目 | 実装方式 |
|------|----------|
| デバイス通信 | `@mobilenext/mobilecli` 経由（JSON-RPC） |
| キャプチャ方式 | MJPEGストリーミング |
| ストリーミング | MJPEG（標準） |
| デバイスサポート | シミュレータ/エミュレータ + **実機** |
| アーキテクチャ | 中間サーバー型 |

## 統合の可能性

### ✅ 可能な統合方法

#### 方法1: Mobile CLIを統合する（推奨）

**メリット**:
- 実機デバイスサポートが追加される
- デバイス操作が統一される
- メンテナンスが容易（mobilecliが更新される）

**デメリット**:
- 外部バイナリ依存（`@mobilenext/mobilecli`）
- アーキテクチャの大幅な変更が必要
- ライセンス確認が必要（AGPL-3.0）

**実装手順**:
1. `@mobilenext/mobilecli` パッケージを依存関係に追加
2. `MobileCliServer` を統合
3. `MobilecliClient` を使用してデバイス操作を置き換え
4. MJPEGストリーミングを実装

#### 方法2: UI/UXの良い部分を参考にする

**メリット**:
- 既存アーキテクチャを維持
- 段階的な改善が可能

**参考にできる点**:
- デバイスリストの表示方法
- ストリーミングUIの実装
- ジェスチャー制御のUI

#### 方法3: 実機サポートを独自実装

**メリット**:
- 完全な制御が可能
- 外部依存なし

**デメリット**:
- 実装コストが高い
- iOS実機は複雑（WebDriverAgent等が必要）

### ⚠️ 注意事項

1. **ライセンス**: AGPL-3.0ライセンス
   - ソースコード公開が必要
   - 商用利用時の注意が必要

2. **依存関係**: `@mobilenext/mobilecli` バイナリ
   - プラットフォーム別バイナリが必要
   - バージョン管理が必要

3. **アーキテクチャの違い**:
   - 現在: 直接コマンド実行
   - mobiledeck: JSON-RPCサーバー経由
   - 統合には大幅なリファクタリングが必要

## 推奨アプローチ

### 段階的統合戦略

1. **フェーズ1: 実機サポートの調査**
   - iOS実機: WebDriverAgent等の調査
   - Android実機: ADB over WiFi等の調査

2. **フェーズ2: Mobile CLIの評価**
   - `@mobilenext/mobilecli` の動作確認
   - ライセンス条件の確認
   - パフォーマンステスト

3. **フェーズ3: 統合実装**
   - オプション機能として実装
   - 既存機能との共存
   - 設定で切り替え可能にする

### 具体的な統合ポイント

#### 1. デバイスリストの統合
```typescript
// 現在の実装
const devices = await manager.listDevices();

// Mobile CLI統合後
const client = new MobilecliClient(jsonRpcClient);
const response = await client.listDevices(true);
const devices = response.devices;
```

#### 2. ストリーミングの統合
```typescript
// MJPEGストリーミングの実装
const response = await fetch(`http://localhost:${port}/rpc`, {
  method: 'POST',
  body: JSON.stringify({
    method: 'screencapture',
    params: { format: 'mjpeg', deviceId }
  })
});
```

#### 3. デバイス操作の統合
```typescript
// タップ操作
await client.tap(deviceId, x, y);

// ボタン操作
await client.pressButton(deviceId, 'HOME');
```

## 結論

**統合は可能ですが、以下の点を考慮する必要があります：**

1. ✅ **技術的には可能**: Mobile CLIを使用すれば実機サポートも追加可能
2. ⚠️ **ライセンス確認**: AGPL-3.0の条件を確認
3. 🔄 **アーキテクチャ変更**: 大幅なリファクタリングが必要
4. 📦 **依存関係**: 外部バイナリの管理が必要

**推奨アプローチ**:
- まずはMobile CLIを評価し、実機サポートが必要であれば統合を検討
- UI/UXの良い部分は参考にして段階的に改善

