# 改善提案 — 追加機能と UI/UX

作成日: 2026-08-19 / 対象: `main` 時点の全ソース（`src/` + `media/webview/`）

`docs/project-review.md`（第 1 次・第 2 次）で挙がった提案のうち**未対応のもの**と、
今回あらためて読み直して見つけた項目をまとめる。
実機・シミュレータを持たない環境での**静的な読み取り**による整理で、
実測が要るものは「実機検証が要る」と明記した。

各項目に **手間**（S: 半日以下 / M: 1〜2 日 / L: それ以上）と **リスク**、
**実機検証の要否**を付けた。着手の可否を判断するための材料であって、
「全部やる」ことを前提にしていない。

凡例: **[実装済]** 本ブランチで対応 / **[提案]** 未対応 / **[見送り]** 判断して見送り

---

## 補足 — 同梱バイナリのシンボル表から確定したこと

初版では「実機で確認しないと分からない」としていた点が、
`node_modules/@mobilenext/mobilecli/bin/` のシンボル表と埋め込み文字列から確定した。
**実機検証を待たずに閉じられた項目がある**ので、先に記録しておく。

| 事項 | 確定した内容 | 根拠（バイナリ内の文字列） |
|---|---|---|
| 向きの値 | **`portrait` / `landscape` の小文字のみ** | `invalid orientation value '%s', must be 'portrait' or 'landscape'` |
| 向きの RPC | `device.io.orientation.get` / `.set`、引数は `{deviceId, orientation}` | `'params' is required with fields: deviceId, orientation` |
| 録画の RPC | `device.screenrecord` / `device.screenrecord.stop`、引数は `{deviceId, output}` | `'params' is required with fields: deviceId, output` |
| 録画の出力先 | **`output` はホスト側の保存先パス**。mobilecli が自分で書く | `server.ScreenRecordParams` / `Pulling recording from device...` |
| ハードウェアキー | `DPAD_UP/DOWN/LEFT/RIGHT/CENTER`・`ENTER` も `device.io.button` で送れる | `KEYCODE_DPAD_RIGHT` ほか |
| アプリ操作 | `device.apps.list` / `.launch` / `.terminate` / `.install` / `.uninstall` / `device.apps.foreground` | `server.AppsListParams` ほか |
| **画面取り込みの帯域** | **`device.screencapture` は `scale` と `quality` を受ける** | `json:"scale,omitempty"` / `json:"quality,omitempty"` / `JPEG quality (1-100, only applies if format is jpeg)` |

最後の 1 行が C-1 の前提を変える。初版では「Android を絞るには adb 経路へ寄せる話になり、
**境界（adb は `AdbTouch` だけ）に触る設計判断が要る**」と書いたが、これは**誤り**だった。
`MjpegCapture` が投げている JSON にパラメータを 2 つ足すだけで、**iOS・Android の両方**が
同じ経路で絞れる（→ C-1 に追記）。

---

## 0. 先に要点

現状の完成度は高い。境界（正規化座標・私有 API の隔離・`InputBackend`）が守られ、
メモリとライフサイクルの規律も効いている。そのうえで**ユーザーの体験に直接効く穴**は
次の 3 つに集約される。

1. **表示できる場所がサイドバーしかない** — 幅 300px 前後に端末を押し込んでいる。
   エディタタブへ出せると、そのまま「もう 1 枚のディスプレイ」になる（→ B-1）。
2. **端末の操作が Home / Back の 2 つしかない** — 回転・音量・電源・アプリ切替が無い。
   筐体の側面ボタンは**描かれているだけで押せない**（→ A-1, B-2）。
3. **帯域設定が効かない組み合わせがある** — `streamScale` / `streamQuality` は
   実質「iOS かつ `directStream` ON」のときだけ効く。Android は全解像度・無制限で
   流れ続ける（実測 2.9MB/s）。**設定画面に出ているのに効かない**のが問題（→ C-1）。

以下、A: 機能追加 / B: UI・UX / C: 既存機能の穴 / D: 開発基盤 の順。

---

## A. 追加したほうがよい機能

### A-1. 画面の回転 **[実装済]**

`docs/project-review.md` §5.4 で提案されたまま。横向きの確認のために
シミュレータ本体へ戻る必要がある。

- RPC: `device.io.orientation.set` / `.get`、引数は `{deviceId, orientation}`
- **値は `portrait` / `landscape` の小文字で確定**（上の「補足」参照）。初版で
  「実機で 1 回叩かないと決まらない」としたのは誤りで、バイナリの検証メッセージに出ていた
- `.get` の**応答の形は版に依存する**ので、`decodeOrientation`（`src/simulator/Orientation.ts`）へ
  隔離して単体テストを付けた。読めなければ `null` を返し、**縦だと決めつけない**
  （決めつけるとトグルが逆へ回り「押しても戻る」になる）
- webview 側は `.phone-frame` が縦長固定なので、横向きのときは `body.landscape` で
  `max-width` と角丸を緩める（CSS だけで済む）
- Android は `adb shell settings put system user_rotation` でも代替できるが、
  **`AdbTouch` 以外から adb を生やさない**という境界に反するので mobilecli 経由に寄せた

### A-2. ハードウェアボタン（音量 / 電源 / アプリ切替）**[提案]** *(手間 S / リスク 低)*

`MobileCliClient.pressButton` は `POWER` / `VOLUME_UP` / `VOLUME_DOWN` / `APP_SWITCH` を
**型としては持っているのに、どこからも呼ばれていない**（呼ばれているのは `HOME` / `BACK` のみ）。

しかも `media/webview/index.html` には `side-mute` / `side-vol` / `side-power` の
3 つの `<span>` が既にあり、CSS で筐体の側面ボタンとして描かれている。
**見た目だけあって押せない。** ここに `click` を付けるのが最短で、
新しい UI 要素を足さずに操作が 3 つ増える（→ B-2 と一体）。

- `APP_SWITCH` は Android のみ。iOS では無効化する（`btn-back` と同じ扱い）。
- iOS Simulator の HID 経路でも `simhid-server` 側にボタンのコマンドがあるか要確認。
  無ければ `WdaBackend` へ委譲する（キー・テキストと同じ扱い）。

### A-3. クリップボードのテキストをデバイスへ送る **[実装済]**

いまキー入力は `keydown` の 1 文字ずつしか送れない。
**URL やテスト用のメールアドレスを入れるのに 30 回キーを叩く**ことになる。

- webview の `paste` イベントを拾い、`device.io.text`（HID なら `injectText`）へ 1 回で流す。
- `Cmd+V` は現状 `modifiers` 付きの `v` として**デバイス側へ送られてしまう**ので、
  webview 側で先に握る必要がある。
- 逆方向（デバイス → ホストのクリップボード）は mobilecli に相当 RPC が見当たらないので対象外。

### A-4. アプリの一覧・起動 **[提案]** *(手間 M / リスク 中)*

RPC: `device.apps.list` / `device.apps.launch`。
開発中のアプリへ直接飛べる。`simulator.openUrl`（ディープリンク）と並ぶ導線で、
コマンドパレット + QuickPick に載せるのが素直（新しい UI を webview に足さない）。

- 応答の形が未検証。`decodeScreenshotResult` と同じく**解釈を 1 ファイルに隔離**して
  単体テストを付ける形にすれば、実機が無くても骨組みは書ける。
- 「直前に起動したアプリを再起動」まで用意すると、ホットリロードしない環境で効く。

### A-5. 画面録画 **[実装済]**

RPC: `device.screenrecord` / `.stop`。不具合報告用。
保存先はスクリーンショットと同じく**ユーザーに尋ねる**形にできるので、
「永続ストレージを持たない」方針を崩さずに済む。

初版で懸念した「一時ファイルの置き場が拡張から見えない」は解消した。
**`output` はホスト側の保存先パスで、mobilecli が直接そこへ書く**（上の「補足」参照）。
保存先を先に尋ねる形にできるので、拡張は一時ファイルを一切持たない。

CLAUDE.md の「上限と破棄条件をセットで書く」に従い、**録画は必ず終わる**ようにした。

- **10 分**で自動停止（`MAX_RECORDING_MS`。タイマーは `unref` する）
- **切断・デバイス切替・`dispose`** でも止める（別端末を録り続けない）
- 停止が失敗しても状態は戻す（戻さないと「録画中」のまま二度と止められない）
- 録画中は Rec ボタンの色と点滅で分かるようにした（無音で走り続けない）

### A-6. 診断情報のコピー **[提案]** *(手間 S / リスク 低)*

`Secondary Simulator: Copy Diagnostics`。
拡張バージョン・VS Code 版・mobilecli 版・`simhid-server` の有無と `--check` 結果・
選択中のデバイスと入力経路・直近のエラーを 1 つのテキストにまとめてクリップボードへ。

トラブル報告の往復が減る。`scripts/check-xcode-hid.sh` が既に
「HID が生きているか」を判定できるので、その結果をここに載せられる。

---

## B. UI / UX の改善

### B-1. エディタタブに開く（Open in Editor）**[見送り]** *(手間 M / リスク 中)*

いまビューは `viewsContainers.activitybar` の **WebviewView 一択**。
サイドバーの幅（既定 300px 前後）に端末を押し込んでいるため、
`.phone-frame` の `max-width: 420px` を活かせる場面がほとんど無い。

- `vscode.window.createWebviewPanel` で同じ HTML を開く
  `simulator.openInEditor` コマンドを足す。**エディタ領域に置けば横に並べられる**ので、
  コードと画面を同時に見るという本来の用途が成立する。
- 実装上の要点は**現在の provider が「ビューは 1 つ」を前提にしている**こと
  （`this.view` が単数、`postMessage` が 1 か所）。パネルとビューの両方へ同じメッセージを
  配る形にするか、**どちらか一方だけを活性にする**（開いたら他方は停止）かを先に決める。
  後者のほうが、キャプチャ 2 本・入力 2 系統という状態を作らずに済むぶん安全。
- CLAUDE.md の「確保したものは必ず捨てる」に直結するので、
  `onDidDispose` の扱いを `resolveWebviewView` と揃える必要がある。

### B-2. 筐体の側面ボタンを押せるようにする **[提案]** *(手間 S / リスク 低。A-2 と一体)*

前述のとおり `side-mute` / `side-vol` / `side-power` は装飾のまま。
押せるようにすると、**UI 要素を増やさずに操作が増える**（狭いサイドバーで貴重）。

- 音量は上下 2 領域に割る（`side-vol` は高さ 46px あるので上下で分けられる）。
- 押下のフィードバック（`:active` で 1px 沈む）を付けないと、押せることが伝わらない。
- `title` 属性 + `aria-label` を付ける（現状 `<span>` なのでスクリーンリーダーから見えない。
  `<button>` にするのが正しい）。

### B-3. キーボード入力の穴 **[実装済]**

`media/webview/main.js` の `keydown` は次を**取りこぼしている**。

| キー | 現状 | 影響 |
|---|---|---|
| 矢印キー | `e.key.length === 1` に一致せず**捨てられる** | リスト・テキスト欄のカーソル移動ができない |
| Tab | 明示的に `return` | webview 内のフォーカス移動を優先している。妥当だが、デバイスへ送る手段が無い |
| Delete（前方削除）| 未対応 | |

矢印キーは `special: true` の経路（`delete` / `return` / `escape` と同じ）へ足すだけで通る。

**併せて直したい**: `keydown` が `document` に張られていて、
オーバーレイが消えていれば**デバイス選択の `<select>` にフォーカスがあっても送る**。
`<select>` を開いて機種名を打って絞り込む（ブラウザ標準の type-ahead）と、
その文字がデバイスにも入る。`e.target` がフォーム要素なら送らない、で解決する。

### B-4. エラー表示に復帰の導線が無い **[実装済]**

`case 'error'` はオーバーレイに**文言を出して終わり**。
`Failed to initialize mobilecli: ...` のような文字列が黒画面に出るだけで、
そこから何をすればいいかが分からない。

- オーバーレイに **［再試行］［ログを見る］** の 2 ボタンを出す。
  `simulator.showLogs` は既にあるので、webview から `showLogs` メッセージを足すだけ。
- README の「トラブルシューティング」が「出力チャンネルを見よ」と案内している以上、
  **エラーが出ているその場から辿れる**べき。

### B-5. デバイス一覧が素の `<select>` **[実装済]**

- iOS と Android が混ざって並ぶ。`<optgroup>` で分けられる。
- `Booted` / `Shutdown` が文字で付くだけ。**停止中を選んでも
  「Device is not running」で終わる**（コマンドパレット側は `bootAndConnect` で起動できるのに、
  webview 側は起動できない）。ここは**同じ振る舞いに揃えるべき**で、
  現状は導線によって結果が変わる。
- 台数が 1 台のときも「Select Device…」から選ばせている。

### B-6. 端末フレームの ON/OFF **[実装済]**

`.phone-frame` は左右 11px + 角丸 34px を消費する。
サイドバーが狭いときは**画面そのものを 1px でも広く出したい**。
`secondarySimulator.showDeviceFrame`（既定 true）で切れるようにする。

### B-7. フッターの情報密度 **[実装済]**

`Host / Heap / Children / Extension` の 4 つが常時出ている。
**開発者向けの数字が、通常利用では場所を取っている**。

- 既定は `Video`（fps / 帯域）と入力経路だけにして、
  残りは設定 `secondarySimulator.showResourceStats`（既定 false）で出す。
- CLAUDE.md の「計測できる状態を保つ」は**計測を止めろとは言っていない**ので、
  数値の収集は残したまま表示だけ畳む。

### B-8. 入力遅延が見えない **[提案]** *(手間 M / リスク 低)*

`docs/sync-research.md` の主題は入力の往復遅延（WDA 経路で約 600ms）だが、
**フッターに出るのは映像側の数字だけ**。HID なのか WDA なのかは出ているものの、
「実際に何 ms かかっているか」は見えない。

`touchDown` の送出から応答までを移動平均で持ち、`12ms` / `580ms` と出す。
HID→WDA の降格が体感でどう変わるかが数字で分かる。
**高頻度パスなので、`touchDown` のときだけ測る**（`touchMove` は測らない）。

---

## C. 既存機能の穴（設定が効いていない）

### C-1. `streamScale` / `streamQuality` が効かない組み合わせがある **[提案・未対応]** *(手間 S — 下の追記を参照)*

`WdaSettings.apply` の呼び出しは**1 か所しかなく**、
`startDisplayForDevice` の **`directStream` が ON の分岐の中**にある。
`captureFps` / `captureMaxWidth` / `captureMode` は `SidecarCapture` 専用。
`MjpegCapture` は `device.screencapture` に `format` と `deviceId` しか渡していない。

結果、設定の効き方は次のようになっている。

| 経路 | `streamScale` | `streamQuality` | `captureFps` / `MaxWidth` |
|---|---|---|---|
| iOS Simulator + サイドカー | 効かない（幅は `captureMaxWidth`） | 効く | 効く |
| iOS + WDA + `directStream` ON | 効く | 効く | 効かない |
| iOS + WDA + `directStream` OFF（**既定**）| **効かない** | **効かない** | 効かない |
| Android | **効かない** | **効かない** | 効かない |

**既定の設定で iOS 実機に繋いだ場合と、Android の場合は、どの帯域設定も効かない。**
`docs/sync-research.md` §1.1 の実測では 1 フレーム 107KB・2.9MB/s。
サイドバー表示には過剰で、しかも設定画面には項目が並んでいる。

打ち手は 2 つ。

1. **`MjpegCapture` でも `WdaSettings.apply` を呼ぶ**（iOS 限定・`directStream` に依存させない）。
   最小の変更で「既定の iOS」が直る。Android は直らない。
2. **Android の帯域を別経路で絞る**（`docs/project-review.md` §5.10 の宿題）。
   mobilecli の Android 側が `scale` を受けるかは未検証。受けないなら
   `adb exec-out screenrecord` 系へ寄せる話になり、**境界（adb は `AdbTouch` だけ）に触る**ので
   設計判断が要る。

**どちらもやらないなら、効かない設定を UI から消す**（`when` で隠す・説明に条件を書く）
のが誠実。現状は「設定したのに変わらない」が起きる。

### C-1 追記（2026-08-19）— 打ち手 3 が最も安い **[提案・未対応]**

上の「補足」のとおり、**`device.screencapture` は `scale` と `quality` を受ける**。
`MjpegCapture.startMjpegStream` が投げている JSON は現在これだけ:

```ts
params: {format: 'mjpeg', deviceId: this.deviceId}
```

ここに `scale` と `quality` を足せば、**iOS・Android を問わず同じ経路で帯域が絞れる**。
初版で書いた「Android は adb 経路へ寄せる話になり境界に触る」は成り立たない。

- 手間は **S**（パラメータ 2 つと、設定から読む数行）
- `WdaSettings`（`lsof` で WDA を探して POST する。§2.2 で誤爆の懸念も挙がっている）は、
  これが効くなら**要らなくなる可能性がある**。ただし `directStream` 経路は
  `device.screencapture` を通らないので、消す前に確認が要る
- 実測での効き目は未検証（mobilecli が iOS で `scale` を無視した前例が
  `docs/sync-research.md` §1.2 の J 行にある。**Android では未確認**）

**今回は「今は触らない」と判断して未着手。** 上の事実だけ記録しておく。

### C-2. webview からは停止中のデバイスを起動できない **[実装済]**（B-5 と一体）

`selectDevice` は `state !== 'Booted'` で `sendError` して終わる。
`bootAndConnect` は既にあるので、**同じ確認ダイアログを webview 経路からも出せる**。

### C-3. `MjpegCapture` が `updateConfig` で必ず張り直す **[提案]** *(手間 S / リスク 低。C-1 と一体)*

`SidecarCapture` は張り直さずに差し替えられる（CLAUDE.md に明記の設計）が、
`MjpegCapture` は `stop()` → `start()`。効かない設定（C-1）を変えただけでも
**画面が一度切れる**。C-1 を直すならここも併せて見る。

---

## D. 開発基盤

### D-1. Lint / フォーマッタが無い **[提案]** *(手間 S / リスク 低)*

`docs/project-review.md` §6 から未対応。ESLint も Prettier も設定が無い。
`npm test` は通るが、スタイルは人の目に頼っている。
CI に足すなら `quick-check` ジョブへ 1 行。

### D-2. README の二重管理 **[提案]** *(手間 M / リスク 低)*

`README.md` と `README_JP.md` が同内容を持ち、片方だけ古くなる。
`docs/project-review.md` §6 でも指摘済み。
**片方を正にして生成する**か、**差分をテストで落とす**（見出しの数が合うか等）。

### D-3. webview のテストが薄い **[一部対応]** *(手間 M / リスク 低)*

`test/webview-pointer.test.js` はポインタ変換だけ。
B-3（キー入力の穴）や B-4（エラー導線）を足すなら、
**同じ形で `main.js` の関数を切り出して素の script からテストできる**ようにしておきたい。

---

## E. 見送りを推奨する案

判断の記録として残す。

| 案 | 理由 |
|---|---|
| **複数デバイスの同時表示** | キャプチャ・入力・サイドカーが台数分になる。CLAUDE.md の資源管理を根本から見直す話で、得られるものに対して重い |
| **ドラッグ&ドロップでアプリをインストール** | mobilecli に相当 RPC が見当たらない。`xcrun simctl install` を直接叩くのは境界違反 |
| **録画の自動保存先（拡張が管理）** | 「永続ストレージは使わない」に反する。A-5 をやるならユーザーに尋ねる形を崩さない |
| **タッチ操作の記録・再生（マクロ）** | 軌跡を溜める入れ物が要る。テスト自動化は別ツールの領分 |

---

## F. 着手するなら、の順序（提案）

効果と手間の比で並べたもの。**この順にやるべきという主張ではなく、
判断のたたき台**。

1. **C-1**（効かない設定）— defect に近い。直すか、設定を消すかを先に決める
2. **A-2 + B-2**（側面ボタン）— 既にある要素に振る舞いを足すだけで操作が 3 つ増える
3. **B-3**（キー入力の穴）+ **B-4**（エラー導線）— どちらも小さく、日常的に刺さる
4. **B-1**（エディタタブ）— 効果は最大だが、provider の単数前提を崩すので設計判断が要る
5. **A-1**（回転）— 実機で 1 回確認できれば閉じられる
6. **A-3**（貼り付け）/ **A-6**（診断コピー）— 小粒だが効く
7. **A-4**（アプリ起動）/ **A-5**（録画）— 応答形式の実機確認が前提
8. **D-1〜D-3**（基盤）— いつでも

---

## G. 本ブランチで対応した範囲（2026-08-19）

`claude/extension-improvement-ideas-0er40n`。判断は依頼者が選択したもので、
**C-1（帯域設定）と B-1（エディタタブ）は「今は触らない」**として未着手。

| 分類 | 対象 |
|---|---|
| 追加 | 画面の回転（A-1）、画面録画（A-5）、クリップボード貼り付け（A-3） |
| UI/UX | キー入力の穴（B-3）、エラーからの復帰導線（B-4）、デバイス一覧（B-5 / C-2）、表示の整理（B-6 / B-7） |
| 設定 | `showDeviceFrame`（既定 true）、`showResourceStats`（既定 false） |
| コマンド | `simulator.rotate` / `simulator.record` |
| テスト | 新規 1 ファイル（`orientation.test.js` 26 項目）＋ webview 30 項目・入力経路 10 項目を追加 |

### 実機で確かめたいこと

コードとしては閉じているが、デバイスに繋いだ確認が要るのは次の 3 点。
**いずれも「応答の形」であって、RPC 名と引数はバイナリで確定している。**

- **`device.screenrecord` の応答と所要時間** — 開始が即座に返るか（`RecordingSession` を
  作って返す想定で書いた）。停止は端末からの引き上げがあるので待ちを 180 秒取っている
- **`device.io.orientation.get` の応答の形** — `decodeOrientation` は 6 通りを受けるが、
  実際にどれで返るかは未確認。読めなくても「そのまま横へ回す」で動く
- **iOS Simulator の HID 経路で矢印キーが効くか** — usage（0x4f–0x52）は
  `docs/ios-hid-injection.md` §6 のとおりだが、実際に送ったことは無い

### 併せて記録

- 初版で「Android の帯域は adb 経路へ寄せる話で境界に触る」と書いたのは**誤り**だった。
  `device.screencapture` が `scale` / `quality` を受けるので、`MjpegCapture` の
  パラメータを 2 つ足すだけで済む（→ C-1 追記）。C-1 に着手する場合はここから
- `ButtonType` に `DPAD_UP/DOWN/LEFT/RIGHT` を足した。A-2（音量・電源）に着手するときは
  同じ型がそのまま使える
