# プロジェクト精査 — 改善点・新機能・不要な実装

精査日: 2026-08-16 / 対象: `main` (84fb650) 時点の全ソース（TypeScript 約 2,400 行 + webview 約 700 行）

実機・シミュレータを持たない環境での**静的な読み取りと単体テスト**による精査。
実測が要る項目は「未検証」と明記した。既存の実測値は
[sync-research.md](./sync-research.md) を参照している。

---

## 0. 全体の評価

設計そのものは素性が良い。特に次の 3 点は、この規模の拡張では珍しく徹底されている。

- **境界が明示されている** — 座標は常に正規化 [0,1]、私有 API は `native/` の中だけ、
  HID は iOS Simulator 限定。`InputBackend` で経路を足せる形になっている。
- **ライフサイクルを追える** — `Disposable` をフィールドに保持し、子プロセスの pid を公開し、
  `ResourceStats` で自分の消費を計測している。
- **判断の根拠が残っている** — `docs/` に実測値と却下した案が書かれており、
  「なぜこうなっているか」を後から辿れる。

一方で、**最も複雑な箇所（MJPEG の手動パース）にテストが無く、そこに実際の欠陥があった**。
以下、影響の大きい順に挙げる。

凡例: **[修正済]** 本 PR で対応 / **[提案]** 未対応・別 PR 向け

---

## 1. 欠陥（正しさに関わるもの）

### 1.1 MJPEG パーサがバイト位置と文字位置を取り違えていた **[修正済]**

`MjpegCapture.processMjpegStream` は、受信バッファ全体を毎チャンク
`TextDecoder().decode()` で文字列化し、`indexOf` が返した**文字位置**を
`Uint8Array.slice()` の**バイト位置**として使っていた。

```ts
const bufferString = new TextDecoder().decode(this.buffer);
const boundaryIndex = bufferString.indexOf(boundary);   // ← UTF-16 の文字位置
const headerEndIndex = bufferString.indexOf('\r\n\r\n', boundaryIndex);
this.buffer = this.buffer.slice(headerEndIndex + 4);    // ← バイト位置として使用
```

JPEG のバイト列は UTF-8 として妥当ではない。不正なシーケンスは復号時に
U+FFFD 1 文字へ潰れるため、**バイト数と文字数が一致しない**。バッファ先頭に
画像データが残っている状態で境界を探すと位置がずれ、フレームが壊れるか取りこぼす。

実際には「前のパートを `Content-Length` ぴったり消費した直後に境界を探す」ため、
バッファ先頭が ASCII のヘッダだけになり、多くの場合はたまたま一致していた。
ただしこれは**入力が理想的な場合にだけ成り立つ前提**で、パートが分割されて届く
順序次第で崩れる。

→ `MjpegParser` としてバイト列のまま探索するよう書き直し、
`test/mjpeg-parser.test.js` で「あらゆるチャンク分割位置で復元できる」ことを検証した。

### 1.2 `Content-Length` をパート間で使い回していた **[修正済]**

```ts
const contentLengthMatch = headers.match(/Content-Length:\s*(\d+)/i);
if (contentLengthMatch) { contentLength = parseInt(...); }
// ← else が無い。ヘッダが無いパートでは直前の値がそのまま残る
```

`contentLength` はループ外の変数で、ヘッダが無いパートでは前のフレームの長さを
そのまま使って本体を切り出していた。長さの違うフレームが混ざると無関係な
バイト列を JPEG として webview へ流すことになる。
→ パート毎にリセットし、欠落は壊れた入力として扱う。

### 1.3 キーバインドが発火しない `when` 句だった **[修正済]**

```json
{ "command": "simulator.refresh", "key": "cmd+shift+r", "when": "view == simulatorView" }
```

`view` はビュータイトルのメニュー（`menus.view/title`）用のコンテキストキーで、
キーバインドの評価時には設定されない。`Cmd+Shift+R` / `H` / `B` は
**宣言されているだけで一度も発火していなかった**。
→ `focusedView == simulatorView` へ修正。

### 1.4 既存 mobilecli サーバ再利用時にポート走査を繰り返していた **[修正済]**

`launchServer()` は稼働中のサーバを見つけると `serverPort` だけ設定して返るが、
`mobilecliServerProcess` は `null` のままだった。判定に使う `isServerRunning()` は
プロセスの有無を見ているため常に `false` を返し、**接続の度に
101 ポート × 2 リクエストの走査をやり直していた**。
→ 掴んでいるかを `serverReady` で持ち、生存確認だけで済ませる。
あわせて `/health` の走査を並列化した（直列だと最悪 101 秒）。

### 1.5 `MjpegProxy.dispose()` で接続もポートも解放されない **[修正済]**

`server.close()` は新規受付を止めるだけで、確立済み接続の終了を待つ。
MJPEG は**終わらないストリーム**なので、この待ちは永久に終わらない。
→ `closeAllConnections()` を先に呼ぶ。テストで同一ポートを再取得できることを確認した。

---

## 2. セキュリティ

### 2.1 直結ストリームが同一マシンの任意プロセスへ開いていた **[修正済]**

`directStream` 有効時、`MjpegProxy` は `127.0.0.1:12200` で待ち受け、
`/stream?device=<UDID>` に GET すれば**誰でも**画面を受け取れた。
外部からは届かないが、同じマシンで動く任意のプロセス、および
任意のブラウザタブ（`<img src="http://localhost:12200/...">`）からは届く。
UDID は `xcrun simctl list` で誰でも読めるので、秘密ではない。

→ 起動毎に生成する 24 バイトのトークンを URL へ載せ、経路とトークンが
揃わないリクエストは 404 で落とす（存在自体を伏せる）。
比較は `timingSafeEqual`。`test/mjpeg-proxy.test.js` で検証した。

### 2.2 残っている論点 **[提案]**

- **トークンは webview の DOM に残る** — `<img src>` に載るため、webview 内で動く
  スクリプトからは読める。CSP でインラインスクリプトを禁じているので現状の
  リスクは低いが、`Sec-Fetch-Site` の検証を足すとより堅い。
- **`WdaSettings` が `lsof` の出力から WDA を探す** — 見つけたポートへ設定を POST する。
  同名プロセスが他にいると誤爆しうる。実害は「他人の WDA の画質が変わる」程度だが、
  mobilecli 側から WDA のポートを取れるならそちらが正しい。

---

## 3. 性能

### 3.1 パースが O(n²) だった **[修正済]**

チャンク毎に `new Uint8Array(全長)` を確保して詰め直し、消費の度に `slice()` で
先頭を落としていた。加えて境界探索でバッファ全体を毎回文字列化していた。
`sync-research.md` §0-3 でも「コードとしては O(n²) で危ういので整理はすべき」と
指摘されていた箇所。

→ 読み出し位置を進めるだけにし、文字列化はヘッダ部分（ASCII）に限定した。
100KB × 60 フレーム（約 6MB）を **10ms** で処理する（テスト §9 で計測）。

なお実測上のボトルネックは**入力の往復遅延**であってパースではない
（`sync-research.md` §1.1: パースは 0.05–0.2ms/frame）。この修正は
速度よりも**正しさと、バッファが暴れないこと**が主眼。

### 3.2 フレームの受け渡しが形式依存だった **[修正済]**

`postMessage({type:'frame', data: Uint8Array})` は、シリアライザ次第で
`{"0":255,"1":216,...}` や `{type:'Buffer',data:[...]}` に化ける。
webview 側が 3 通りの形を推測していたのは、**どれで届くかが環境依存だった**ため。
数値配列へ化けた場合、107KB のフレームが数倍の JSON になる。

→ base64 の文字列で送る形に固定した（形が一意に決まり、膨張は 4/3 倍で頭打ち）。
受け側は旧形式も引き続き受ける。
**実環境での帯域・CPU の改善幅は未検証**（デバイスが要る）。

### 3.3 再接続が無限・等間隔だった **[修正済]**

デバイスが落ちている間、500ms 固定で永久に再接続を試み、1 回ごとにログが
2 行以上増えていた。`OutputChannel` は全文をメモリに持つため、放置すると
際限なく膨らむ。CLAUDE.md の「無制限に伸びる入れ物を作らない」に反していた。
→ 500ms から倍々で最大 10 秒。記録は最初の 3 回まで。

### 3.4 繋がったまま止まったストリームを検出できない **[修正済]**

旧実装には「5 秒バウンダリが見つからなければリセット」という検出があったが、
チャンクが届いたときにしか評価されないため、**無音になった場合は働かなかった**。
→ フレーム到着で張り直す停止タイマー（15 秒）へ置き換えた。

---

## 3.5 メモリ・リソースの監査

CLAUDE.md の「増える一方の入れ物を作らない」「確保したものは必ず捨てる」に照らして、
**確保するもの（タイマー・リスナー・子プロセス・バッファ・ソケット）を全て列挙し、
解放パスを 1 つずつ辿った**。結果、上限も解放も無い箇所が 4 つ見つかった。

### 3.5.1 WDA 経路の軌跡バッファが無制限だった **[修正済]**

`WdaBackend.touchMove` は 60Hz で届くが `this.points.push()` に上限が無く、
`touchUp` が来るまで伸び続ける。**`touchUp` を取りこぼすと永久に残る**
（webview のリロード、ポインタ喪失、ドラッグ中の HID→WDA 降格など）。

実測（`test/memory-leak.test.js`）:

| | 修正前 | 修正後 |
|---|---|---|
| 60 秒ドラッグ後の保持点数 | 3,601 点 | 150 点 |
| 離した瞬間の `device.io.gesture` | 3,604 action / 約 190KB | 215 action / 約 8KB |
| move を 10 倍流した場合 | 36,000 点 超 | 212 点 |

→ 中間点を 1 つおきに間引いて 240 点で頭打ちにした。始点・終点と各点の `t` は
残すので、ドラッグの向き・距離・所要時間は変わらない。

### 3.5.2 サイドカーの stdout バッファが無制限だった **[修正済]**

`SimhidSidecar.stdoutBuf += chunk` は改行が来ない限り伸び続ける。
JSON Lines なので 1 行が巨大になること自体がプロトコル違反だが、
上限が無いと不正な出力で拡張ホストのメモリを圧迫できる。→ 1MB で捨てる。

### 3.5.3 破棄済みの WebviewView を保持していた **[修正済]**

`onDidDispose` が `stopCapture` などは呼ぶものの `this.view` を落としていなかった。
ビューを閉じても provider が `WebviewView` を掴んだままになり、
webview の内容ごと参照が残る。→ 自分のビューであれば `undefined` にする
（差し替えで新しいビューが入っている場合は消さない）。

### 3.5.4 子プロセスが SIGTERM を無視すると残る **[修正済]**

`mobilecli` と `simhid-server` の停止は `kill()`（SIGTERM）のみだった。
無視されると**孤児として残り、ポートと数十 MB を占有し続ける**。
→ 猶予（1〜2 秒）後に SIGKILL する。タイマーは `unref` するので
拡張ホストの終了を遅らせない。

### 3.5.5 webview 側

- **取りこぼした `pointerId` が Map に残っていた** **[修正済]** —
  `pointerup` / `pointercancel` を逃すと残り、タッチ環境では `pointerId` が
  毎回変わるため押した回数だけ増える。10 件で頭打ちにした。
- **`setOverlayVisible` がフレーム毎に DOM を書き換えていた** **[修正済]** —
  26Hz で `querySelector` + `classList` + `style` を叩いていた。リークではないが
  無駄なので、状態が変わったときだけ触るようにした
  （表示要素の `img` ⇄ `canvas` 切替は必ず反映する）。
- `frameQueue`（上限 1）・`trailPoints`（上限 40）・リップル要素（400ms で自己削除）・
  `currentBitmap`（差し替え時に `close()`）は元から上限があり、問題なし。

### 3.5.6 問題が無かった箇所（確認済み）

- `MjpegParser` — バウンダリ待ちの保持は boundary 長未満（ゴミ 20MB を流しても 15B）。
- `MjpegCapture` — `stallTimer` / `reconnectTimer` は `stop()` / `dispose()` で解放。
  20 個生成して dispose するとタイマー数が元に戻ることをテストで確認。
- `MjpegProxy` — `closeAllConnections()` により 10 回の起動/破棄で同じポートを取り直せる。
- `SimhidSidecar.pending` — プロセス終了・timeout・dispose の全経路で `delete` + `clearTimeout`。
- `SimulatorWebviewProvider` の `Disposable` 3 種 — `resolveWebviewView` の冒頭で前回分を破棄。
- `ResourceStats` のサイズキャッシュ — 単一の数値。

### 3.5.7 残る制約 — 出力チャンネル **[一部対応]**

**`Logger` の `OutputChannel` は VS Code が全文をメモリに保持する。**
拡張側から古い行を捨てる API は `clear()` しか無く、行数の上限は設けられない。
→ `Secondary Simulator: Clear Logs` を追加し、手動で空にできるようにした。
自動で減らすには書く量を絞るしかないので、本 PR では再接続ログを絞っている（§3.3）。
`Logger.debug` は常に出力されるため、`secondarySimulator.logLevel` で
既定を info に落とすのが次の一手（§5.4）。

### 3.5.8 「ストレージ／キャッシュの削除機能」は要るか → **不要** *(調査結果)*

結論から言うと、**この拡張には削除すべきストレージが存在しない**。
「キャッシュ削除」コマンドを足すと、消す対象が無いか、他者の領域を壊すことになる。

調査した範囲:

| 対象 | 状況 |
|---|---|
| `globalState` / `workspaceState` / `globalStorageUri` / `secrets` | **使用箇所ゼロ**（CLAUDE.md「永続ストレージは使わない」が守られている） |
| 拡張によるファイル書き込み | スクリーンショットの保存のみ。**保存先はユーザーが選ぶ**ので、拡張のキャッシュではない |
| webview の `setState` | `{trail: boolean}` の 1 個だけ。VS Code が管理する数バイト |
| 設定 | `secondarySimulator.*` の 4 項目。キャッシュではなくユーザーの意図 |
| 拡張ディレクトリ | VSIX の同梱物。**実行中に増えない**ので、`ResourceStats` が起動時に一度だけ測っている |

一方、**拡張の外**には実行によって増えるものがある。ただしいずれも
**この拡張の所有物ではない**ため、拡張から消すのは適切でない。

- **mobilecli が入れる WebDriverAgent** — mobilecli が GitHub から取得して展開する
  （バイナリ中に `WebDriverAgentFromGitHub` / `Unzipped WebDriverAgent to %s`）。
  消せば次回の接続で再ダウンロードが走るだけで、パスも版依存。
  WDA の入れ直しが要る場面はあるが、それは mobilecli 側の責務。
- **npx フォールバック時の npm キャッシュ** — 同梱バイナリが使えないとき
  `npx -y @mobilenext/mobilecli@X` で実行するため `~/.npm/_npx` に落ちる。
  npm 全体で共有される領域なので、拡張が消してよいものではない（`npm cache clean` の領域）。

**副作用として分かったこと**: フッターの「ストレージ」表示は拡張ディレクトリしか
測っておらず、上記 2 つは含まれない。数字の意味が誤解されるので
**「拡張ディレクトリ」へ表記を改め**、ツールチップに範囲を明記した。

将来 永続ストレージを持つことになった場合（録画の一時ファイルなど）は、
**その時点で削除コマンドを用意する**。CLAUDE.md の「どうしても必要なら理由をここに書き、
`ResourceStats` のサイズキャッシュも外す」がその入口になる。

## 4. 不要な実装（削除したもの・すべきもの）

### 4.1 `SimulatorInputController` の高レベル入力 API **[修正済・削除]**

`tap` / `doubleTap` / `longPress` / `swipe` / `gesture` / `modifier` の 6 メソッド（約 60 行）は、
生ポインタ経路（Phase 1）へ移行して以降**どこからも呼ばれていない**。
クラスのドキュメントコメントも「既存 webview メッセージ（tap/swipe/gesture/…）を変換する」
と、現在は存在しないメッセージを説明したままだった。

ジェスチャー判定はデバイス側の責務、という CLAUDE.md の方針からしても、
上位で組み立て直す道は塞がっている。→ 削除し、コメントを実態へ合わせた。

### 4.2 `ScreenInfo` 型 **[修正済・削除]** — 定義のみで未参照。

### 4.3 `.d.ts` / `.d.ts.map` の生成 **[修正済・削除]**

`tsconfig.json` の `declaration` / `declarationMap` が有効だった。
拡張は誰にも `import` されないので型定義に用途が無く、`.vscodeignore` も
除外していないため **VSIX に同梱されていた**。→ 出力を止めた。

### 4.4 残しておくもの（判断）

- **`CaptureStrategy` インターフェース** — 実装は `MjpegCapture` だけだが、
  H.264 / scrcpy 経路が `docs/sync-research.md` の計画にある。差し替え点として残す。
- **`InputBackend.modifier()` / `HidModifier`** — 上位の呼び出しは消したが、
  サイドカープロトコル（`docs/sidecar-protocol.md`）が定義しており
  `native/simhid-server` も実装している。プロトコル側の機能なので残す。
  ただし**拡張は修飾キーを一度も送っていない**（→ §5.4）。
- **`SimhidSidecar.isFatal()`** — 現状テストからのみ使用。状態の問い合わせとしては
  自然な API なので残す。
- **`spikes/`** — 調査時の使い捨てコード。`.vscodeignore` で VSIX からは除外済み。
  `docs/` から参照されているため、履歴として残す価値がある。

---

## 5. 追加したほうがよい機能

### 5.1 スクリーンショットの保存 **[実装済]**

`simulator.screenshot`。`device.screenshot` で 1 枚取り、保存先を尋ねて書き出す。
応答の形は mobilecli の版で変わるため、生 base64 / data URL / `{data}` / `{base64}` 等を
受けられるようにして `Screenshot.ts` へ隔離し、単体テストを付けた。
**RPC の実際の応答形式は未検証**（デバイスが要る）。想定外の形なら
エラーメッセージを出して終わる。

### 5.2 コマンドパレットからのデバイス選択 **[実装済]**

`simulator.selectDevice` は**ビューへフォーカスするだけで、実際には何も選べなかった**。
QuickPick で一覧から選んで接続する形にし、起動していない端末はその場で分かるようにした。

### 5.3 ログへの導線 **[実装済]**

`Logger.show()` は実装されていたが**呼ぶ導線がどこにも無かった**。
トラブルシューティングは README で「出力チャンネルを見よ」と案内しているのに、
そこへ辿り着く手段が無い状態だった。→ `simulator.showLogs` を追加し、
ビュータイトルにも並べた。

### 5.4 mobilecli の RPC を使うもの

RPC 名は同梱バイナリのシンボル表で確認済み（`server.URLParams` / `server.DeviceBootParams` 等）。

| 機能 | RPC | 状況 |
|---|---|---|
| ディープリンクを開く | `device.url` | **[実装済]** `Secondary Simulator: Open URL on Device`（§5.6） |
| デバイスの起動 | `device.boot` | **[実装済]** QuickPick で停止中を選ぶと起動して繋ぐ（§5.5） |
| 画面の回転 | `device.io.orientation.set` / `.get` | **[提案]** 横向きの確認にシミュレータへ戻らなくて済む。値の表記（`portrait` / `PORTRAIT`）が binary からは確定できず、実機確認が要る |
| 画面録画 | `device.screenrecord` / `.stop` | **[提案]** 不具合報告用。保存先の扱いは screenshot と同じ形にできる |
| アプリの一覧・起動 | `device.apps.list` / `.launch` | **[提案]** 対象アプリへ直接飛べる |

### 5.5 停止中のデバイスを起動する **[実装済]**

`Select Device` で停止していたデバイスを選ぶと「起動していません」で終わっていた。
`device.boot` を投げ、一覧に `Booted` として現れるまで待ってから接続するようにした
（2 秒 × 45 回 = 90 秒で打ち切る。起動要求の受理と起動完了は別なので待ちが要る）。

### 5.6 ディープリンクを開く **[実装済]**

`Secondary Simulator: Open URL on Device`。接続中のデバイスへ `device.url` を投げる。
**RPC の実際の応答は未検証**（デバイスが要る）。失敗はメッセージを出して終わる。

### 5.7 修飾キーの送出 **[実装済]**

`HidModifier` とサイドカーの `modifier` コマンドは揃っていたのに、webview が
`Shift` / `Control` / `Alt` / `Meta` を捨てていた（`keydown` で早期 return）ため
Cmd+A / Cmd+C が送れなかった。

webview は Cmd/Ctrl/Option を伴うときだけ `modifiers` を付けて送り、
`SimulatorInputController.keyCombo` が modifier で挟んだ `keyDown`/`keyUp` を組む。

**`text` コマンドは使えない。** サイドカーの `injectText` はバースト先頭の取りこぼし対策に
Shift の捨てイベントを先に送るので、Cmd 押下中に呼ぶと Cmd+Shift が成立してしまう。
そのため ASCII→usage の表を拡張ホスト側にも持つ（`usageForAsciiChar`。native の
`usageForChar` と同じ表。二重管理になるが、これが理由）。

押した修飾キーは `finally` で必ず離す。残ると以降の入力が全て Cmd 付きとして扱われるため、
ここは失敗しても解放を止めない（`test/modifier-keys.test.js` §7）。

WDA（`device.io.text`）は修飾キーを扱えないので、HID 経路のときだけ送る。

### 5.8 ログレベル設定 **[実装済]**

`secondarySimulator.logLevel`（`off` / `error` / `warn` / `info` / `debug`、既定 `info`）。
`Logger.debug` が常に出ていたのを既定で落とす。`OutputChannel` は VS Code が全文を
メモリに持ち古い行を捨てる API が無い（§3.5.7）ため、**書く量を絞ることが唯一の手段**。

閾値は写しをフィールドに持つ（`log()` はメッセージ受信ごとに呼ばれるので、
毎回 `getConfiguration` しない）。設定変更時に `Logger.refreshLevel()` で取り込む。

### 5.9 ステータスバー表示 **[実装済]**

接続中のデバイス名と入力経路（HID / WDA）をステータスバーへ出す。押すと
`simulator.selectDevice` へ飛ぶ。未接続のときは隠す（常駐する情報ではない）。

webview 側も同じラベルをフッターに出す。**HID→WDA の降格は無音で起きる**ので、
遅くなった理由が見えるようにするのが主目的。表示文字列の組み立ては
`renderStatus`（vscode に触らない純粋関数）に分け、`test/status-view.test.js` で検証する。

フッターは `#mode`（textContent）と `#stats`（innerHTML）に分けた。リソース更新が
30 秒ごとに innerHTML を作り直すため、経路の表示を巻き込ませないため。

### 5.10 残る提案 **[提案]**

- **Android の帯域設定** — `streamScale` / `streamQuality` は iOS 専用
  （WDA の設定を叩く実装）。Android にも相当の調整が要る。
- **`directStream` の既定化** — Phase 2 の本命だが実験扱いのまま。
  実機で確認できたら既定を反転したい。

---

## 6. 開発基盤

- **[提案] Lint / フォーマッタが無い** — ESLint も Prettier も設定が無い。
  インデントや引用符は概ね揃っているが、規約は人の目に頼っている。
- **[修正済] テストの登録が手作業** — `package.json` の `test` が個々のファイルを
  直列に並べる形で、足し忘れても気づけなかった。`node --test test/*.test.js` にして
  ファイルを置くだけで走るようにした。`*.device-test.js` は `*.test.js` に一致しないので
  従来どおり除外される。各テストは `process.exit` で結果を返す素の script のままで、
  `node --test` は終了コードと未捕捉例外の両方を失敗として扱う（動作確認済み）。
- **[修正済] CI が macOS だけ** — ネイティブビルドと VSIX には macOS が要るが、
  型チェックとテストは Linux でも走る。`quick-check`（ubuntu-latest）を足したので、
  macOS ランナーの枯渇時にも壊れたことに気づける。
- **[提案] README の二重管理** — `README.md` と `README_JP.md` が同じ内容を持ち、
  片方だけ古くなる。本 PR でも両方へ同じ変更を入れている。

---

## 7. 本 PR で変更した範囲

| 分類 | 対象 |
|---|---|
| 欠陥修正 | MJPEG パース（§1.1 §1.2）、キーバインド（§1.3）、サーバ再利用（§1.4）、プロキシ解放（§1.5） |
| セキュリティ | 直結ストリームのトークン（§2.1） |
| 性能・堅牢性 | パースの計算量（§3.1）、フレーム転送形式（§3.2）、再接続（§3.3）、停止検出（§3.4） |
| メモリ・リソース | 軌跡バッファ（§3.5.1）、stdout バッファ（§3.5.2）、破棄済みビューの保持（§3.5.3）、子プロセスの残留（§3.5.4）、pointer 保持と毎フレーム DOM 更新（§3.5.5） |
| 削除 | 未使用の入力 API・型・宣言ファイル出力（§4.1–4.3） |
| 追加 | スクリーンショット・デバイス選択・ログ表示（§5.1–5.3） |
| テスト | 新規 78 項目（MJPEG パーサ 26 / プロキシ 13 / スクリーンショット 17 / リーク 18 / フレーム受信 4）。合計 135 項目 |

**実機での検証は行っていない。** 特に §3.2（フレーム転送）と §5.1（スクリーンショット）は
デバイスに繋いだ確認が要る。

---

## 8. 第 2 次（2026-08-17）— §5.4 / §6 の残りに着手

前回「未対応の提案」として残した項目のうち、**外部の確認を待たずに閉じられるもの**を実装した。

| 分類 | 対象 |
|---|---|
| 追加（UX） | 修飾キーの送出（§5.7）、ステータスバー表示（§5.9）、停止中デバイスの起動（§5.5）、ディープリンク（§5.6） |
| 追加（運用） | ログレベル設定（§5.8） |
| 開発基盤 | テスト登録の自動化・Linux CI（§6） |
| テスト | 新規 3 ファイル 43 項目（修飾キー 22 / ログレベル 12 / ステータス 9）＋ webview 8 項目 |

**実機での検証は行っていない。** デバイスに繋いだ確認が要るのは次の 3 点。

- **修飾キー（§5.7）** — HID の `modifier` + `keyDown` が iOS Simulator 側で
  Cmd+A として解釈されるか。`usageForAsciiChar` の表は native と一致させてあるが、
  修飾キーを押したままキーを送る順序は実測していない。
- **`device.boot`（§5.5）** — RPC 名とパラメータ（`deviceId`）は同梱バイナリの
  シンボル表で確認済みだが、応答の形と「起動完了」の判定は未検証。
  一覧の `Booted` を待つ形にしているので、応答が空でも動くはず。
- **`device.url`（§5.6）** — 同上（`server.URLParams` / `json:"url"`）。

残っている提案は §5.10（Android の帯域設定・`directStream` の既定化）、
§5.4 の表（回転・録画・アプリ一覧）、§2.2（`Sec-Fetch-Site`・WDA ポート取得）、
§6 の Lint / README の二重管理。
