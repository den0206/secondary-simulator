# Changelog

## [Unreleased]

### 修正

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

- iOS Simulator の画面をサイドカー経由でフレームバッファから直接取り込むようにした
  （`secondarySimulator.captureSource`）。WDA のスクリーンショットはアプリのウィンドウしか
  描かないため、ソフトウェアキーボードとステータスバーが写らなかった
- `secondarySimulator.keyInput` — iOS のキー入力経路を HID / WDA で切り替える。
  HID のキーはハードウェアキーボード扱いになり、iOS がソフトウェアキーボードを出さない
- `Secondary Simulator: Save Screenshot` — 接続中デバイスの画面を保存する
- `Secondary Simulator: Show Logs` — 出力チャンネルを開く
- `Secondary Simulator: Clear Logs` — 出力チャンネルを空にする（VS Code は全文をメモリに持ち、行数の上限を設けられないため）
- `Secondary Simulator: Select Device` を QuickPick 化（従来はビューへフォーカスするだけだった）
- スクリーンショット / 再取得 / ログをビュータイトルのアイコンに追加
- `docs/project-review.md` — 全体精査の記録と未対応の提案
- `THIRD-PARTY-NOTICES.md` — 同梱 `@mobilenext/mobilecli` 0.1.64（AGPL-3.0）のライセンス全文と入手先を VSIX に同梱
- README / README_JP の License 節に mobilecli の AGPL 告知を追記

### 変更

- サイドバー UI を刷新（ツールバー、端末筐体、待機スピナー、リソースチップ）
- フレームを base64 の文字列で webview へ渡すようにした（形式が環境依存だったため）
- 未使用の入力 API（`tap` / `swipe` / `gesture` ほか）と `ScreenInfo` 型を削除
- `.d.ts` の生成を止めた（VSIX に同梱されていた）

### 初回リリースまでの内容

- iOS Simulator への HID 直接注入（`native/simhid-server`）と WDA へのフォールバック
- MJPEG 直結ストリーム表示（`secondarySimulator.directStream`）と帯域設定
- Pointer Events の生配信によるドラッグ/ピンチ追従
- サイドバーに接続ランプ、Refresh、Trail / Auto トグル、リソース使用量を表示
- 起動中デバイスへの自動接続（`secondarySimulator.autoConnect`、Disconnect で OFF）
- アクティビティバー名を Secondary Simulator に変更
- CI（型チェック・テスト・VSIX パッケージ）とリリース自動化を追加
