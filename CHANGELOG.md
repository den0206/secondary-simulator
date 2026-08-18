# Changelog

## [Unreleased]

### 追加

- UI の多言語化。既定を英語にし、日本語（`ja`）と簡体字中国語（`zh-cn`）を同梱する。
  表示言語は VS Code / Cursor の設定に従う。コマンド名と設定の説明は
  `package.nls*.json`、実行時のメッセージは `l10n/bundle.l10n.*.json` から引く。
  サイドバーの文言は拡張ホストが翻訳して HTML に埋め込むので、最初に英語が見えてから
  切り替わることはない。ログ（出力チャンネル）は開発者向けの診断なので翻訳しない

### 修正

- Android のドラッグ／スクロールが実用にならなかった問題を修正。mobilecli の
  `device.io.gesture` は Android では 1 アクションが `adb shell input ... motionevent`
  1 回に展開され `duration` も無視されるため、軌跡を貯めて一括送信すると指を離してから
  数十秒かけて再生され、フリック（慣性スクロール）も効かなかった。押しているあいだ
  「最新の 1 点だけ」を送り続ける Android 専用バックエンドへ切り替えた（タップ・長押し・
  長押しドラッグも成立するようにした）。使えるときは `adb shell` を常駐させて motionevent
  を流し、見つからなければ従来の mobilecli 経路へ落ちる
- 停止中デバイスの起動待ち中に、自動接続が別の起動済み端末へ先に繋いでしまうことがあった問題を修正
- MJPEG の multipart 解析がバイト位置と文字位置を取り違えていた問題を修正（フレーム破損・取りこぼし）
- パートごとに `Content-Length` をリセットせず、直前の値を使い回していた問題を修正
- キーバインドの `when` が `view ==` で一致せず、Cmd+Shift+R / H / B が発火していなかった問題を修正
- 既存 mobilecli サーバを再利用したとき、接続の度にポート走査を繰り返していた問題を修正
- MJPEG 直結プロキシの `dispose` で接続とポートが解放されていなかった問題を修正
- 直結ストリームへトークンを要求し、同じマシンの他プロセスから画面を覗けないようにした
- 再接続を指数バックオフにし、失敗が続いても出力チャンネルが膨らまないようにした
- 繋がったままフレームが止まる場合を検出して張り直すようにした
- WDA 経路の軌跡バッファが無制限に伸びていた問題を修正（60 秒のドラッグで 3,601 点・190KB の RPC）
- サイドカーの stdout バッファに上限が無かった問題を修正
- 閉じた WebviewView を provider が保持し続けていた問題を修正
- mobilecli / simhid-server が SIGTERM を無視した場合に孤児として残る問題を修正
- webview が取りこぼした pointerId を保持し続けていた問題を修正
- オーバーレイの DOM をフレーム毎に書き換えていたのをやめた
- フッターの「ストレージ」表示が拡張ディレクトリしか測っていなかったため「拡張ディレクトリ」へ表記を改めた

### 追加

- サイドカー取り込みを表示幅と操作に追従させるようにした（狭いサイドバーでは幅を下げ、
  指を置いているあいだだけ fps を最大 2 倍）。静止画面の停止検出と descriptor の取り直し
- サイドカーが 127.0.0.1 でフレームを直接配信する経路（`directStream` がサイドカー取り込みでも使える）
- `secondarySimulator.captureMode` — ディスプレイ変更通知で撮るか、ポーリングに固定するか
- フッターに受信 fps / 描画 fps / 帯域を出すようにした（直結中は描画側だけ）
- iOS Simulator の画面をサイドカー経由でフレームバッファから直接取り込むようにした
  （`secondarySimulator.captureSource`）。WDA のスクリーンショットはアプリのウィンドウしか
  描かないため、ソフトウェアキーボードとステータスバーが写らなかった
- `secondarySimulator.keyInput` — iOS のキー入力経路を HID / WDA で切り替える。
  HID のキーはハードウェアキーボード扱いになり、iOS がソフトウェアキーボードを出さない
- `Secondary Simulator: Save Screenshot` — 接続中デバイスの画面を保存する
- `Secondary Simulator: Show Logs` — 出力チャンネルを開く
- `Secondary Simulator: Clear Logs` — 出力チャンネルを空にする（VS Code は全文をメモリに持ち、行数の上限を設けられないため）
- `Secondary Simulator: Select Device` を QuickPick 化（従来はビューへフォーカスするだけだった）
- `secondarySimulator.logLevel` — 出力チャンネルへ書くログの詳しさ（既定 info）。
  VS Code は全文をメモリに持ち行数の上限を設けられないため、書く量そのものを絞れるようにした
- ステータスバーに接続中のデバイスと入力経路（HID / WDA）を出すようにした。
  サイドバー下部にも同じラベルを出す（従来 `status` メッセージは webview で捨てられていた）
- 修飾キー付きの入力（`Cmd+A` / `Cmd+C` など）を送れるようにした。
  webview が `Shift` / `Control` / `Alt` / `Meta` を捨てていたため送れなかった。HID 経路のみ
- `Secondary Simulator: Select Device` で停止中のデバイスを選ぶと、その場で起動して接続できるようにした
  （`device.boot`）。従来は「起動していません」で終わっていた
- `Secondary Simulator: Open URL on Device` — 接続中のデバイスでディープリンク / URL を開く（`device.url`）
- スクリーンショット / 再取得 / ログをビュータイトルのアイコンに追加
- `docs/project-review.md` — 全体精査の記録と未対応の提案
- `THIRD-PARTY-NOTICES.md` — 同梱 `@mobilenext/mobilecli` 0.1.64（AGPL-3.0）のライセンス全文と入手先を VSIX に同梱
- README / README_JP の License 節に mobilecli の AGPL 告知を追記

### 変更

- スクリーンショットをビュータイトルのアイコンからプレビュー下の Shot ボタンへ移した（コマンドパレットの `Save Screenshot` は残す）
- サイドバー UI を刷新（ツールバー、端末筐体、待機スピナー、リソースチップ）
- フレームを base64 の文字列で webview へ渡すようにした（形式が環境依存だったため）
- canvas + ImageBitmap をやめ、フレームは `<img>` の data URL か直結 MJPEG で出すようにした
- 非表示や同じデバイスへの繋ぎ直しではサイドカーを作り直さず、表示だけ止める（2 分放置で解放）
- 未使用の入力 API（`tap` / `swipe` / `gesture` ほか）と `ScreenInfo` 型を削除
- `.d.ts` の生成を止めた（VSIX に同梱されていた）
- `npm test` を `node --test test/*.test.js` にした。`package.json` へファイルを 1 つずつ
  並べる形をやめ、テストを足しても登録漏れで素通りしないようにした
- CI に Linux の型チェック / テストジョブを追加（macOS ランナーが枯渇しても壊れたことに気づける）

### 初回リリースまでの内容

- iOS Simulator への HID 直接注入（`native/simhid-server`）と WDA へのフォールバック
- MJPEG 直結ストリーム表示（`secondarySimulator.directStream`）と帯域設定
- Pointer Events の生配信によるドラッグ/ピンチ追従
- サイドバーに接続ランプ、Refresh、Trail / Auto トグル、リソース使用量を表示
- 起動中デバイスへの自動接続（`secondarySimulator.autoConnect`、Disconnect で OFF）
- アクティビティバー名を Secondary Simulator に変更
- CI（型チェック・テスト・VSIX パッケージ）とリリース自動化を追加
