# HID サイドカー — プロトコル設計

策定日: 2026-08-16 / 対象: iOS Simulator 入力経路の HID 直接注入化（Phase 3）
前提知識: [ios-hid-injection.md](./ios-hid-injection.md)（実証済みの HID 注入仕様）

この文書は**設計の合意用**。実装はこの内容が固まってから着手する。

---

## 1. 目的とスコープ

`spikes/simhid.m` の一発実行ツールを、**常駐プロセス（サイドカー）**に育て、
VS Code / Cursor 拡張の入力経路を mobilecli/WDA（約 600ms）から HID 直接注入（約 0.04ms）へ置き換える。

### スコープに含む
- サイドカーの常駐化とプロトコル（拡張ホスト ⇄ サイドカー）
- 拡張ホスト側の `InputBackend` 抽象（HID 経路と WDA 経路を差し替え可能に）
- webview から拡張ホストへ渡す既存メッセージとの対応
- ドラッグのレートリミッタ・ライフサイクル・再接続・エラー通知
- 画面取り込み（`captureStart` / `frame`）。WDA のスクリーンショットにソフトキーボードが
  写らない問題への対策（§3.5）。H.264 化はまだしない

### スコープに含まない（別フェーズ）
- H.264 などコーデックの変更 — [sync-research.md](./sync-research.md) の検討メモ
- Android 経路（scrcpy）
- サイドカーバイナリの署名・公証・VSIX 同梱

---

## 2. 全体構成

```
┌─────────── Webview ───────────┐
│ pointer/keyboード イベント     │
└───────────┬───────────────────┘
            │ postMessage（既存の仕組みをそのまま使う）
┌───────────▼───────────────────┐
│ Extension Host (TypeScript)    │
│   SimulatorInputController     │
│     ├ HidBackend（iOS Sim HID）│
│     ├ AndroidBackend（AdbTouch）│
│     └ WdaBackend（実機・降格） │
└───────────┬───────────────────┘
            │ stdin/stdout に JSON Lines（1行=1メッセージ）
┌───────────▼───────────────────┐
│ simhid-server (ObjC, 常駐)     │
│   SimulatorKit / IndigoHID 注入 │
└────────────────────────────────┘
```

### なぜ stdin/stdout（JSON Lines）か

入力経路の候補は 2 つあった。

| 案 | 経路 | 長所 | 短所 |
|---|---|---|---|
| **A（採用）** | webview → 拡張ホスト → サイドカー(stdin) | 実装が単純・順序保証・ポート管理不要 | postMessage 1ホップ（数ms） |
| B | webview → WebSocket → サイドカー(WSサーバ) | webview 直結で最速 | サイドカーに WS サーバ・ポート探索が必要 |

入力遅延の目標は **< 80ms**。HID 注入が 0.04ms、postMessage は実測でも数 ms なので、
**A 案でも目標を1桁以上下回る。** ドラッグは 60Hz（16ms間隔）で送るので数 ms の 1 ホップは埋もれる。
B 案の複雑さに見合う利得がないため **A 案を採用**する。表示経路（大量のフレーム）とは事情が違う点に注意
— フレームは拡張ホストを通したくないが、入力イベントは頻度が低く順序が重要なので拡張ホスト経由が向く。

> 将来 B が必要になったら `InputBackend` の下にトランスポートを差し替える形で追加できる（§7）。

---

## 3. サイドカーのプロトコル

### 3.1 トランスポート
- 拡張ホストが `child_process.spawn` でサイドカーを1つ起動し、プロセスを保持する
- **拡張ホスト → サイドカー**: stdin に JSON Lines（UTF-8、`\n` 区切り、1行1コマンド）
- **サイドカー → 拡張ホスト**: stdout に JSON Lines（レスポンスと通知）
- stderr はログ専用（人間可読）。プロトコルには使わない
- 1プロセスで複数デバイスを扱えるよう、全コマンドに `device`（UDID）を含める

### 3.2 コマンド（拡張ホスト → サイドカー）

すべて `{ "id": <number>, "cmd": <string>, "device": <udid>, ... }`。
`id` はレスポンスの相関用（fire-and-forget したいものは省略可）。

| cmd | フィールド | 意味 |
|---|---|---|
| `touchDown` | `x, y` | 押下。座標は正規化（§4） |
| `touchMove` | `x, y` | ドラッグ中の移動。**サイドカーが16ms間引きする**（§5） |
| `touchUp` | `x, y` | 解放 |
| `tap` | `x, y` | down→up を1コマンドで（利便用） |
| `touch2Down`/`touch2Move`/`touch2Up` | `x, y, x2, y2` | 2本指（ピンチ等） |
| `button` | `name`（`home`/`lock`） | ハードウェアボタン |
| `keyDown`/`keyUp` | `usage`（USB HID usage code） | 単一キー |
| `modifier` | `bit`（16..20）, `down`（bool） | 修飾キー |
| `text` | `value`（文字列） | ASCII 一括入力（サイドカーが分解） |
| `captureStart` | `fps?`(30), `maxWidth?`(640), `quality?`(0.6), `sink?`(`stdout`), `mode?`(`auto`) | 画面バッファの JPEG 配信を開始（§3.5） |
| `captureConfig` | `fps?`, `maxWidth?`, `quality?` | 配信中の設定を**張り直さずに**変える（§3.5） |
| `captureStop` | — | 同 停止 |
| `captureServe` | `enable`, `port?`, `token?` | フレームの HTTP 直結配信（§3.6）。**`device` を取らない** |
| `ping` | — | 生存確認 |

**設計方針: サイドカーは「薄い」。** down/move/up の粒度でそのまま HID に流し、
ジェスチャの意味解釈（タップ/スワイプ/ロングプレスの判定）は行わない。
判定は**デバイス側**の責務（webview は生の Pointer Events を `touchDown/Move/Up` に変換するだけ）。
サイドカーの責務は「HID 注入」と「レートリミッタの吸収」に限定する。

### 3.3 レスポンス（サイドカー → 拡張ホスト）

`{ "id": <number>, "ok": <bool>, "error": <string?>, "latencyMs": <number?> }`

- `id` を持つコマンドにのみ返す
- `latencyMs` は注入にかかった時間（デバッグ用、任意）

### 3.4 通知（サイドカー → 拡張ホスト、id なし）

`{ "event": <string>, ... }`

| event | フィールド | 意味 |
|---|---|---|
| `ready` | `pid` | 起動完了。シンボル解決に成功した |
| `fatal` | `reason` | シンボル解決失敗・SimulatorKit 読み込み失敗など復帰不能 |
| `portLost` | `device` | HID ポート断を検知（自動でクライアント再生成を試みる） |
| `recovered` | `device` | 再生成に成功した |
| `frame` | `device`, `w`, `h`, `data`（base64 JPEG） | 画面フレーム（`captureStart` 中のみ） |
| `captureAlive` | `device`, `ticks`, `frames`, `noSurface` | 取り込みが生きている合図（約2秒毎）。§3.5 |

### 3.5 画面取り込み（`captureStart` / `frame`）

**なぜサイドカーで撮るか。** WDA(XCTest) のスクリーンショットは「テスト対象アプリの
ウィンドウ」しか描かないため、**ソフトウェアキーボードとステータスバーが写らない**
（iOS 26 / WDA 10.2.4 で実測。`docs/ios-hid-injection.md` §6）。サイドカーは
`SimDeviceIOClient.ioPorts` から `SimDisplayIOSurfaceRenderable` の descriptor を選び、
`maskedFramebufferSurface`（角丸・ノッチのマスク込み）を CoreImage で JPEG にする。
端末のフレームバッファそのものなので、画面に出ているものが全て入る。

- descriptor は ROCK のリモートプロキシで `respondsToSelector:` に答えない。
  **クラス名に埋め込まれたインタフェース名で判定する**。該当は複数あるので、
  実際に面を返すものを選ぶ（外部ディスプレイのぶんは nil を返す）。
- 送るのは **変化したフレームだけ**。`IOSurfaceGetSeed` は静止画面でも動くため、
  直前に送った JPEG とバイト列で比較する（保持は 1 枚ぶん・約 68KB）。
- 取り込みは入力とは別のシリアルキューで回す（JPEG 変換は実測 2ms）。
  stdout は入力の応答と共用なので mutex で 1 行ずつに保つ。親の読み出しが遅いと
  `write` がブロックし、そのぶん取り込みも止まる（＝キューを作らない背圧）。
- 実測（iPhone 17 / 640px / q60）: 1 枚 68KB、静止画面で約 0.5MB/s、
  最大 30fps。WDA 経路（2.9MB/s・アプリのみ）より軽く、写る範囲も広い。

**生存通知（`captureAlive`）と停止検出。** 送るのは変化したフレームだけなので、
**静止画面ではフレームが 1 枚も出ない**。拡張ホストはフレームの途絶だけでは
「画面が動いていない」のか「取り込みが死んだ」のかを区別できないため、
取り込み中は約2秒毎に `captureAlive` を送る。拡張ホスト（`SidecarCapture`）は
これを 1 度でも受け取ってから停止検出（10 秒）を張る
（**通知を送らない古いバイナリを、静止画面のたびに再起動しないため**）。

**descriptor の取り直し。** シミュレータを再起動すると descriptor が古くなり、
`maskedFramebufferSurface` が nil を返し続ける。以前はこれを黙って飛ばすだけで
**画面が固まったまま復帰しなかった**。連続 60 tick（約2秒相当）で
`SimDeviceIOClient` から取り直す。

**`captureConfig` を張り直しの代わりに使う。** 表示幅への追従と操作中の fps 引き上げは
頻繁に起きる（拡張ホストが `ResizeObserver` と `touchDown`/`touchUp` から送る）。
`captureStop` → `captureStart` で作り直すと、その間のフレームが落ちて画面が一瞬止まる。
`captureConfig` は取り込みキュー上で値だけ差し替え、次の tick から効く
（幅や品質が変わっても静止画面だと同じ JPEG になって捨てられるため、
比較対象をその場で落として 1 枚出させる）。

### 3.6 フレームの HTTP 直結配信（`captureServe` / `sink: "http"`）

`sink` が `http` のとき、フレームは stdout を通らない。サイドカーが
127.0.0.1 で `multipart/x-mixed-replace` を配信し、webview の `<img>` が直接受ける。

**なぜ分けるか。** stdout は入力の応答と共用で、しかもブロッキングな fd なので、
親の読み出しが遅れるとフレームの `write` が mutex を握ったまま止まり、
**入力の応答まで巻き込む。** 経路を分けると
この結合が設計から消える。あわせて base64・JSON・postMessage が不要になり、
multipart の復号は Chromium がやる。

- **ポートとトークンは拡張ホストが決めて渡す。** CSP は HTML 生成時に
  `12220`〜`12239` を範囲で許可しており、サイドカーに選ばせると範囲外を掴みうる。
  埋まっていれば `ポートが使えない` で応答し、拡張ホストが次を試す（`MjpegProxy` と同じ形）。
- **127.0.0.1 でだけ待ち受け、トークンが合わないものは 404 で落とす**（存在自体を伏せる）。
  UDID は `xcrun simctl list` で誰でも読めるので、秘密にならない。
- 取り込み側は**待たない**。最新フレームを差し替えて条件変数で起こすだけで、
  接続ごとのスレッドが自分のペースで書く（遅いクライアントは自然にフレームを落とす）。
- **同時接続は 8 本まで、ヘッダの読み取りは 5 秒まで。** トークンが無ければ絵は
  取れないが、接続を積むだけならトークンは要らない。上限が無いとスレッドを
  使い切られる（CLAUDE.md「無制限に伸びる入れ物を作らない」はソケットにも効く）。
- 静止画面では書くものが無く相手の切断に気づけないので、待ちが空振りしたときだけ
  `MSG_PEEK` で覗いて畳む。
- 配信を張れなかった場合、拡張ホストは `sink: "stdout"` で開始し直す。

### 3.7 プッシュ型の取り込み（`mode: "auto"`）

`mode` が `auto`（既定）のとき、`SimDisplayIOSurfaceRenderable` の
**変更通知**にコールバックを登録して、画面が変わった瞬間に撮る
（`registerCallbackWithUUID:damageRectanglesCallback:` と
`…ioSurfaceChangeCallback:`。idb の `FBFramebuffer` が同じ 2 つを使う）。
ポーリングだと平均 16.7ms のサンプリング遅延が構造的に乗るため、ここが
glass-to-glass で一番削れる。

**私有 API なので壊れうる。3 段構えで守る。**

1. `respondsToSelector:` で存在を確かめてから登録する（答えないものは使わない）
2. **コールバックの引数を一切参照しない**。ブロックの型が違っても踏み抜かないよう、
   通知は「変わった」という合図としてだけ扱い、面は毎回読み直す
3. 通知が来ないのに画面が変わっていたら（`IOSurfaceGetSeed` で自己点検）、
   2 回続いた時点で**ポーリングへ自動で戻す**

プッシュ型でもタイマは止めない。変更通知は画面が変わったときしか来ないので、
生存通知（§3.5）と descriptor の取り直しの担い手が要る。そのぶん間隔は
500ms へ寝かせる。フレームのレート制限は `fps` を上限として別に効かせ、
上限を超えた通知は最後の 1 回だけ境界で流す（`touchMove` の coalescing と同じ考え方）。

`mode: "poll"` で従来どおりのポーリングに固定できる（`secondarySimulator.captureMode`）。

---

## 4. 座標系

- webview・拡張ホスト・サイドカーの**全経路で正規化座標 `[0.0, 1.0]` を使う**
- simhid（= HID 注入）は正規化座標をそのまま受けるため、ピクセル変換は不要
- ピクセルが要るのはバックエンドの内側だけ。`WdaBackend` は `touchUp` 時に、
  `AndroidBackend` は送る直前に、`getScreenSize()` で直す
  （`screenSize` 未取得だとここで例外になる。HID 経路にはこの制約はない）
- 画面回転は将来対応。当面は縦向き前提で正規化する

---

## 5. ドラッグのレートリミッタ（重要）

`IndigoHIDMessageForMouseNSEvent` は **drag を前回から約16ms 以内に送ると NULL を返す**
（[ios-hid-injection.md §4](./ios-hid-injection.md) 参照）。

**この吸収はサイドカーの責務とする。**
- webview は生の `pointermove` を好きな頻度で送ってよい（`touchMove`）
- サイドカーは device ごとに「最後に drag を注入した時刻」を持ち、
  **16ms 未満なら最新座標だけ保持して間引く**（coalescing）
- 間引いた最新座標は、次の 16ms 境界かタイマで必ず1回は流す（指を止めても最終位置が届くように）
- `touchUp` は必ず即座に流す（レートリミッタ対象外）

これにより拡張ホスト・webview はレートリミッタを意識しなくてよい。

---

## 6. ライフサイクルと再接続

### 6.1 起動
1. 拡張ホストがデバイス選択時にサイドカーを spawn（未起動なら）
2. サイドカーは起動時にシンボル解決・SimDevice 取得を行い、`ready` を通知
3. 失敗したら `fatal` を通知 → 拡張ホストは **WDA 経路（`WdaBackend`）へ自動降格**

### 6.2 HID ポート断からの復帰
- [ios-hid-injection.md §3](./ios-hid-injection.md) の通り、**`resetHIDSession` は使わない**（むしろ壊す）
- サイドカーは送信エラーを検知したら `portLost` を通知し、
  **クライアントを作り直して**再試行、成功で `recovered`
- 一定回数失敗したら `fatal` → 拡張ホストが WDA へ降格

### 6.3 プロセス死活
- 拡張ホストは `ping`/`pong`（無応答 N 秒で異常とみなす）とプロセス `exit` 監視を持つ
- サイドカーが落ちたら1回だけ再 spawn、それも失敗したら WDA へ降格
- webview 非表示・デバイス切替・拡張 dispose でサイドカーを停止（既存の `stopCapture` 相当のフックに乗せる）

### 6.4 画面消灯の扱い
- 画面が黒くてもポート断とは限らない（自動スリープ）。
  **黒画面だけでは異常判定しない。** 異常判定は送信エラーの有無で行う（§6.2）

---

## 7. 拡張ホスト側の抽象

既存 `SimulatorWebviewProvider` が直接 `MobileCliClient` を呼んでいる箇所を、
`InputBackend` インターフェース越しに変える。

```ts
interface InputBackend {
  readonly kind: 'hid' | 'wda';
  touchDown(x: number, y: number): Promise<void>;
  touchMove(x: number, y: number): Promise<void>;
  touchUp(x: number, y: number): Promise<void>;
  touch2(...): Promise<void>;          // 2本指
  button(name: 'home' | 'lock'): Promise<void>;
  key(usage: number, down: boolean): Promise<void>;
  modifier(bit: number, down: boolean): Promise<void>;
  text(value: string): Promise<void>;
  dispose(): void;
}
```

- **HidBackend**: 上記コマンドを JSON Lines で サイドカーに書き込む。座標変換なし
- **WdaBackend**: 既存の `MobileCliClient`（tap/gesture/inputText/pressButton）をこのIFに適合させる薄いラッパ。
  座標は現行どおりピクセル変換する
- **AndroidBackend**: Android 専用（§7.1）。タッチは `AdbTouch`（常駐 `adb shell`）、
  使えなければ mobilecli。キー・テキスト・ボタンは WdaBackend へ委譲する
- `SimulatorInputController` が起動時にバックエンドを選ぶ:
  iOS Simulator かつ HID 注入が使える → HidBackend、Android → AndroidBackend、
  それ以外（iOS 実機・降格時）→ WdaBackend

### 7.1 Android のタッチを貯めない理由

mobilecli の `device.io.gesture` は、Android では**アクション 1 個 = adb コマンド 1 回**
（`adb shell input touchscreen motionevent down|move|up X Y`）に展開される。
**`duration` は読まれない**（`pause` だけがホスト側の `time.Sleep` になる。
mobilecli `devices/android.go` の `Gesture`）。1 回あたりの往復は 100ms 前後。

そのため WdaBackend の「`touchUp` まで軌跡を貯めて一括送信」を Android に当てると:

1. 240 点のドラッグが adb 242 回になり、**指を離してから数十秒かけて再生される**
2. 各イベントの注入時刻が指の実際の動きと無関係になるため、Android の VelocityTracker が
   速度を拾えず、**フリック（慣性スクロール）が一切効かない**

`tap` は `input tap` 1 回で終わるので影響を受けない（＝タップだけ正常に見える）。

AndroidBackend は貯めずに、押しているあいだ送り続ける。
速い経路は `AdbTouch`（`adb shell` を 1 本張りっぱなしにして `motionevent` を書き込む）。
adb が見つからない・シリアルを解決できないときは mobilecli の `device.io.gesture` へ落ちる。

AdbTouch（主経路）。`DOWN`/`UP` が座標を引数に取れるので、位置決めの MOVE は挟まない:

| 局面 | 送るもの |
|---|---|
| `touchDown` | 何も送らない（タップかドラッグか未確定） |
| slop（12px）超えの `touchMove` | `DOWN(始点)` と、必要なら `MOVE(現在)` |
| 以降の `touchMove` | `MOVE(最新の 1 点)`。前の adb が返るまで次を出さない（溜めない） |
| `touchUp`（動いた） | `UP(終点)`。同じ座標の MOVE を挟まない（離す直前に止まるとフリックが弱くなる） |
| `touchUp`（動いていない・短い） | `device.io.tap` 1 回 |
| 静止のまま 400ms | `DOWN(始点)` を先出しして押しっぱなしを作る |

mobilecli へ落ちたときだけ、次の形になる（Android 側は `pointerDown` / `pointerUp` の座標を**直前の `pointerMove`** からしか取れないため）:

| 局面 | 送るもの |
|---|---|
| slop 超えの `touchMove` | `[pointerMove(始点), pointerDown, pointerMove(現在)]` |
| 以降の `touchMove` | `[pointerMove(最新の 1 点)]` |
| `touchUp`（動いた） | `[pointerMove(終点), pointerUp]` |
| 静止のまま 400ms | `[pointerMove(始点), pointerDown]` |

- `down`..`up` の実時間が指の実時間と一致するので、速度が正しく伝わりフリックが効く
- 送信数は点数ではなく **adb の往復時間**で頭打ちになる（常駐セッション実測 約 20ms、mobilecli 経由は約 70ms）
- 長押しで先出しした `down` は、実際に 400ms 押されるまで次の `move`/`up` を出さない
  （すぐ出すと「速いタップ」になり、長押しも長押し→ドラッグも成立しない）
- `dispose()` は押しっぱなしの指を離す（残すと次のタッチが別のジェスチャーになる）

### 既存メッセージとの対応

webview → 拡張ホストは `SimulatorWebviewProvider.handleMessage` が受け、
コントローラ内で `InputBackend` に振り分ける。入力は生ポインタ（`touch*`）が現行の主経路。

| webview → ホスト | 扱い |
|---|---|
| `touchDown` / `touchMove` / `touchUp` | 1本指。座標は正規化。HID は同名コマンド、WDA は tap/gesture に再構成、Android は押しているあいだ最新点を送り続ける（§7.1） |
| `touch2Down` / `touch2Move` / `touch2Up` | 2本指（ピンチ等） |
| `keypress {key, special, modifiers?}` | ASCII は HID `text`/`key`、非 ASCII は WdaBackend.inputText（§10.3）。`modifiers`（`command`/`control`/`option`/`shift`）があれば `modifier` で挟んだ `keyDown`/`keyUp` を組む（HID 経路のみ。`text` は使えない — project-review.md §5.7）。`special: true` の `up`/`down`/`left`/`right` は HID usage へ。Android は `KEYCODE_DPAD_*`（`device.io.button`） |
| `paste {text}` | クリップボードのテキストを 1 回で送る（`InputBackend.text`。URL 入力用。長さはホスト側で上限） |
| `home` | `button "home"` |
| `back` | iOS: no-op（UI ではボタン無効）。Android は WdaBackend |
| `screenshot` | 接続中デバイスの画面を保存（`device.screenshot` → 保存ダイアログ） |
| `record` | 画面録画の開始/停止をトグル（`device.screenrecord` / `.stop`。保存先はユーザーが選ぶパスを `output` に渡す） |
| `deviceChange {deviceId}` | 空文字ならキャプチャ停止。一覧から消えた選択もこれを送る |
| `bootDevice {deviceId}` | 停止中のデバイスを選んだとき。起動確認のあと `device.boot` して接続（コマンドパレット経由と同じ） |
| `retry` | エラー表示からの復帰。一覧を取り直し、選択中があれば再接続 |
| `showLogs` | 出力チャンネル「Secondary Simulator」を開く |
| `refresh` / `init` | デバイス一覧の再取得。`autoConnect` と見た目の設定も返す |
| `setAutoConnect {enabled}` | `secondarySimulator.autoConnect` を書き戻す |
| `disconnect` | キャプチャ停止。自動接続設定を OFF にする |
| `viewport {width}` | 表示中の実ピクセル幅（CSS 幅 × devicePixelRatio）。取り込みの幅がこれに追従する（`captureMaxWidth` が上限） |

| ホスト → webview | 意味 |
|---|---|
| `devices` | 一覧（`platform` / `state` 付き）。webview は iOS / Android で `<optgroup>` に分ける。`platform` で Back の有効/無効を決める |
| `selectedDevice` | 自動接続した UDID を `<select>` に反映（change は発火しない）。起動を見送ったときも選択を戻す |
| `settings` | `showDeviceFrame` / `showResourceStats`（`secondarySimulator.*` の見た目設定） |
| `recording` | 録画中か（`active: bool`）。Rec ボタンの見た目と効果音。停止時は `ok: bool` も付き、**`false` なら停止音を鳴らさない**（書き出せていないので「保存できた」の合図を出さない） |
| `countdown` | 録画開始前の秒読み（`value: 3→2→1`、`0` で消す）。**進行はホストが持ち**、webview は数字と音を出すだけ |
| `sound` | 効果音（`shutter`）。スクリーンショット保存時など |
| `searching` | 未接続で起動中デバイスを探している |
| `connecting` | 接続開始。最初のフレームまでオーバーレイを出す |
| `autoConnect` | 設定値。Auto ボタンと揃える |
| `streamUrl` / `frame` | 直結 MJPEG（URL に起動毎トークン必須）/ 個別フレーム（`data` は base64 文字列）。どちらも同じ `<img>` に出す（frame は data URL） |
| `pauseStream` | 非表示時に `<img>` の GET を閉じる |
| `resources` | RSS / heap / 子プロセス / 拡張ディレクトリ + 受信 fps・帯域（約 30 秒ごと。WDA や npm キャッシュは含まない）。`#stats` を書き換える。webview は自分が描けた fps を並べて出す（差が落としたフレーム）。**直結中は `direct: true` だけを送る** — フレームが拡張ホストを通らないので受信側は測れず、0 と出すと誤解される |
| `mode` | 入力経路のラベル。文言は表示言語に従う（既定は `Fast mode (HID)` / `Compatible mode (WDA)`）。`null` で隠す。フッターの `#mode` とステータスバーが同じ文字列を使う |
| `disconnected` | 切断 |

旧メッセージ（`tap` / `swipe` / `longPress`）は webview から送らない。WDA 側の tap/gesture は Controller が `touch*` から作る。

---

## 8. 未対応入力と代替（合意が要る点）

[ios-hid-injection.md §7](./ios-hid-injection.md) の通り、以下は HID で動かせなかった。代替で運用する。

| 入力 | HID | 代替（確定） |
|---|---|---|
| スクロールホイール | ✗ | **ドラッグ**で代替（`touchMove` の連続） |
| ホームインジケータのスワイプ | ✗ | **`button "home"`** で代替 |
| Back ボタン | iOS に無し | iOS は no-op、Android は WdaBackend が担当（§10.2） |
| 音量・Siri 等 | ✗ | 未対応（必要なら WdaBackend の `device.io.button` に委譲） |
| 日本語/IME 入力 | ASCII のみ | **WdaBackend.inputText（`device.io.text`）へ委譲**（§10.3） |

`keypress` の非 ASCII（IME 経由の日本語など）は HID で扱えないため、
**「ASCII は HID、それ以外は WdaBackend.inputText」の二段構えで確定**（§10.3）。
コントローラが文字列を ASCII 連続部分と非 ASCII 部分に分割して振り分ける。

---

## 9. ビルド・配布（設計メモ、実装は別フェーズ）

- サイドカーは universal binary（arm64 + x86_64）1本にする
- 開発中は `spikes/` からビルドして拡張の既知パスに置く。配布時は VSIX 同梱＋署名/公証
- Xcode パスは実行時に `xcode-select -p` で解決（[ios-hid-injection.md §1](./ios-hid-injection.md)）

---

## 10. 決定事項

当初の未確定 5 点は以下に確定した。以降の実装はこれに従う。

### 10.1 トランスポート → **stdin/stdout（A案）で確定**
入力イベントは頻度が低く順序が重要なので拡張ホスト経由が向く。HID 注入 0.04ms + postMessage 数ms でも
目標 < 80ms を1桁下回る。WS サーバ・ポート管理の複雑さに見合う利得がない。
将来 B 案が必要になっても `InputBackend` の下でトランスポートだけ差し替えられる（§7）。

### 10.2 Back の扱い → **iOS では no-op（ログのみ）で確定**
iOS に Back ボタンは存在しない。home にマップすると誤操作になるため写像しない。
Android は `WdaBackend` が `device.io.button` で担当する。
UI 面では、iOS 選択時に Back ボタンを無効表示する（webview の `syncBackButton`）。

### 10.3 非 ASCII 入力 → **二段フォールバックで確定**
`text` コマンドは ASCII を HID で送る。非 ASCII（日本語/IME 等）を含む文字は
**`WdaBackend.inputText`（mobilecli の `device.io.text`）へ委譲する**。
iOS Simulator ではデバイス一覧取得等で mobilecli を常に併用しているため、この委譲は常に可能。
コントローラが文字列を「ASCII 連続部分＝HID / 非 ASCII 部分＝WDA」に分割して送る。

### 10.4 プロセス粒度 → **全デバイス1プロセスで確定**
サイドカーは1つだけ spawn し、デバイス（UDID）ごとに HID クライアントを遅延生成してキャッシュする。
`SimServiceContext` 取得などの起動コストを1回で済ませられ、複数デバイス同時プレビューにも対応できる。
入力コマンドはすべて `device`（UDID）を含む（§3.1）。例外はプロセス単位の
`captureServe`（loopback 待ち受け。§3.6）だけ。

### 10.5 降格の可視化 → **控えめに可視化する（確定）**
HID→WDA へ降格したら、`postMessage({type:'mode', text})` で webview フッターの
`#mode` に表示し（既定は `Compatible mode (WDA)`。表示言語に従う）、同じ文字列をステータスバー
（`DeviceStatusBar` / `renderStatus`）にも出す。`Logger` に理由を残す。
常時バナーは出さない。降格は稀かつ「なぜ遅いか」を開発者が知りたい情報なので、状態表示に留める。

---

これらは確定済み。実装はこの設計に沿って進める。
