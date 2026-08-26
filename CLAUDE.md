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
`test/*.device-test.js` は `*.test.js` に一致しないので `npm test` では走らない
（起動中のシミュレータが要る）。ログを読めるように `vscode-stub` は
`installVerbose()` を使う（`install()` は `Logger` を捨てるので、HID から WDA へ
降格した理由が消える）。

- **`tap-effect.device-test.js` は CI の macOS ジョブが回す。** 操作の前後を
  スクリーンショットで比べ、**HID 注入が実際に画面を動かすか**を見る
  （差分は `test/helpers/screen-diff.js`）。単体テストはコマンドを組み立てる
  ところまでしか見ないので、注入そのものが壊れても気づけない。
- **`stream-lifecycle.device-test.js` は手元だけ**（`node test/stream-lifecycle.device-test.js <UDID>`。
  起動中のシミュレータと mobilecli(:12099) が要る）。**CI に載せない** — mobilecli+WDA の
  MJPEG 経路が GitHub の macOS ランナーで安定しないため（実測: ローカルは約 27fps
  出るのに CI は 60 秒で 2 枚、`device.screencapture` が 500 を返すこともある）。
  載せるとランナーの調子を測るだけのテストになる。

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
  キー・テキスト・ボタンは `WdaBackend` へ委譲する。**矢印キーだけは Android で
  `KEYCODE_DPAD_*`**（`AndroidBackend` → `device.io.button`）。HID usage は元からあったが
  webview が `e.key.length === 1` に載らず捨てられていたので `special` 経路へ載せた。
- **webview**: `media/webview/main.js` が Pointer Events を間引きなしで
  `touchDown/Move/Up` に変換して送る。ジェスチャー判定はデバイス側の責務。
  **Cmd/Ctrl+V は `paste` でまとめて送る**（`InputBackend.text`。URL 入力用）。
  **中身は webview から送らない** — `clipboardData` は外部アプリでコピーした内容が
  ひとつ前のまま返る（VS Code 内でコピーしたときだけ最新になるので、動いて見えて古い）。
  webview は合図だけ送り、ホストが `vscode.env.clipboard.readText()` で読む。
  **画面をタップしたら `pointerdown` でコンテナにフォーカスを取る**（`tabindex="-1"`）。
  `pointerdown` の `preventDefault` はフォーカス移動も止めるので、取らないと打鍵と
  Cmd+V がエディタ側へ流れる（ボタンや `<select>` を触った後だけ効く間欠故障になる）。
  デバイス選択の `<select>` などテキスト UI にフォーカスがあるあいだはキーを送らない。
  未接続かつ `secondarySimulator.autoConnect` が ON のあいだ、provider が 5 秒ごとに
  デバイス一覧を取り、起動中があれば接続する（Disconnect で設定が OFF になる）。
  一覧は iOS / Android で分ける。停止中を選んだら `bootDevice` で起動確認する
  （コマンドパレット経由と同じ）。エラー時はオーバーレイに［再試行］［ログを見る］を出す。
  `secondarySimulator.showDeviceFrame` / `showResourceStats` / `showTouchTrail` で
  筐体・リソース数値・タップの軌跡の表示を切り替えられる（数値の収集は続ける。
  **軌跡は既定 OFF**）。**見た目の設定は webview に写しを置かない** — `settings`
  メッセージで受けた値をそのまま反映する（設定画面と食い違ったまま気づけなくなる）。スクリーンショット保存・録画の開始/停止は
  webview 内の Web Audio で短い効果音を鳴らす。
- **デバイス操作（mobilecli）**: 録画は 2 経路（`secondarySimulator.recordingSource`）。
  **既定の `view` は webview が「表示中のフレーム＋操作の表示」を canvas に合成し
  `MediaRecorder` で符号化**して、チャンクをホストが書く。`device` は
  `device.screenrecord` / `.stop`（端末の解像度で録れるが、**カーソルもタップも写らない**
  — 入力は合成なので端末が指を描かず、カーソルはホストにしか無い。
  `docs/sidecar-protocol.md` §7.2）。コンテナは webview の
  `isTypeSupported` 次第で mp4 か webm になり、保存ダイアログの拡張子も揃える。
  **チャンクは捨てない** — `touchMove` と違い 1 つ落ちるとコンテナが壊れるので、詰まったら
  録画そのものを止める（未 ack 8 件・総量 512MB・無音 10 秒・連番の欠落）。ack はホストが
  書き終えてから返すので、それがそのまま逆圧になる。録画中だけ直結配信をやめる
  （別オリジンの `<img>` は canvas を汚染し `captureStream` が止まる）。
  どちらの経路でも保存先パスはユーザーが選び、拡張は一時ファイルを
  持たない。**開始は 3 秒の秒読みのあと**（`countdown` メッセージ。保存ダイアログを閉じた直後の
  画面が頭に写らないため。進行はホストが持ち、webview は数字と音を出すだけ）。10 分・切断・破棄で必ず止める。**サイドバー非表示でも止める**（止め忘れ防止）。
  停止に失敗したら UI は録画中のまま残し、通知から再試行できる。拡張の `dispose` は
  録画停止を待ってから mobilecli を止める。**停止が成功しても中身を検証する**
  （`RecordingFile.ts` の `verifyRecording`）。端末側で finalize されないと
  `moov` の無い mp4 が残り、映像は入っているのに再生できない。検証に落ちたら
  警告を出し、`recording` メッセージに `ok: false` を載せて**停止音も鳴らさない**
  （音と通知が「保存できた」の合図なので、黙って通すと気づけない）。
  ファイル全体は読まない — 先頭から box を辿って 128 個で打ち切る。**検査は形式で分ける**
  （mp4 は `moov`、webm は Cluster。webm は長さも Cues も入らないので「未完成」を
  判定できず、途中で落ちたことは連番の欠落として書き込み側が捉える）。
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
  **逆に、捨ててはいけないものもある** — ビュー録画のチャンクは 1 つ落ちるとコンテナが
  壊れるので、上限に当たったら捨てるのではなく**録画を止める**（`ViewRecording.ts`）。
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
- **CHANGELOG は英語で書く**（コミットメッセージは日本語のまま）。公開ページ
  （Open VSX / Marketplace）は全世界から読まれるので、日本語が混ざるとその節だけ
  読めない人が出る。節の見出しは Keep a Changelog の `Added` / `Changed` /
  `Deprecated` / `Removed` / `Fixed` / `Security` を使う。
  `test/changelog.test.js` が日本語混入と未知の見出しを落とす。
- **CHANGELOG は `[Unreleased]` に書き足すだけ**。バージョン見出しへの切り出しは
  リリース時に `scripts/release-changelog.js` がやる。公開ページが表示するのは
  **VSIX 内の CHANGELOG.md** なので、パッケージより前に切っている。
  手で移し替えると二重の見出しになるのでやらない。
- ロジックを変えたら `npm test` を通してからコミットする。テストは `test/` へ
  `*.test.js` で置けば拾われる（`package.json` への登録は不要）。
  `vscode` に依存するモジュールは `test/helpers/vscode-stub.js` を先に読み込む。

## 注意

- `mobilecli` は VSIX に darwin 版バイナリだけ同梱する（`.vscodeignore`）。
  見つからない場合は `npx` 実行にフォールバックする。**版は必ず固定する**
  （`npxPackageSpec()`。`package.json` も `^` を付けず完全固定）。`@latest` に
  すると、実行の度にネットワークから取ってきたコードを利用者のマシンで走らせる
  ことになる。**追随は実行時ではなくビルド時にやる** — Dependabot が版上げの PR を
  出すので、CI を通してから利用者へ出す（`.github/dependabot.yml`）。
- **`mobilecli` は FSL-1.1-ALv2**（ソース公開型。OSI 承認のオープンソースではない）。
  同梱して再配布する以上、全文と著作権表示を `THIRD-PARTY-NOTICES.md` で運ぶ必要が
  あり、`.vscodeignore` はこれを VSIX に入れている。**版を上げたら
  `THIRD-PARTY-NOTICES.md` の版・対応ソース SHA も一緒に直す。**
  なお `@mobilenext/mobilecli`（旧・0.1.x、AGPL-3.0）は 2026-04 で更新が止まり、
  開発はスコープ無しの `mobilecli` へ移った。戻らない。
- **`.npmrc` の `ignore-scripts=true` を外さない。** 依存パッケージの install /
  postinstall は、npm を狙うワーム（Shai-Hulud 系）が資格情報を盗んで自己増殖する
  足場そのもの。CI と開発者マシンの両方で既定として塞いでいる。`npm run` は
  影響を受けない（compile / build / package / test はそのまま動く）。
  ネイティブ依存を足してビルドが要るときは、その場で `npm rebuild <pkg>` する。
- **CI で使う第三者 Action はコミット SHA で固定する。** `@main` や可変タグは、
  上流が侵害された瞬間にこちらのジョブで任意コードが走る
  （`trufflesecurity/trufflehog` はリリースの SHA で止め、版はコメントに残す）。
  **GitHub 公式の `actions/*` はメジャータグ（`@v4`）のまま**にしている。
  公開トークンを持つステップで `npx` を使うときも版を固定する（`ovsx@X.Y.Z`）。
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
