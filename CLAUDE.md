# CLAUDE.md

Claude Code / Cursor がこのリポジトリで作業するための指針。

## プロジェクト概要

VS Code / Cursor のサイドバーに iOS Simulator・Android Emulator の画面を表示し、
マウス操作をそのままデバイスへ流す拡張機能。TypeScript + macOS ネイティブサイドカー。

## コマンド

```bash
npm run build      # tsc + simhid-server（macOS 以外では native をスキップ）
npm run compile    # tsc のみ
npm run typecheck  # tsc --noEmit
npm test           # compile + test/*.test.js（Node 標準・フレームワークなし）
npm run package    # vsix/secondary-simulator.vsix を生成
npm run watch      # tsc -watch
npm run clean      # out/ と native/simhid-server を削除
```

`test/*.device-test.js` は実機/シミュレータが要るため `npm test` には含めない。手動実行する。

デバッグは VS Code で F5（Extension Development Host）。ログは出力パネルの
"Secondary Simulator" チャンネル（`src/utils/Logger.ts`）。

## アーキテクチャ

```
extension.ts → SimulatorWebviewProvider ─┬─ capture（画面）
                                         └─ input（操作）
```

- **capture**: `MjpegCapture`（拡張ホストが中継し canvas 描画）と `MjpegProxy`
  （webview の `<img>` に直結。`secondarySimulator.directStream` で切替）。
  iOS の帯域は `WdaSettings` が WDA の scale/quality を設定する。
- **input**: `SimulatorInputController` が司令塔。**iOS Simulator かつサイドカーが
  存在する場合だけ** HID 直接注入（`HidSidecarBackend` → `SimhidSidecar` →
  `native/simhid-server`）を使い、それ以外と HID 失敗時は `WdaBackend`
  （mobilecli 経由）へ降格する。
- **webview**: `media/webview/main.js` が Pointer Events を間引きなしで
  `touchDown/Move/Up` に変換して送る。ジェスチャー判定はデバイス側の責務。
- **utils**: `MobileCliServer` が mobilecli をサーバとして起動し、
  `MobileCliClient` が JSON-RPC 2.0（`JsonRpcClient`）で叩く。
  `ResourceStats` が拡張ホストの RSS/heap・子プロセスの RSS・拡張ディレクトリの
  サイズを集め、provider が 30 秒ごとに webview のフッターへ流す。

詳細設計は `docs/sidecar-protocol.md`（サイドカープロトコル）と
`docs/ios-hid-injection.md`（HID 仕様）、`docs/sync-research.md`（同期改善の調査）。

## 守る境界

- **座標は常に正規化 [0,1]** でやり取りする。ピクセル変換は各バックエンドの内側。
- **私有 API は `native/` の中だけ**。TypeScript 側から直接触らない。
- **HID は iOS Simulator 限定**。Android・実機は WDA/mobilecli 経路。
- 入力経路を増やすときは `InputBackend` を実装する。webview から個別経路を生やさない。
- `native/simhid-server` は macOS 専用。ビルドは `scripts/build-native.sh` が
  非 macOS を自動スキップするので、拡張は WDA だけでも動く状態を保つ。

## ストレージ / メモリ管理

**この拡張はストレージとメモリを常に把握できる状態に保つ。** 増える一方の入れ物を
作らない、が原則。

- **永続ストレージは使わない**。`globalState` / `workspaceState` / 独自のファイル
  書き込みを増やさない。設定は `vscode.workspace.getConfiguration` だけで足りる。
  どうしても必要なら理由をここに書き、`ResourceStats` のサイズキャッシュも外す。
- **無制限に伸びるバッファ・キュー・Map を作らない**。上限と破棄条件をセットで書く
  （`MjpegCapture` の 10MB 上限、webview の `MAX_FRAME_QUEUE = 1`、軌跡 40 点）。
- **高頻度パスでログを出さない**。`touch*` は 60Hz で届く。OutputChannel は全文を
  メモリに持つので、1 イベント 1 行で確実に膨らむ。
- **確保したものは必ず捨てる**。`Disposable` はフィールドに保持して `dispose()` で
  外す（`resolveWebviewView` は再呼び出しされるので冒頭で前回分を捨てる）。
  子プロセス（mobilecli / simhid-server）・タイマー・`ImageBitmap` も同じ。
- **計測できる状態を保つ**。子プロセスを増やしたら pid を公開し、
  `SimulatorWebviewProvider.reportStats()` の集計対象に加える。

## 開発フロー

- コミットは Conventional Commit の**日本語一行**（`.cursor/commands/commit-by-feature.md` 参照）。
  例: `feat(input): HID/WDA を切り替える入力バックエンドを追加`
- 作業ブランチは `feature/**` / `fix/**`。push すると CI（型チェック・テスト・VSIX）が回る。
- リリースは `release/Ver_X.Y.Z` ブランチを push する（README「リリース」参照）。
- ロジックを変えたら `npm test` を通してからコミットする。

## 注意

- `@mobilenext/mobilecli` は VSIX に darwin 版バイナリだけ同梱する（`.vscodeignore`）。
  見つからない場合は `npx` 実行にフォールバックする。
- webview は CSP 下で動く。外部 CDN・インライン script は使えない。
