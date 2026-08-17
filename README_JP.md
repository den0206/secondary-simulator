<p align="center">
  <img src="media/icon.png" width="128" alt="Secondary Simulator">
</p>

# Secondary Simulator

[![CI](https://github.com/den0206/secondary-simulator/actions/workflows/ci.yml/badge.svg)](https://github.com/den0206/secondary-simulator/actions/workflows/ci.yml)
[![Release](https://github.com/den0206/secondary-simulator/actions/workflows/release.yml/badge.svg)](https://github.com/den0206/secondary-simulator/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.md)

[English](README.md) | **日本語**

VSCode / Cursor 拡張機能として、iOS/Androidシミュレータとエミュレータをサイドバーに表示し、リアルタイムで操作できる機能を提供します。

## 🎯 概要

Secondary Simulatorは、XcodeやAndroid Studioのシミュレータウィンドウを開くことなく、エディタのサイドバーから直接デバイスを表示・操作できる拡張機能です。MJPEGストリーミングによる低レイテンシな画面表示と、iOS Simulator への HID 直接注入による低遅延な操作を実現しています。

## ✨ 主な機能

- **📱 ユニバーサルデバイスサポート**: iOS/Androidのシミュレータ、エミュレータ、実機デバイスに対応
- **🖥️ リアルタイムプレビュー**: MJPEGストリーミングによる高フレームレートの画面ミラーリング
- **👆 インタラクティブ操作**: Pointer Events を生配信し、タップ・スワイプ・ドラッグ・ピンチをデバイス側で判定
- **⚡ 低レイテンシ**: iOS Simulator では HID を直接注入（`native/simhid-server`）、失敗時は WDA へ自動降格
- **🔄 統一API**: `mobilecli`（JSON-RPC 2.0）による一貫したデバイス制御
- **💾 メモリ効率**: ストリーム・リスナー・タイマーのクリーンアップでメモリリークを防止

## 📋 要件

- **VSCode / Cursor**: VSCode バージョン 1.90.0 以上（Node 20）
- **Node.js**: 20 以上（拡張機能ホストの実行に必要）
- **macOS**: iOS Simulator の利用と HID 直接注入に必要（Android のみなら他 OS でも動作しますが未検証）
- **mobilecli**: `@mobilenext/mobilecli` を VSIX に同梱（見つからない場合は `npx` 実行にフォールバック）
- **iOS Simulator**: Xcodeと`simctl`コマンドラインツールが必要
- **Android Emulator**: Android SDKと`adb`コマンドラインツールが必要

## 🚀 インストール

### リリース版（VSIX）

[Releases](https://github.com/den0206/secondary-simulator/releases) から `secondary-simulator-X.Y.Z.vsix` をダウンロードし、

```bash
code --install-extension secondary-simulator-X.Y.Z.vsix   # Cursor なら cursor --install-extension
```

または拡張機能ビューの「…」→「VSIX からのインストール」を使います。Cursor / VSCodium の拡張機能検索（Open VSX）からも入手できます。

### 開発版のビルド

```bash
# 依存関係のインストール
npm install

# TypeScript とネイティブサイドカーのビルド
npm run build

# VSCodeで拡張機能を実行
# F5キーを押してExtension Development Hostを起動
```

## ⚙️ 設定

VSCodeの設定で以下のオプションを調整できます：

- **`secondarySimulator.autoConnect`**: 起動中のデバイスへ自動接続する（デフォルト: true）。未接続のあいだは 5 秒ごとに探す。Auto ボタンと連動し、Disconnect で OFF になる。
- **`secondarySimulator.directStream`**: 表示を webview 直結 MJPEG（`<img>`）にする（デフォルト: false・実験的）
- **`secondarySimulator.streamScale`**: iOS の MJPEG 縮小率（デフォルト: 1.0＝原寸）
- **`secondarySimulator.streamQuality`**: iOS の MJPEG JPEG 品質 1-100（デフォルト: 80）
- **`secondarySimulator.captureSource`**: `auto`（デフォルト）は HID サイドカー経由で iOS Simulator のフレームバッファを取り込む（ソフトウェアキーボード・ステータスバーも写る）。`wda` は従来の mobilecli/WDA MJPEG（アプリのウィンドウのみ）。サイドカーが使えないときは自動で WDA へ降格する。
- **`secondarySimulator.captureFps`**: サイドカー取り込みの上限 fps（デフォルト: 30）。変化のないフレームは送られない。
- **`secondarySimulator.captureMaxWidth`**: サイドカーが送る JPEG の最大幅 px（デフォルト: 640）
- **`secondarySimulator.keyInput`**: iOS Simulator へのキー入力経路。`hid`（デフォルト・高速）または `wda`（1文字あたり約 370ms）。HID のキーはハードウェアキーボード扱いになるためソフトウェアキーボードが出ない。サイドバーにソフトキーボードを映したいときは `wda`。タッチは常に HID。

タップ/スワイプ/ロングプレスの判定はデバイス側が行うため、閾値の設定項目はありません。

## 📖 使用方法

1. VSCodeを開き、拡張機能をアクティブ化
2. サイドバーに **Secondary Simulator** アクティビティバーが出る（ビュー名は Device Preview）
3. ドロップダウンメニューからデバイスを選択（↻ で一覧を再取得）。Auto ON なら起動中のデバイスへ自動で繋ぐ
4. デバイス画面がリアルタイムで表示されます
5. マウス/タッチでデバイスと対話：
   - **クリック/タップ**: シングルタップ
   - **ダブルクリック**: ダブルタップ
   - **クリック&ドラッグ**: スワイプ・ドラッグ（追従）
   - **長押し**: 押下したまま静止でロングプレス
   - **Home**: プレビュー下のボタン
   - **Back**: Android のみ（iOS では無効）
   - **Trail**: リップルとドラッグ軌跡の表示切替
   - **Auto**: 起動中デバイスへの自動接続の切替

## ⌨️ コマンド

コマンドパレット（`Cmd+Shift+P`）から **Secondary Simulator:** で絞り込めます。
スクリーンショット・再取得・ログはビュータイトルのアイコンからも実行できます。

| コマンド | 説明 |
|---|---|
| `Select Device` | 一覧から選んで接続する |
| `Save Screenshot` | 接続中のデバイスの画面を保存する |
| `Press Home` | Home ボタン（`Cmd+Shift+H`） |
| `Press Back` | Back ボタン・Android のみ（`Cmd+Shift+B`） |
| `Refresh Device List` | デバイス一覧を再取得する（`Cmd+Shift+R`） |
| `Show Logs` | 出力パネルの Secondary Simulator を開く |
| `Clear Logs` | 出力チャンネルを空にする（VS Code が全文をメモリに持つため） |

キーバインドはサイドバーにフォーカスがあるときだけ効きます。

## 🏗️ プロジェクト構造

```
secondary-simulator/
├── src/
│   ├── extension.ts                    # 拡張機能のエントリーポイント
│   ├── simulator/
│   │   ├── types.ts                   # 型定義
│   │   └── autoConnect.ts             # 自動接続する起動中デバイスの選択
│   ├── webview/
│   │   └── SimulatorWebviewProvider.ts # Webview管理
│   ├── capture/
│   │   ├── CaptureStrategy.ts         # キャプチャインターフェース
│   │   ├── MjpegCapture.ts            # MJPEGストリーミング実装（canvas 経路）
│   │   ├── MjpegParser.ts             # multipart のインクリメンタル解析
│   │   ├── MjpegProxy.ts              # MJPEG 直結プロキシ（webview <img> 経路）
│   │   ├── Screenshot.ts              # device.screenshot 応答のデコード
│   │   └── WdaSettings.ts             # WDA の MJPEG 帯域設定（iOS）
│   ├── input/
│   │   ├── InputBackend.ts            # 入力バックエンドの抽象
│   │   ├── SimhidSidecar.ts           # simhid-server プロセス管理（JSON Lines）
│   │   ├── HidSidecarBackend.ts       # HID 直接注入バックエンド
│   │   ├── WdaBackend.ts              # WDA/mobilecli フォールバック
│   │   └── SimulatorInputController.ts # バックエンド選択と降格
│   └── utils/
│       ├── Logger.ts                  # ログ管理
│       ├── MobileCliClient.ts         # mobilecliクライアント
│       ├── MobileCliServer.ts         # mobilecliサーバー管理
│       ├── JsonRpcClient.ts           # JSON-RPC 2.0クライアント
│       └── ResourceStats.ts           # RSS / heap / 子プロセス / 拡張ディレクトリ
├── native/
│   └── simhid-server.m                # HID 注入サイドカー（macOS/iOS Simulator）
├── media/
│   ├── icon.svg / icon.png            # 拡張機能アイコン
│   └── webview/                       # WebviewのHTML/CSS/JS
├── scripts/
│   └── build-native.sh                # simhid-server の universal ビルド
├── test/                              # Node 標準のテスト（フレームワークなし）
├── docs/                              # 設計・調査ドキュメント
├── .github/workflows/                 # CI とリリース
├── out/                               # コンパイル済みファイル
├── package.json                       # プロジェクト設定
└── tsconfig.json                     # TypeScript設定
```

## 🔧 技術スタック

- **言語**: TypeScript / Objective-C（サイドカー）
- **ランタイム**: Node.js (VSCode Extension Host)
- **主要ライブラリ**:
  - `@mobilenext/mobilecli`: デバイス操作とストリーミング
- **通信プロトコル**: JSON-RPC 2.0（mobilecli）/ JSON Lines（サイドカー）
- **ストリーミング**: MJPEG

## 🎨 アーキテクチャ

### キャプチャ方式

1. **MJPEG（canvas 経路・デフォルト）**
   - 拡張ホストが `mobilecli` の MJPEG を受けて webview に転送し canvas に描画
2. **MJPEG 直結（`directStream`・実験的）**
   - `MjpegProxy` 経由で webview の `<img>` が直接受信し、Chromium がネイティブ復号

### デバイス操作

- **HID 直接注入**: iOS Simulator では `native/simhid-server` が HID イベントを注入（最低遅延）
- **WDA フォールバック**: Android・実機、および HID 初期化/実行に失敗した場合は `mobilecli` 経由
- **座標変換**: 正規化座標（0-1）でやり取りし、ピクセル変換は各バックエンドの内側で行う

### メモリ管理

- **リソースクリーンアップ**: ストリーム、ImageBitmap、イベントリスナー、タイマーの適切な解放
- **プロセス管理**: mobilecli サーバーとサイドカーの起動・再接続・破棄を一元管理

## 🐛 トラブルシューティング

### デバイスが表示されない

- iOS SimulatorまたはAndroid Emulatorが実行されていることを確認
- `simctl`（iOS）または`adb`（Android）がPATHに含まれていることを確認
- mobilecliサーバーが実行されていることを確認（拡張機能のログを確認）

### ストリーミングの問題

- mobilecliサーバーが正常に起動していることを確認（拡張機能のログを確認）
- リモートデバイスの場合はネットワーク接続を確認
- 帯域が足りない場合は `streamScale` / `streamQuality` を下げる

### 操作が遅い・反応しない

- 出力パネル「Secondary Simulator」で HID / WDA どちらのバックエンドか確認
- HID が使えるのは **iOS Simulator のみ**。WDA 降格時はレイテンシが上がる
- サイドカーが同梱されているか確認（`native/simhid-server`）

## 📝 開発

```bash
npm run build      # TypeScript + simhid-server（macOS 以外は native をスキップ）
npm run compile    # TypeScript のみ
npm run typecheck  # 型チェックのみ
npm test           # テスト（compile 込み）
npm run watch      # ウォッチモード
npm run package    # vsix/secondary-simulator.vsix を生成
npm run clean      # 生成物の削除
```

作業指針とアーキテクチャの要点は [CLAUDE.md](CLAUDE.md)、設計ドキュメントは [docs/](docs) を参照してください。

## 🚢 リリース

1. `main` から `release/Ver_X.Y.Z` ブランチを作成して push する
2. GitHub Actions（[release.yml](.github/workflows/release.yml)）が型チェック・テスト・VSIX 作成を行い、
   `Ver_X.Y.Z` タグで GitHub Release を作成して VSIX を添付する
3. `OVSX_TOKEN` が設定されていれば Open VSX にも公開する（未設定ならスキップ）
4. `package.json` の version は自動で `main` に反映される

補足:

- 同じ `Ver_X.Y.Z` が既にある場合は `Ver_X.Y.Z+1` として再ビルドされる（公開済みリリースは不変）
- 既存の最新版より古いバージョン名は拒否される
- リリースノートは `docs/release-notes/X.Y.Z.md` があればそれを使用し、無ければ自動生成
- Open VSX の名前空間は初回のみ手動作成が必要: `npx ovsx create-namespace yuuki-sakai -p <token>`

## 📄 ライセンス

[MIT](LICENSE.md)

## 🤝 コントリビューション

コントリビューションを歓迎します。PR は `feature/**` または `fix/**` ブランチから作成してください（CI が自動で走ります）。

## 📚 参考資料

- [VSCode Extension API](https://code.visualstudio.com/api)
- [mobilecli Documentation](https://github.com/mobile-next/mobilecli)
- [MJPEG Streaming](https://en.wikipedia.org/wiki/Motion_JPEG)
