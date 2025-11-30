# Secondary Simulator

VSCode拡張機能として、iOS/Androidシミュレータとエミュレータをサイドバーに表示し、リアルタイムで操作できる機能を提供します。

## 🎯 概要

Secondary Simulatorは、XcodeやAndroid Studioのシミュレータウィンドウを開くことなく、VSCodeのサイドバーから直接デバイスを表示・操作できる拡張機能です。MJPEGストリーミングによる低レイテンシな画面表示と、統一されたAPIによるデバイス操作を実現しています。

## ✨ 主な機能

- **📱 ユニバーサルデバイスサポート**: iOS/Androidのシミュレータ、エミュレータ、実機デバイスに対応
- **🖥️ リアルタイムプレビュー**: MJPEGストリーミングによる高フレームレートの画面ミラーリング
- **👆 インタラクティブ操作**: タップ、スワイプ、ロングプレス、ダブルタップ、複雑なジェスチャーに対応
- **⚡ 低レイテンシ**: 最適化されたMJPEGストリーミングにより、レスポンシブな操作を実現
- **🔄 統一API**: `mobilecli`を使用した一貫したデバイス制御
- **💾 メモリ効率**: 包括的なメモリ・リソース管理により、メモリリークを防止

## 📋 要件

- **VSCode**: バージョン 1.80.0 以上
- **Node.js**: 拡張機能ホストの実行に必要
- **mobilecli**: `@mobilenext/mobilecli`パッケージ経由で自動インストール
- **iOS Simulator**: Xcodeと`simctl`コマンドラインツールが必要
- **Android Emulator**: Android SDKと`adb`コマンドラインツールが必要

## 🚀 インストール

### 開発版のビルド

```bash
# 依存関係のインストール
npm install

# TypeScriptのコンパイル
npm run compile

# VSCodeで拡張機能を実行
# F5キーを押してExtension Development Hostを起動
```

### パッケージ化

```bash
# 拡張機能のパッケージ化
npm install -g @vscode/vsce
vsce package
```

## ⚙️ 設定

VSCodeの設定で以下のオプションを調整できます：

- **`secondarySimulator.tapThreshold`**: タップ検出のピクセル距離閾値（デフォルト: 10px）
- **`secondarySimulator.swipeThreshold`**: スワイプジェスチャーの最小距離（デフォルト: 30px）
- **`secondarySimulator.longPressDuration`**: ロングプレス認識までの時間（デフォルト: 600ms）
- **`secondarySimulator.experimentalH264`**: 実験的なH.264ストリーミングを有効化（デフォルト: false）

## 📖 使用方法

1. VSCodeを開き、拡張機能をアクティブ化
2. サイドバーに「Simulator」ビューが表示されます
3. ドロップダウンメニューからデバイスを選択
4. デバイス画面がリアルタイムで表示されます
5. マウス/タッチでデバイスと対話：
   - **クリック/タップ**: シングルタップ
   - **ダブルクリック**: ダブルタップ
   - **クリック&ドラッグ**: スワイプジェスチャー
   - **長押し**: 設定された時間だけ長押し
   - **Home/Backボタン**: プレビュー下のコントロールボタンを使用

## 🏗️ プロジェクト構造

```
secondary-simulator/
├── src/
│   ├── extension.ts                    # 拡張機能のエントリーポイント
│   ├── simulator/
│   │   └── types.ts                   # 型定義
│   ├── webview/
│   │   └── SimulatorWebviewProvider.ts # Webview管理
│   ├── capture/
│   │   ├── CaptureStrategy.ts         # キャプチャインターフェース
│   │   ├── MjpegCapture.ts            # MJPEGストリーミング実装
│   │   └── H264Streamer.ts            # H.264ストリーミング（実験的）
│   └── utils/
│       ├── Logger.ts                  # ログ管理
│       ├── MobileCliClient.ts         # mobilecliクライアント
│       ├── MobileCliServer.ts         # mobilecliサーバー管理
│       ├── JsonRpcClient.ts           # JSON-RPC 2.0クライアント
│       └── TempCleaner.ts             # 一時ファイルクリーンアップ
├── media/
│   └── webview/                       # WebviewのHTML/CSS/JS
├── out/                               # コンパイル済みファイル
├── package.json                       # プロジェクト設定
└── tsconfig.json                     # TypeScript設定
```

## 🔧 技術スタック

- **言語**: TypeScript
- **ランタイム**: Node.js (VSCode Extension Host)
- **主要ライブラリ**:
  - `@mobilenext/mobilecli`: デバイス操作とストリーミング
- **通信プロトコル**: JSON-RPC 2.0
- **ストリーミング**: MJPEG（デフォルト）、H.264（実験的）

## 🎨 アーキテクチャ

### キャプチャ方式

1. **MJPEGストリーミング**（推奨）
   - `mobilecli`のMJPEGストリームを使用
   - 低レイテンシで高フレームレート
   - 実機デバイスもサポート

2. **H.264ストリーミング**（実験的）
   - WebCodecs APIを使用
   - より高い圧縮率
   - ブラウザサポートが必要

### デバイス操作

- **統一API**: `mobilecli`経由でiOS/Androidの操作を統一
- **ジェスチャー認識**: タップ、スワイプ、ロングプレス、ダブルタップ、複雑なジェスチャーに対応
- **座標変換**: 正規化座標（0-1）からデバイスピクセル座標への自動変換

### メモリ管理

- **リソースクリーンアップ**: ImageBitmap、VideoDecoder、イベントリスナー、タイマーの適切な解放
- **一時ファイル管理**: 自動クリーンアップ（15分間隔）
- **メモリリーク防止**: 包括的なクリーンアップ関数の実装

## 🐛 トラブルシューティング

### デバイスが表示されない

- iOS SimulatorまたはAndroid Emulatorが実行されていることを確認
- `simctl`（iOS）または`adb`（Android）がPATHに含まれていることを確認
- mobilecliサーバーが実行されていることを確認（拡張機能のログを確認）

### ストリーミングの問題

- mobilecliサーバーが正常に起動していることを確認（拡張機能のログを確認）
- リモートデバイスの場合はネットワーク接続を確認
- 拡張機能のログでエラーメッセージを確認

### パフォーマンスの問題

- 他のリソース集約的なアプリケーションを閉じる
- 利用可能なシステムメモリを確認
- H.264ストリーミングが有効な場合は、MJPEGストリーミングに切り替えてみる

## 📝 開発

### ビルド

```bash
npm run compile
```

### ウォッチモード

```bash
npm run watch
```

### リント

```bash
npm run lint
```

### クリーンアップ

```bash
npm run clean
```

## 📄 ライセンス

このプロジェクトのライセンス情報については、LICENSEファイルを参照してください。

## 🤝 コントリビューション

コントリビューションを歓迎します！プルリクエストを送信する前に、コントリビューションガイドラインをお読みください。

## 📚 参考資料

- [VSCode Extension API](https://code.visualstudio.com/api)
- [mobilecli Documentation](https://github.com/mobile-next/mobilecli)
- [MJPEG Streaming](https://en.wikipedia.org/wiki/Motion_JPEG)

