# Secondary Simulator - Claude Code Guide

## プロジェクト概要

VSCode/Cursor のサイドバーに iOS/Android シミュレータの画面をリアルタイム表示する拡張機能。

## 技術スタック

- **言語**: TypeScript
- **ランタイム**: Node.js (VSCode Extension Host)
- **画像処理**: sharp (リサイズ・圧縮)
- **ビルド**: tsc

## プロジェクト構造

```
src/
├── extension.ts              # エントリーポイント
├── webview/
│   ├── SimulatorWebviewProvider.ts  # Webview 管理
│   └── webview.html          # UI テンプレート
├── simulator/
│   ├── types.ts              # 型定義
│   ├── SimulatorManager.ts   # 抽象基底クラス
│   ├── IOSSimulator.ts       # iOS 実装
│   └── AndroidEmulator.ts    # Android 実装
├── capture/
│   ├── CaptureStrategy.ts    # キャプチャインターフェース
│   ├── ScreenshotCapture.ts  # スクリーンショット実装
│   └── FrameBuffer.ts        # 差分検出
└── utils/
    ├── Logger.ts             # ロギング
    └── CommandExecutor.ts    # コマンド実行
```

## 重要な設計方針

### メモリ管理

1. **一時ファイルの即時削除**: スクリーンショット取得後は即座に削除
2. **バッファの再利用**: 可能な限り新規バッファ作成を避ける
3. **参照の解放**: 不要になったオブジェクトは null を代入
4. **タイマーのクリア**: `clearInterval()` / `clearTimeout()` を確実に実行

### ストレージ

1. **一時ファイルは `os.tmpdir()` のみ使用**
2. **ファイル名に UUID を使用して衝突回避**
3. **使用後は必ず `fs.unlink()` で削除**
4. **エラー時も finally で確実にクリーンアップ**

### セキュリティ

1. **コマンドインジェクション対策**: `execFile` を使用、ホワイトリスト方式
2. **引数サニタイズ**: 特殊文字の除去
3. **Webview CSP**: 外部リソース読み込みを制限

## コマンド一覧

| コマンド | 機能 |
|----------|------|
| `simulator.selectDevice` | デバイス選択 |
| `simulator.startCapture` | キャプチャ開始 |
| `simulator.stopCapture` | キャプチャ停止 |
| `simulator.takeScreenshot` | スクリーンショット保存 |
| `simulator.home` | ホームボタン |
| `simulator.back` | 戻るボタン |
| `simulator.refresh` | デバイス一覧更新 |

## 主要クラス

### SimulatorManager (抽象クラス)

プラットフォーム固有の操作を抽象化:
- `listDevices()`: デバイス一覧取得
- `takeScreenshot()`: スクリーンショット取得
- `tap()`: タップ送信
- `pressHome()`: ホームボタン

### ScreenshotCapture

定期的なスクリーンショット取得とフレーム送信:
- 適応的リフレッシュレート
- 差分検出によるスキップ
- メモリ効率的なバッファ管理

### SimulatorWebviewProvider

Webview の作成と管理:
- デバイス選択 UI
- 画面表示
- 入力イベント処理

## ビルド・実行

```bash
# 依存関係インストール
npm install

# コンパイル
npm run compile

# 監視モード
npm run watch

# クリーン
npm run clean
```

## デバッグ

1. VSCode で F5 を押して Extension Development Host を起動
2. Activity Bar の「Simulator」アイコンをクリック
3. デバイスを選択してキャプチャ開始

## 設定項目

| 設定 | デフォルト | 説明 |
|------|------------|------|
| `refreshInterval` | 500ms | 更新間隔 |
| `imageQuality` | 70 | JPEG 品質 |
| `maxWidth` | 350px | 最大表示幅 |
| `adaptiveRefresh` | true | 適応的リフレッシュ |

## トラブルシューティング

### iOS Simulator が検出されない

```bash
# Xcode Command Line Tools がインストールされているか確認
xcode-select -p

# シミュレータ一覧を確認
xcrun simctl list devices
```

### Android Emulator が検出されない

```bash
# adb が PATH に含まれているか確認
which adb

# デバイス一覧を確認
adb devices
```

### スクリーンショットが取得できない

- シミュレータ/エミュレータが起動しているか確認
- デバイスが "Booted" 状態か確認
- ログ出力を確認 (Output パネル → "Secondary Simulator")

## 既知の制限事項

1. iOS Simulator は macOS でのみ動作
2. スクリーンショット方式のため 100-500ms の遅延
3. 音声は非対応
4. マルチタッチは非対応

## 今後の拡張予定

- [ ] ストリーミングモード (ffmpeg 使用)
- [ ] スワイプジェスチャー
- [ ] キーボード入力
- [ ] 複数デバイス同時表示
- [ ] 録画機能
