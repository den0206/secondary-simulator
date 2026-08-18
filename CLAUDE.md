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

`npm test` は `node --test test/*.test.js`。**ファイルを置けば走る**（登録は要らない）。
各テストは node 標準のみの素の script で、`process.exit` の終了コードが結果になる。
`test/*.device-test.js` は `*.test.js` に一致しないので走らない（実機/シミュレータが要る）。手動実行する。

`sh scripts/check-xcode-hid.sh` はインストール済み Xcode すべてに
`native/simhid-server --check` を当て、HID の私有シンボル（CoreSimulator /
SimulatorKit）が解決できるかだけを見る。Xcode 更新で HID が壊れたときの一次検知で、
CI の毎 push と週次 cron（`xcode-canary` ジョブ、macos-latest）で回る。

デバッグは VS Code で F5（Extension Development Host）。ログは出力パネルの
"Secondary Simulator" チャンネル（`src/utils/Logger.ts`）。

## アーキテクチャ

```
extension.ts → SimulatorWebviewProvider ─┬─ capture（画面）
                                         └─ input（操作）
```

- **capture**: iOS Simulator で HID サイドカーが生きているときは `SidecarCapture`
  （端末のフレームバッファを直接 JPEG 化。**WDA 経路にはソフトウェアキーボードと
  ステータスバーが写らない**ため。`docs/sidecar-protocol.md` §3.5）。
  それ以外は `MjpegCapture`（拡張ホストが中継）と `MjpegProxy`
  （webview の `<img>` に直結。`secondarySimulator.directStream` で切替）。
  multipart の解析は `MjpegParser` が持つ（ネットワークに触らないので単体テスト可能）。
  **フレームは base64 の文字列のまま webview へ渡し、`<img>` の data URL にする**
  （経路の途中で復号して詰め直さない。復号は Chromium がやる）。
  `MjpegProxy` は起動毎のトークンを URL に要求する（同じマシンの他プロセスから
  覗かれないため）。iOS の帯域は `WdaSettings` が WDA の scale/quality を設定する。
  **取り込みの粗さは固定ではない** — webview が報告する表示幅（× DPR）に幅を合わせ、
  指を置いている間だけ fps を上げる（`captureConfig` で張り直さずに差し替える。
  設定値は上限として扱う）。静止画面ではフレームが 1 枚も来ないので、死活は
  サイドカーの生存通知（`captureAlive`）で見る（`docs/sidecar-protocol.md` §3.5）。
- **input**: `SimulatorInputController` が司令塔。**iOS Simulator かつサイドカーが
  存在する場合だけ** HID 直接注入（`HidSidecarBackend` → `SimhidSidecar` →
  `native/simhid-server`）を使い、それ以外と HID 失敗時は `WdaBackend`
  （mobilecli 経由）へ降格する。**キー入力だけは `secondarySimulator.keyInput` で
  WDA へ回せる**（HID のキーはハードウェアキーボード扱いになり、iOS がソフトウェア
  キーボードを描かなくなるため。`docs/ios-hid-injection.md` §6）。タッチは常に HID。
  **Android は `AndroidBackend`**（`WdaBackend` ではない）。mobilecli の
  `device.io.gesture` は Android では 1 アクション = `adb shell input ... motionevent`
  1 回に展開され、**`duration` は無視される**。貯めて一括送信すると数十秒かけて再生され
  フリックも効かないので、押しているあいだ「最新の 1 点だけ」を送り続ける
  （前の adb が返るまで次を出さない）。さらに `AdbTouch` が `adb shell` を 1 本
  張りっぱなしにして motionevent を流し込む（Pixel 9 エミュレータ実測で 1 イベント
  約 42ms → 約 20ms。`DOWN`/`UP` が座標を引数に取れるので位置決めの `MOVE` も要らず、
  **離す直前に「止まっている 1 往復」が消えてフリックが効く**）。adb が見つからない・
  シリアルを解決できないときは黙って mobilecli 経路へ落ちる。
  キー・テキスト・ボタンは `WdaBackend` へ委譲する。
- **webview**: `media/webview/main.js` が Pointer Events を間引きなしで
  `touchDown/Move/Up` に変換して送る。ジェスチャー判定はデバイス側の責務。
  未接続かつ `secondarySimulator.autoConnect` が ON のあいだ、provider が 5 秒ごとに
  デバイス一覧を取り、起動中があれば接続する（Disconnect で設定が OFF になる）。
- **ui**: `DeviceStatusBar` が接続中のデバイスと入力経路（HID / WDA）をステータスバーへ出す。
  表示文字列の組み立ては `renderStatus`（vscode に触らない純粋関数）が持ち、webview の
  フッター（`mode` メッセージ）と同じ文字列を使う。**HID→WDA の降格は無音**なので、
  遅くなった理由が見える場所を 1 つ用意する、が趣旨。
- **utils**: `MobileCliServer` が mobilecli をサーバとして起動し、
  `MobileCliClient` が JSON-RPC 2.0（`JsonRpcClient`）で叩く。
  `ResourceStats` が拡張ホストの RSS/heap・子プロセスの RSS・拡張ディレクトリの
  サイズを集め、provider が 30 秒ごとに webview のフッターへ流す。

詳細設計は `docs/sidecar-protocol.md`（サイドカープロトコル）と
`docs/ios-hid-injection.md`（HID 仕様）、`docs/sync-research.md`（同期改善の調査）、
`docs/project-review.md`（全体精査と未対応の提案）。

## 守る境界

- **座標は常に正規化 [0,1]** でやり取りする。ピクセル変換は各バックエンドの内側。
- **私有 API は `native/` の中だけ**。TypeScript 側から直接触らない。
- **HID は iOS Simulator 限定**。iOS 実機は `WdaBackend`（mobilecli 経由）、
  Android は `AndroidBackend`（タッチだけ `AdbTouch` の adb 直叩き、それ以外は mobilecli）。
  **adb を直接叩くのは `AdbTouch` の中だけ**。他から `adb` を生やさない。
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
  （`MjpegCapture` の 10MB 上限、`SimhidSidecar` の stdout 1MB 上限、軌跡 40 点、
  pointer 10 件）。**捨てる判断も含む** — `sendNoWait` は stdin が詰まっている間
  `touchMove` を捨てる（最新の座標だけが意味を持つので歪まない）。
  webview はフレームを溜めない（`<img>` に渡し、間引きは Chromium がやる）。
- **高頻度パスでログを出さない**。`touch*` は 60Hz で届く。OutputChannel は全文を
  メモリに持つので、1 イベント 1 行で確実に膨らむ。**リトライループも高頻度パス**
  （`MjpegCapture` の再接続は指数バックオフで、記録は最初の 3 回まで）。
  `secondarySimulator.logLevel`（既定 info）で `Logger.debug` は落ちるが、
  **それを当てにしない**（debug にする人がいる）。閾値は `Logger` がフィールドに写しを
  持つので、判定のために `getConfiguration` を呼ばない。
- **確保したものは必ず捨てる**。`Disposable` はフィールドに保持して `dispose()` で
  外す（`resolveWebviewView` は再呼び出しされるので冒頭で前回分を捨てる）。
  子プロセス（mobilecli / simhid-server / `AdbTouch` の adb shell）・タイマーも同じ。
  非表示のあいだサイドカーを使い回す場合も、放置されたら解放する（2 分）。
- **計測できる状態を保つ**。子プロセスを増やしたら pid を公開し、
  `SimulatorWebviewProvider.reportStats()` の集計対象に加える。
  同期の質（受信 fps / 描画 fps / 帯域）も同じフッターに出す。**改善を入れる前に、
  効果を確かめる手段を用意する。**

## 開発フロー

- コミットは Conventional Commit の**日本語一行**（`.cursor/commands/commit-by-feature.md` 参照）。
  例: `feat(input): HID/WDA を切り替える入力バックエンドを追加`
- 作業ブランチは `feature/**` / `fix/**`。push すると CI（型チェック・テスト・VSIX）が回る。
- リリースは `release/Ver_X.Y.Z` ブランチを push する（README「リリース」参照）。
- ロジックを変えたら `npm test` を通してからコミットする。テストは `test/` へ
  `*.test.js` で置けば拾われる（`package.json` への登録は不要）。
  `vscode` に依存するモジュールは `test/helpers/vscode-stub.js` を先に読み込む。

## 注意

- `@mobilenext/mobilecli` は VSIX に darwin 版バイナリだけ同梱する（`.vscodeignore`）。
  見つからない場合は `npx` 実行にフォールバックする。
- webview は CSP 下で動く。外部 CDN・インライン script は使えない。

## 多言語化

**既定は英語。** 日本語（`ja`）と簡体字中国語（`zh-cn`）を同梱する。

- **package.json の貢献点**（コマンド名・設定の説明）は `%key%` にし、
  `package.nls.json`（英語）/ `package.nls.ja.json` / `package.nls.zh-cn.json` に書く。
- **実行時の文言**は `vscode.l10n.t('英語の原文')`。**原文がキー**なので、
  呼び出し側に英語がそのまま見える。訳は `l10n/bundle.l10n.<locale>.json`。
- **webview は `vscode.l10n` を触れない**（別プロセス）。`src/utils/Strings.ts` が
  翻訳済みの辞書を作り、`getHtmlContent` が `<script type="application/json">` で
  埋め込む。webview 側は `t('key')` と `data-i18n` / `data-i18n-title` /
  `data-i18n-icon` で引く。**表示前に揃うので、後から差し替えて一瞬英語が見える、が起きない。**
- **`renderStatus` は純粋関数のまま保つ**。翻訳は `StatusStrings` として引数で渡す
  （`vscode.l10n` を呼ぶとテストから使えなくなる）。
- **ログは対象外**。開発者向けの診断であって UI ではない。
- 文言を足したら `test/localization.test.js` が過不足を落とす（`{0}` の欠落も見る）。
  言語を増やすときは、このテストの `LOCALES` にも足す。
