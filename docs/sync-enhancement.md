# 同期（ミラー）機能の強化 — 現状の問題点と実装方針の調査

調査日: 2026-08-17 / 対象: `main` (29de4bb) 時点の表示・入力の同期経路
前提: [sync-research.md](./sync-research.md)（2026-08-16 の実測調査）、
[sidecar-protocol.md](./sidecar-protocol.md)、[ios-hid-injection.md](./ios-hid-injection.md)

macOS / 実機を持たない環境での**静的な読み取り**と、経路のコストを再現した
**Node 上のマイクロベンチ**による調査。macOS 側の私有 API に関する提案は
**すべて未検証**であることを都度明記する。

---

## 0. 結論（先に要点）

1. **入力側の同期はもう終わっている。** `sync-research.md` が「最大の問題」とした
   入力 600ms は HID 直接注入で 0.045ms になった（同 §5 Phase 3 追記）。
   **いま残っている非同期感は、ほぼ全部が表示側にある。**
   したがって sync-research.md の §0「表示は既にほぼ問題ない／ボトルネックは入力」は
   **現在の実装には当てはまらない**。前提が入れ替わっている。

2. **最大の構造的な問題は「一番良い取り込み元が、一番遅い転送路に固定されている」こと。**
   サイドカー取り込み（フレームバッファ直取り、ソフトキーボードも写る）を選ぶと、
   `directStream`（webview 直結 `<img>`）は**必ず無効になる**
   （`SimulatorWebviewProvider.ts:537`）。結果、良い絵が
   `base64 → JSON → stdout → 拡張ホスト → base64 再エンコード → postMessage → atob`
   という 4 回コピーの経路を通る。
   ただし**この経路の CPU コスト自体は小さい**（0.24〜0.72ms/frame、§1.3）。
   問題は速度ではなく、**stdout を入力と共有していること**（§2.4）と
   **毎フレームの割り当て**の方である。速さを理由に書き換えを正当化しないこと。

3. **取り込みが 30fps 固定のポーリング**（`IOSurfaceGetSeed` 比較）である。
   画面が変わってから撮られるまで平均 +16.7ms / 最悪 +33ms が構造的に乗る。
   さらに**静止画面でも seed は動くため、捨てるだけの JPEG エンコードを毎 tick 回している**
   （エンコード実測 2ms/frame、sidecar-protocol.md §3.5）。
   idb（`FBFramebuffer`）が使っている **IOSurface 変更コールバック**でプッシュ型にできる。

4. **stdout を入力の応答と映像で共有しているため、映像の背圧が入力遅延に化けうる。**
   フレーム側は `trylock` で「待たずに捨てる」設計だが、**ロックを取った後の `write` が
   ブロックする**ので、意図した保護になっていない（§2.4）。

5. 打ち手は 3 段階に分けられる。**A だけで実装コストに対する効果が一番大きい。**

   | 段階 | 内容 | 想定効果 | リスク |
   |---|---|---|---|
   | **A** | 経路の無駄取り・適応化（TypeScript と webview だけ、私有 API を触らない） | CPU -60%、体感の追従改善、固まり方の解消 | 低 |
   | **B** | フレームを拡張ホストに通さない（サイドカー → webview 直結） | コピー 4 回 → 1 回、入力と映像の分離 | 中 |
   | **C** | プッシュ型取り込み + ハードウェアエンコード（H.264 / WebCodecs） | 遅延 -20ms、帯域 1/10、60fps | 高（私有 API 追加） |

---

## 1. 現行の同期経路（実装の確認）

同期に関わる経路は **2 本**あり、`captureSource` / `directStream` / HID の生死で選ばれる。

### 1.1 経路 1: サイドカー取り込み（iOS Simulator + HID 生存時の既定）

```
[Simulator フレームバッファ]
   │ SimDisplayIOSurfaceRenderable.maskedFramebufferSurface
   │ ★ 30fps のタイマで seed をポーリング          native/simhid-server.m:300 captureTick
   │ CIImage → 縮小 → JPEG（実測 2ms）
   │ base64 + JSON Lines
   ▼ stdout（入力の応答と共用・ブロッキング write）
[Extension Host]
   │ stdoutBuf に文字列連結 → indexOf('\n') → slice   SimhidSidecar.ts:125
   │ JSON.parse（1 行 ≒ 91KB）
   │ Buffer.from(base64) ← デコード                 SidecarCapture.ts:49
   │ .toString('base64')  ← 再エンコード ★          SimulatorWebviewProvider.ts:577
   ▼ postMessage
[Webview]
   │ atob + charCodeAt ループでバイト詰め替え         main.js:332
   │ Blob → createImageBitmap → ctx.drawImage
   ▼ <canvas>
```

### 1.2 経路 2: WDA / mobilecli（Android・実機・HID 降格時）

```
[WDA MJPEG :13201] → mobilecli → MjpegProxy(GET+token) → <img>   ← directStream: ON
                                → MjpegCapture(手動パース) → postMessage → canvas ← OFF
```

`directStream` が ON のときだけ webview 直結になる。**この直結は経路 2 でしか使えない。**

### 1.3 ホップごとのコスト（本調査環境で再現・参考値）

Linux コンテナ上の Node 24 で、拡張ホスト側の各処理を同じデータ量で再現した値
（`scripts/bench-frame-pipeline.js`。捨て実行 1 回 + 3 回測定の中央値）。
**macOS 実機の値ではない**（相対コストの目安として読むこと）。

| 処理 | JPEG 68KB (base64 91KB) | JPEG 120KB (160KB) |
|---|---|---|
| stdout の文字列連結 + 行分割 | 0.020 ms | 0.19 ms |
| `JSON.parse` | 0.036 ms | 0.14 ms |
| `Buffer.from(base64)`（デコード） | 0.017 ms | 0.03 ms |
| `toString('base64')`（**再**エンコード） | 0.011 ms | 0.10 ms |
| webview の `atob` + 詰め替え | 0.16 ms | 0.27 ms |
| **合計（画像デコードを除く）** | **0.24 ms/frame** | **0.72 ms/frame** |

30fps なら 1 コアの **0.7〜2.2%**。`createImageBitmap` の JPEG デコードと
canvas 描画はこれに加算される。

> **この経路の CPU コストは小さい。** 最初の計測では 1.0〜1.8ms/frame と出たが、
> それは JIT が暖まる前の値だった。**転送経路の書き換えを「速いから」で正当化しては
> いけない**。正当化できるのは、割り当ての削減（1 フレームごとに 68KB の Buffer と
> 91KB の文字列を作って捨てている）と、§2.1 / §2.4 の**構造**の方である。
>
> 実際の遅延の主因は §2.2 のポーリング間隔（平均 16.7ms）で、
> 上表の合計より**桁で大きい**。

---

## 2. 問題点

重大度順。`[確認]` = コードで確認、`[実測]` = 本調査で計測、`[未検証]` = 実機が要る。

| # | 箇所 | 内容 | 重大度 |
|---|---|---|---|
| 2.1 | `SimulatorWebviewProvider.ts:537` | サイドカー取り込みと直結ストリームが排他 | 高 |
| 2.2 | `simhid-server.m:340` `startCapture` | 30fps 固定ポーリング。平均 +16.7ms、静止時も encode | 高 |
| 2.4 | `simhid-server.m:149` `emitFrameLine` | 映像の背圧が入力応答をブロックしうる | 高 |
| 2.5 | `SidecarCapture.ts` 全体 | 停止検出・再取得が無い（`MjpegCapture` にはある） | 高 |
| 2.6 | `captureMaxWidth`（既定 640） | 実表示幅・DPR に追従しない | 中 |
| 2.7 | `captureFps`（既定 30） | 操作中／静止中で変わらない | 中 |
| 2.8 | `extension.ts:80` → `onConfigurationChanged` | 無関係な設定変更でも取り込みを再起動する | 中 |
| 2.9 | `Provider.startCaptureForDevice` | 再表示・切替のたびにサイドカーを kill/spawn | 中 |
| 2.10 | `main.js:332` `base64ToBytes` | 1 バイトずつの JS ループでデコード | 中 |
| 2.11 | `SimhidSidecar.ts:246` `sendNoWait` | `write` の戻り値を見ない = 上限の無いキュー | 中 |
| 2.12 | 全経路 | 画面回転に未対応（設計上も「将来対応」） | 中 |
| 2.13 | フッター統計 | fps・帯域・遅延が出ない（他の判断の前提になる） | 中 |
| 2.3 | `SidecarCapture.ts:49` / `Provider:577` | base64 を decode → 再 encode している | 低 |

### 2.1 一番良い取り込み元が、一番遅い転送路に固定される **[確認]**

```ts
// SimulatorWebviewProvider.ts:537
if (this.isDirectStreamEnabled() && !this.sidecarCaptureAvailable()) {
```

`sidecarCaptureAvailable()` が true、つまり **iOS Simulator で HID が生きている
「最良の状態」のときだけ直結が切られる**。理由は「サイドカーのフレームは
HTTP で取れないから」であって、優劣の判断ではない。

現状の組み合わせはこうなっている。

| 取り込み元 | 写る範囲 | 転送 | コピー回数 |
|---|---|---|---|
| サイドカー（フレームバッファ） | **全部**（ソフトキーボード・ステータスバー込み） | stdout → postMessage | 4 |
| WDA MJPEG | アプリのウィンドウのみ | `<img>` 直結 | 1 |

**良い絵と良い転送が組み合わせられない。** これが構造上の最大の問題で、
§3 の提案 B はここを直すためのもの。

### 2.2 30fps 固定ポーリング + 捨てるための JPEG エンコード **[確認]**

```objc
// simhid-server.m:300
uint32_t seed = IOSurfaceGetSeed(surface);
if (st.hasLastSeed && seed == st.lastSeed) return;   // ← 変化検出はここ
...
NSData *jpeg = [st.ciContext JPEGRepresentationOfImage:...];
if (st.lastJpeg && [st.lastJpeg isEqualToData:jpeg]) return;  // ← 静止画面はここで捨てる
```

2 つの問題がある。

1. **サンプリング遅延。** 画面が変わった瞬間と次の tick の間に、
   平均 16.7ms・最悪 33.3ms が乗る。これは JPEG 化や転送の速さでは取り返せない。
   glass-to-glass のうち、**削れる余地が一番大きいのがここ**。
2. **静止画面でも毎 tick エンコードする。** `IOSurfaceGetSeed` は中身が同じでも動くと
   コード中のコメント自身が言っている。そのため「エンコードしてから同一バイト列か
   比較して捨てる」形になっており、**捨てるためだけに 2ms/frame（≒ 1 コアの 6%）を
   常時使っている**。帯域は 0 になるが CPU は 0 にならない。

### 2.3 base64 の二重変換 **[確認] [実測]** — 重大度は低い

> 当初これを「高」と書いたが、暖機後の実測では 68KB で 0.03ms/frame しかかからない。
> **時間の問題ではない**ので、優先度を下げて記録する。

```ts
// SidecarCapture.ts:48-49 — 文字列を Buffer へ decode
this.sidecar.onFrame = (base64) => this.callback?.(Buffer.from(base64, 'base64'));

// SimulatorWebviewProvider.ts:574-578 — その Buffer をまた base64 へ encode
data: Buffer.from(frame.buffer, ...).toString('base64'),
```

サイドカーは base64 文字列を送り、webview も base64 文字列を欲しがっているのに、
**途中で 1 往復デコードして戻している**。`CaptureStrategy.onFrame` が
`Uint8Array` を渡す契約なので、経路 2（MJPEG）と型を揃えるために起きている。

時間は 0.03ms/frame（68KB）と小さい。実害は**割り当ての方**で、
1 フレームごとに 68KB の `Buffer` と 91KB の文字列を作って即捨てている
（30fps なら毎秒 4.8MB の短命オブジェクト）。直すなら
`CaptureStrategy` に base64 を素通しする経路を足すだけで、コストはほぼゼロ。

### 2.4 映像の背圧が入力応答をブロックしうる **[確認]**

```objc
// simhid-server.m:142-156
// 「親の読み出しが遅いと write がブロックする。…フレームは捨ててよいので trylock にし」
static BOOL emitFrameLine(NSDictionary *obj) {
  if (pthread_mutex_trylock(&gOutMutex) != 0) return NO;
  writeAllLocked(line);        // ★ ここでブロックする
  pthread_mutex_unlock(&gOutMutex);
```

**`trylock` が守るのは「ロック待ち」だけで、「ロックを取った後の write 待ち」ではない。**
stdout はブロッキング fd なので、パイプバッファ（既定 64KB）が埋まると
`writeAllLocked` の中で止まり、その間 `gOutMutex` を握り続ける。すると入力側の
`emitLine`（`respond` の経路、`gQueue` 上）は `pthread_mutex_lock` で待たされる。

つまり **「映像が詰まると入力の応答が遅れる」** — サイドカープロトコル文書が
「そのぶん取り込みも止まる（＝キューを作らない背圧）」と書いた意図は正しいが、
**取り込みだけでなく入力まで巻き込む**点が設計と実装でずれている。

拡張ホスト側は `touchDown` / `touchUp` を `send()`（3 秒 timeout）で待つため、
最悪ケースではタッチが timeout で失敗する。

### 2.5 サイドカー取り込みには停止検出も再取得も無い **[確認]**

`MjpegCapture` には 15 秒の `stallTimer` と指数バックオフ再接続がある（`MjpegCapture.ts:21`）。
`SidecarCapture` には**どちらも無い**。

- `st.displayDescriptor` は `startCapture` で一度取ったら**プロセスが生きている限り再取得しない**。
- `surfaceForDescriptor` が nil を返すと `captureTick` は「黙って飛ばす」（`simhid-server.m:303`）。

シミュレータの再起動・ディスプレイ構成の変化で descriptor が古くなると、
**エラーも出さずに最後のフレームで固まり、自力では復帰しない**。
利用者から見ると「たまに画面が止まる。繋ぎ直すと直る」という形で出る。

### 2.6 / 2.7 解像度と fps が固定 **[確認]**

`captureMaxWidth`（既定 640px）は設定値をそのまま使う。サイドバーの実表示幅は
利用者が自由に変えられ、`devicePixelRatio` も 1 か 2 で違う。

- パネルが 320px 幅（Retina で実 640px）なら 640 はちょうどよい
- パネルを 900px に広げると**ぼやけた 640px を拡大表示する**
- パネルを畳んで 250px にすると**要らない画素を送り続ける**

fps も同様に固定で、**ドラッグ中も静止中も同じ 30fps**。追従が要るのは操作中だけで、
静止中は 5fps でも誰も困らない。逆に操作中は 60fps 出したい。

### 2.8 無関係な設定変更で取り込みが再起動する **[確認]**

```ts
// extension.ts:81
if (e.affectsConfiguration('secondarySimulator')) { ... provider.onConfigurationChanged(); }
// Provider:968
if (this.currentCapture) this.currentCapture.updateConfig();   // ← 何が変わったか見ていない
```

`secondarySimulator.*` の**どれが変わっても**取り込みが停止 → 再開する。
実害があるのは、**拡張自身が設定を書き戻す経路**が 2 つあること。

- サイドバーの `Auto` ボタン → `setAutoConnect` → `autoConnect` を更新
- `Disconnect` → `autoConnect` を false に更新

つまり **接続中に Auto ボタンを押すと画面がいったん切れる**。
経路 2（`MjpegCapture.updateConfig`）では HTTP ストリームの張り直しになるので、
数百 ms の黒画面になる。

### 2.9 再表示・デバイス切替のたびにサイドカーを作り直す **[確認]**

`startCaptureForDevice` は先頭で `stopCapture()` を呼び、そこで
`inputController.dispose()` → `sidecar.dispose()`（SIGTERM）まで行く。
`onDidChangeVisibility` で非表示 → 再表示するだけでも同じ経路を通るため、
**タブを切り替えるたびに simhid-server プロセスと HID クライアントが作り直される**。
`ready` の待ち（最大 5 秒）と HID クライアント生成のぶん、復帰が遅い。

### 2.10 webview のデコードが 1 バイトずつ **[確認] [実測]**

```js
// main.js:332
const bin = atob(b64);
for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);  // 91,000 回/frame
```

0.16〜0.27ms/frame で、**§1.3 の中では単独で最も重い**（しかもレンダラのメインスレッド上）。
`MAX_FRAME_QUEUE = 1` なので、ここと `createImageBitmap` が律速するとフレームは
黙って捨てられる（＝実効 fps が落ちるが、どこにも出ない）。

### 2.11 `sendNoWait` に背圧が無い **[確認]**

```ts
// SimhidSidecar.ts:246-249
sendNoWait(command: SidecarCommand): void {
  if (this.fatalReason || !this.proc?.stdin) return;
  this.proc.stdin.write(JSON.stringify(command) + '\n');   // 戻り値を見ない
}
```

`write` が `false` を返してもそのまま書き続けるので、サイドカーが読まなくなると
**Node の内部書き込みキューが無制限に伸びる**。CLAUDE.md の
「無制限に伸びるバッファ・キュー・Map を作らない」に反している。
`touchMove` は 60Hz なので、詰まった状態が数分続けば無視できない量になる。

（`stdoutBuf` には 1MB の上限があり、そちらは対策済み。）

### 2.12 画面回転に未対応 **[確認]**

`sidecar-protocol.md` §4 が「画面回転は将来対応。当面は縦向き前提で正規化する」と
明記している。横向きにしたときの取り込み（フレームバッファ側の向き）と
入力の正規化座標がどうなるかは **[未検証]**。「完全同期」を名乗る上では穴。

### 2.13 同期の質が計測できない **[確認]**

フッターに出るのは RSS・heap・子プロセス・拡張ディレクトリのサイズだけ。
**実効 fps・帯域・glass-to-glass 遅延・落としたフレーム数が見えない。**
CLAUDE.md の「計測できる状態を保つ」はメモリには効いているが、
**同期そのものには効いていない**。§3 のどれを実装しても、
効果を確かめる手段が無ければ判断できない。

---

## 3. より効果的な実装方法（調査）

### 3.1 取り込み: ポーリング → プッシュ型

`IOSurfaceGetSeed` の定期比較をやめ、**サーフェスの変更通知**で撮る。

Meta の idb（`FBSimulatorControl/Framebuffer/FBFramebuffer.m`）は、
`SimDisplayIOSurfaceRenderable` に対して
**`registerCallbackWithUUID:ioSurfaceChangeCallback:`**（および複数面版の
`ioSurfacesChangeCallback`）を、ダメージ矩形には
**`registerCallbackWithUUID:damageRectanglesCallback:`** を登録している。
同じ CoreSimulator / SimulatorKit の私有 API 群で、本リポジトリが既に叩いている
`SimDeviceIOClient.ioPorts` → `descriptor` の延長線上にある。

| | 現行（ポーリング） | プッシュ型 |
|---|---|---|
| 取り込み遅延 | 平均 +16.7ms / 最悪 +33ms | ほぼ 0 |
| 静止時の CPU | encode 2ms × 30回/秒 | 0（通知が来ない） |
| 上限 fps | 設定値（最大 60） | 画面の更新レートに追従 |
| 実装 | 済み | 私有 API を 2 本追加 |

**注意点（すべて [未検証]）**

- 通知はデバイスの更新レートで来るので、**上限のレートリミッタが別途要る**
  （60fps を超えて送らない。入力側の `kDragMinIntervalNs` と同じ考え方）。
- 登録した UUID は**必ず解除する**（`unregister…WithUUID:`）。
  解除漏れはサイドカープロセスに閉じるが、CLAUDE.md の「確保したものは必ず捨てる」に従う。
- **登録が失敗したらポーリングへ自動で戻す**。私有 API が増えるので、
  `scripts/check-xcode-hid.sh` / `--check` の検査対象にも足す。
- ダメージ矩形が取れるなら「変化した領域だけ再エンコード」も理屈上は可能だが、
  JPEG は部分更新に向かない。**H.264（§3.3）に進むときの材料**として見るべきで、
  JPEG のままなら深追いしない。

### 3.2 転送: フレームを拡張ホストに通さない

§2.1 / §2.3 / §2.4 は**すべて「フレームが stdout と拡張ホストを通る」ことに由来する**。
選択肢は 3 つ。

| 案 | 仕組み | コピー回数 | 効果 | リスク |
|---|---|---|---|---|
| **B-1** | サイドカーが loopback HTTP で `multipart/x-mixed-replace` を直接配信、webview の `<img>` が受ける | 1 | §2.1/2.3/2.4/2.10 が同時に消える | 中 |
| B-2 | サイドカーは stdout のまま、拡張ホストの `MjpegProxy` を中継に拡張し `<img>` へ | 2 | §2.1/2.10 は消えるが §2.4 は残る | 小 |
| B-3 | stdout に別 fd（fd 3）でバイナリのフレームを流し、postMessage は `Uint8Array` のまま | 3 | base64/JSON は消えるが直結にはならない | 小 |

**B-1 を本命とする理由**

- 受け皿がもう揃っている。`MjpegProxy` がトークン方式・ポート探索・`closeAllConnections`
  を実装済みで、`WebviewPortMapping` と CSP の `img-src` 範囲指定も
  `SimulatorWebviewProvider.getHtmlContent` に入っている。**同じ形をサイドカーに移すだけ。**
- stdout が制御専用に戻るので、§2.4（背圧が入力を巻き込む）が**設計から消える**。
- webview 側は `<img src>` 1 本になり、`atob` / `Blob` / `createImageBitmap` /
  `frameQueue` / `MAX_FRAME_QUEUE` の一式が不要になる（Chromium が multipart を
  ネイティブ復号し、フレーム落としも Chromium 側でやる）。

**B-1 で守るべき制約**

- **127.0.0.1 で listen し、起動毎トークンを必須にする**（`MjpegProxy` と同じ理由。
  同一マシンの任意プロセス・任意のブラウザタブから画面が覗ける）。
- **ポートは拡張ホストが決めてサイドカーへ渡す**か、サイドカーが選んで `ready` で返す。
  CSP は生成時に決まるので、`MjpegProxy` と同様に**範囲で許可**する必要がある。
- **リモート開発（Remote SSH / Codespaces）** では `portMapping` が要る。
  http のみ対応で `ws://` はマップされない（sync-research.md §4）ので、
  **WebSocket ではなく HTTP multipart を選ぶ理由がここにもある**。
- B-1 にしても `<img>` は「今の絵」しか出せない。スクリーンショット（`Shot`）は
  引き続き mobilecli 経由でよい。

### 3.3 コーデック: JPEG → H.264 / HEVC（WebCodecs）

`VTCompressionSession` は入力に `CVPixelBuffer` を取り、IOSurface からは
ラップするだけで済む（ゼロコピー）。webview 側は WebCodecs の `VideoDecoder` で復号する。
idb は同じ構成を `idb video-stream --format h264` として提供しており、
`EliotAndres/SimStream` は Swift 1 バイナリで「キャプチャ + H.264 + HTTP/WS」を
まとめる構成の先例になる。

| | JPEG（現行） | H.264 |
|---|---|---|
| 帯域 | 0.5〜2.9 MB/s | 1/10 程度 |
| エンコード | CoreImage 2ms/frame（CPU/GPU 混在） | ハードウェア |
| 復号 | `createImageBitmap`（毎フレーム全体） | `VideoDecoder`（差分） |
| 実装 | 済み | 大（keyframe・再同期・SPS/PPS の扱い） |

**判断: 今は要らない。** 帯域は既に 0.5MB/s まで落ちており（sidecar-protocol.md §3.5）、
サイドバー用途で 60fps を要求する場面も少ない。§3.1 と §3.2 を先にやると
JPEG のままでも十分な可能性が高い。**A → B を実装し、計測（§2.13）で足りないと
分かってから C へ進む**のが順序として正しい。

先に決めておくべきことだけ挙げる。

- WebCodecs は VS Code / Cursor の Chromium で使えるが、**Cursor は API 世代が遅れる**
  ため要確認 **[未検証]**。使えない環境向けに JPEG 経路を残す必要がある。
- `CaptureStrategy` を差し替え点として残しておく判断（project-review.md §4.4）は正しい。
  H.264 を足すときもここに実装を 1 つ増やす形にする。

### 3.4 適応制御（取り込み側の賢さ）

私有 API を一切触らずに体感を変えられる部分。**費用対効果はここが一番高い。**

| 施策 | 仕組み | 効果 |
|---|---|---|
| **表示幅への追従** | webview が `ResizeObserver` で `clientWidth × devicePixelRatio` を送り、`captureStart` を張り直す | 狭いときは帯域と CPU が下がり、広げたときはぼやけない |
| **操作中だけ高 fps** | `touchDown` で 60fps、`touchUp` の 500ms 後に既定へ、無操作 5 秒で 10fps | 追従が要る瞬間だけ払う |
| **設定は上限として扱う** | `captureFps` / `captureMaxWidth` を「上限」に読み替える | 既存設定の意味を壊さない |

いずれも `captureStart` にパラメータを載せ直すだけで、プロトコル変更は不要
（`fps` / `maxWidth` / `quality` は既にある）。ただし
**「張り直し」は現在 `stop()` → `start()` で 1 フレーム落ちる**ので、
`captureConfig`（実行中に上書きする）コマンドを 1 つ足す方が素直。

### 3.5 入力側（参考）

**現状で足りている。** HID 直接注入は 0.045ms、レートリミッタの吸収も
サイドカー側にある。webview → 拡張ホスト → stdin のホップは合計で数 ms 程度で、
表示側の 16.7ms（§2.2）より小さい。

したがって「入力も webview 直結（WebSocket）にする」案
（sync-research.md §4-2）は、**今やる価値が無い**。
§2.4 を B-1 で解消すれば、入力経路の不確実さも一緒に消える。

残すべき課題は遅延ではなく**種類**の方 — 画面回転（§2.12）、
クリップボード双方向、ハードキー。これらは sync-research.md §2 の
「完全同期」の定義に対する未達項目として残っている。

---

## 4. 推奨プラン

### Phase A — 無駄取りと適応化（私有 API を触らない）

> **2026-08-17 追記: 1〜8 をすべて実装した。** 5 の `captureConfig` と、その前提になる
> 生存通知・descriptor の取り直しはネイティブ側にも手が要ったため、
> 「私有 API を触らない」の範囲を少しだけ超えている（**新しい私有 API は増やしていない**）。
> **macOS が無いためネイティブはコンパイル未検証**。TypeScript / webview は型チェックと
> 15 ファイルのテストが通っている。実機での確認項目は §6 を参照。

**壊れている・止まる**を先に直し、次に**適応化**、最後に**無駄取り**の順で並べる。

1. **[実装済] fps・帯域・落としたフレーム数をフッターに出す**（§2.13）。
   **これを最初に置く。** 以降のどれをやっても、効果を確かめる手段が無ければ
   良くなったか分からない。カウンタの加算だけにして、集計は既存の 30 秒間隔に相乗りする。
2. **[実装済] `SidecarCapture` に停止検出を入れる**（§2.5）。`MjpegCapture` と同じ
   15 秒の stall タイマ → `captureStop` + `captureStart` で descriptor を取り直す。
   サイドカー側も `startCapture` で descriptor を毎回取り直すようにする。
3. **[実装済] 設定変更の粒度を見る**（§2.8）。`e.affectsConfiguration` を個別に判定し、
   `autoConnect` / `logLevel` では取り込みを再起動しない。
4. **[実装済] サイドカープロセスを使い回す**（§2.9）。非表示・同じデバイスへの繋ぎ直しでは
   表示だけ止め、プロセスと HID クライアントは残す。畳んだまま 2 分経ったら解放する
   （すぐ戻る場合のための使い回しで、放置された子プロセスを抱え続ける理由は無い）。
5. **[実装済] 表示幅と操作状態に追従する**（§3.4）。`captureConfig` コマンドを足し、
   `ResizeObserver` と `touchDown/Up` から fps・maxWidth を更新する。
   **体感に効くのはこれ**（操作中 60fps で §2.2 の平均 16.7ms が 8.3ms になる）。
6. **[実装済] `sendNoWait` に上限を設ける**（§2.11）。`write` が false のあいだは
   `touchMove` を捨てる（最新座標だけ残す。サイドカー側の coalescing と同じ考え方）。
7. **[実装済] webview の `atob` ループをやめる**（§2.10）。
   `img.src = 'data:image/jpeg;base64,…'` にすれば JS のデコードごと消える
   （B-1 に進むと `<img>` に統一されるので、その前段としても筋が通る）。
8. **[実装済] base64 の二重変換をやめる**（§2.3）。`CaptureStrategy` に base64 を
   素通しする経路を足す。時間ではなく毎フレームの割り当てのため。

**見込み**: 固まったまま戻らない現象と、Auto ボタンで画面が切れる現象が解消。
操作中の追従が 5 で改善する。
**根本の取り込み遅延（§2.2）は Phase C まで残る**ので、
「速くなった」と言えるのは 5 のぶんだけ（操作中 60fps で平均 16.7ms → 8.3ms）。

4 は独立したコミットに分けた。プロセスの寿命をデバイスから切り離す変更で、
HID 降格の流れ（`onBackendChange` → 映像だけ WDA へ付け替え）と絡むため、
壊れたときに切り分けられるようにしておく。使い回しの副作用として
`device.info` の往復（実測 280ms）も繋ぎ直しでは省ける。

### Phase B — フレームを拡張ホストに通さない（§3.2 B-1）

9. サイドカーに loopback HTTP（トークン必須）を持たせ、`multipart/x-mixed-replace` を配信。
10. `directStream` の判定から「サイドカーのときは無効」を外す（§2.1）。
    取り込み元（サイドカー / WDA）と転送（直結 / canvas）を**独立に選べる**ようにする。
11. stdout を制御専用に戻し、`emitFrameLine` と trylock を削除する（§2.4）。

**見込み**: コピー 4 回 → 1 回。入力応答が映像の背圧から独立する。
webview の描画コードが大幅に減る。

### Phase C — プッシュ型取り込み（§3.1）／必要なら H.264（§3.3）

12. `registerCallbackWithUUID:ioSurfaceChangeCallback:` によるプッシュ化。
    失敗時はポーリングへ自動で戻す。`--check` の検査対象に追加。
13. Phase A-1 の計測で足りないと分かった場合にのみ H.264 + WebCodecs。

**見込み**: 取り込み遅延 -16.7ms（平均）、静止時 CPU ≒ 0。

---

## 5. リスクと判断が要る点

| リスク | 内容 | 緩和策 |
|---|---|---|
| 私有 API の追加 | `ioSurfaceChangeCallback` 系は非公開。Xcode 更新で壊れる | ポーリングへの自動フォールバック。`--check` に追加し CI の `xcode-canary` で検知 |
| ポートが増える | サイドカーが listen すると、拡張が握るポートが 1 つ増える | 127.0.0.1 限定 + 起動毎トークン（`MjpegProxy` と同じ方式）。pid と同様にポートも `ResourceStats` に出す |
| CSP / portMapping | HTML 生成時にポートが未定 | `MjpegProxy` と同じく**範囲で許可**する既存パターンを踏襲 |
| リモート開発 | `portMapping` は http のみ。`ws://` は不可 | B-1 を HTTP multipart にする理由。WebSocket を選ばない |
| 適応 fps の副作用 | 静止判定を誤ると「動かした瞬間だけカクつく」 | 上げるのは即時、下げるのは遅延させる（ヒステリシス） |
| 計測の追加コスト | 高頻度パスに計測を入れると本末転倒 | カウンタを加算するだけにし、集計は既存の 30 秒間隔に相乗り |

---

## 6. 再現・検証手順

```bash
# 拡張ホスト側の経路コストの再現（本レポート §1.3。macOS 実機の値ではない）
# test/*.test.js に一致しないので npm test では走らない。手動実行。
node scripts/bench-frame-pipeline.js

# サイドカー単体で取り込みを回す（macOS 実機が要る）
./native/simhid-server
{"id":1,"cmd":"captureStart","device":"<UDID>","fps":30,"maxWidth":640,"quality":0.6}

# 私有シンボルの解決確認（Xcode 更新時の一次検知）
sh scripts/check-xcode-hid.sh
```

**実機で確かめるべきこと（優先順）**

0. **Phase A のネイティブ変更（`captureConfig` / `captureAlive` / descriptor 取り直し）が
   コンパイルできて動くか。** 本環境では `npm run build` の native がスキップされるため
   **未コンパイル**。合わせて、生存通知が届いているか（フッターの映像 fps が出るか）と、
   サイドバーの幅を変えたときに送出幅が追従するかを見る。
1. §2.2 のサンプリング遅延が体感にどれだけ効くか（30fps ↔ 60fps の比較）
2. §2.4 の背圧が実際に起きるか（重い画面 + 拡張ホストを詰まらせて `touchDown` の
   `latencyMs` を見る）
3. §2.5 の固まりが再現するか（シミュレータ再起動 → 画面が戻るか）
4. §3.1 のコールバック登録が iOS 26 / Xcode 26 で通るか

---

## 7. 参考

- [idb `FBSimulatorControl/Framebuffer/FBFramebuffer.m`](https://github.com/facebook/idb/blob/main/FBSimulatorControl/Framebuffer/FBFramebuffer.m)
  — `registerCallbackWithUUID:ioSurfaceChangeCallback:` / `…damageRectanglesCallback:` の実装例
- [idb: Video](https://fbidb.io/docs/video/) — `video-stream --format h264` のハードウェアエンコード
- [EliotAndres/SimStream](https://github.com/EliotAndres/SimStream)
  — Swift 1 バイナリでキャプチャ + H.264 + HTTP/WS + タッチ橋渡しをまとめた先例
- [tddworks/baguette](https://github.com/tddworks/baguette) — SimulatorKit キャプチャ + IndigoHID
- [VS Code: Remote Development と webview の portMapping](https://code.visualstudio.com/api/advanced-topics/remote-extensions)
- 本リポジトリ: [sync-research.md](./sync-research.md) §1 実測値 /
  [sidecar-protocol.md](./sidecar-protocol.md) §3.5 取り込み /
  [project-review.md](./project-review.md) §3.5 メモリ監査
