# プロジェクト分析レポート

## 概要

このプロジェクトは、VSCode/Cursorの拡張機能として、iOS/Androidシミュレータをサイドバーに表示し、操作できる機能を実装しています。

## プロジェクト構造

```
secondary-simulator/
├── src/
│   ├── extension.ts                    # 拡張機能のエントリーポイント
│   ├── simulator/
│   │   ├── SimulatorManager.ts         # 抽象基底クラス
│   │   ├── IOSSimulator.ts             # iOS実装
│   │   ├── AndroidEmulator.ts          # Android実装
│   │   └── types.ts                    # 型定義
│   ├── webview/
│   │   └── SimulatorWebviewProvider.ts # Webview管理（802行）
│   ├── capture/
│   │   ├── ScreenshotCapture.ts        # スクリーンキャプチャ管理
│   │   └── FrameBuffer.ts               # フレーム差分検出
│   └── utils/
│       ├── CommandExecutor.ts          # コマンド実行（セキュリティ対策付き）
│       └── Logger.ts                   # ログ管理
├── out/                                # コンパイル済みファイル
├── package.json                        # プロジェクト設定
├── tsconfig.json                       # TypeScript設定
└── TESTING.md                          # テスト手順書
```

## 実装状況

### ✅ 実装済み機能

#### 1. 基本機能
- ✅ 拡張機能のエントリーポイント (`extension.ts`)
- ✅ WebviewViewProviderによるサイドバー表示
- ✅ iOS/Androidシミュレータの検出
- ✅ デバイス一覧の取得と表示

#### 2. スクリーンキャプチャ
- ✅ 定期的なスクリーンショット取得
- ✅ 画像のリサイズ・圧縮（sharp使用）
- ✅ Base64エンコードしてWebviewに送信
- ✅ フレーム差分検出による最適化
- ✅ 適応的リフレッシュレート

#### 3. ユーザー操作
- ✅ タップ操作（マウス/タッチ）
- ✅ スワイプ操作
- ✅ キーボード入力
- ✅ ホームボタン
- ✅ 戻るボタン（Androidのみ）

#### 4. ユーティリティ
- ✅ コマンド実行（セキュリティ対策付き）
- ✅ ログ出力（VSCode Output Channel）
- ✅ エラーハンドリング

#### 5. 設定
- ✅ リフレッシュ間隔の設定
- ✅ 画像品質の設定
- ✅ 最大表示幅の設定
- ✅ 適応的リフレッシュの有効/無効

### 📋 実装の詳細

#### SimulatorManager（抽象クラス）
- `listDevices()`: デバイス一覧取得
- `boot()`: デバイス起動
- `shutdown()`: デバイス停止
- `takeScreenshot()`: スクリーンショット取得
- `getScreenInfo()`: 画面情報取得
- `tap()`: タップ操作
- `swipe()`: スワイプ操作
- `pressHome()`: ホームボタン
- `pressBack()`: 戻るボタン
- `isAvailable()`: 利用可能性チェック

#### IOSSimulator
- `xcrun simctl`コマンドを使用
- AppleScript/JXAでタップ・スワイプ操作
- スクリーン情報のキャッシュ機能

#### AndroidEmulator
- `adb`コマンドを使用
- 直接的なタップ・スワイプ操作
- スクリーン情報のキャッシュ機能

#### ScreenshotCapture
- 定期的なキャプチャスケジューリング
- 画像処理（リサイズ・JPEG圧縮）
- FPS・レイテンシ統計
- フレームバッファによる差分検出

#### FrameBuffer
- MD5ハッシュによるフレーム差分検出
- 適応的リフレッシュレート調整
- 変更がない場合の送信スキップ

#### CommandExecutor
- ホワイトリスト方式のコマンド制限
- 引数のサニタイズ
- タイムアウト設定
- バイナリ出力対応

## 技術スタック

- **言語**: TypeScript
- **フレームワーク**: VSCode Extension API
- **画像処理**: sharp (v0.34.5)
- **ビルドツール**: TypeScript Compiler

## 設定項目

```json
{
  "secondarySimulator.refreshInterval": 500,      // リフレッシュ間隔（ms）
  "secondarySimulator.imageQuality": 70,          // JPEG品質（10-100）
  "secondarySimulator.maxWidth": 320,             // 最大表示幅（px）
  "secondarySimulator.adaptiveRefresh": true        // 適応的リフレッシュ
}
```

## コマンド

- `simulator.selectDevice`: デバイス選択
- `simulator.startCapture`: キャプチャ開始
- `simulator.stopCapture`: キャプチャ停止
- `simulator.takeScreenshot`: スクリーンショット保存
- `simulator.home`: ホームボタン
- `simulator.back`: 戻るボタン
- `simulator.refresh`: デバイス一覧更新

## アーキテクチャの特徴

### 1. セキュリティ対策
- コマンドのホワイトリスト制限
- 引数のサニタイズ
- タイムアウト設定

### 2. パフォーマンス最適化
- フレーム差分検出による送信スキップ
- 適応的リフレッシュレート
- 画像のリサイズ・圧縮
- メモリ管理（バッファのクリア）

### 3. エラーハンドリング
- 各操作でのtry-catch
- ログ出力
- ユーザーへのエラーメッセージ表示

### 4. プラットフォーム対応
- iOS: macOS専用（AppleScript/JXA使用）
- Android: クロスプラットフォーム（adb使用）

## 課題・改善点

### 1. iOSのタップ操作
- 現在: AppleScriptでSimulatorウィンドウを操作
- 課題: ウィンドウ位置・サイズの取得が複雑
- 改善案: `xcrun simctl io`の`tap`コマンドを直接使用できないか検討

### 2. Androidエミュレータの起動
- 現在: `boot()`メソッドが未実装
- 改善案: `emulator -avd <name>`コマンドの実装

### 3. エラーメッセージ
- 現在: ログに出力
- 改善案: ユーザーへの通知を強化

### 4. テスト
- 現在: 手動テスト手順書のみ
- 改善案: 自動テストの追加

## コード品質

### 良い点
- ✅ TypeScriptの型安全性
- ✅ 適切なエラーハンドリング
- ✅ セキュリティ対策
- ✅ パフォーマンス最適化
- ✅ ログ出力

### 改善の余地
- ⚠️ 一部のメソッドが長い（SimulatorWebviewProvider.ts: 802行）
- ⚠️ コメントが少ない
- ⚠️ ユニットテストがない

## 次のステップ

### 優先度: 高
1. iOSのタップ操作の改善（`xcrun simctl io tap`の使用検討）
2. Androidエミュレータの起動機能実装
3. エラーメッセージの改善

### 優先度: 中
4. コードのリファクタリング（長いメソッドの分割）
5. コメントの追加
6. ユニットテストの追加

### 優先度: 低
7. 録画機能の追加
8. 複数デバイス同時表示
9. ショートカットキーの追加

## まとめ

プロジェクトは**ほぼ完成**しており、基本的な機能はすべて実装されています。コード品質も高く、セキュリティ対策やパフォーマンス最適化も適切に実装されています。

主な改善点は、iOSのタップ操作の最適化と、Androidエミュレータの起動機能の実装です。

