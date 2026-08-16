# シミュレーター表示/操作の「完全同期」化 — 調査レポート

調査日: 2026-08-16 / 実測環境: macOS 26 (Darwin 25.6.0), Xcode 26.6, iPhone 17 Simulator (iOS 26.5),
mobilecli 0.0.42, VS Code 1.131.0 / Cursor 3.16.17

現行の `@mobilenext/mobilecli` は 0.1.x。JSON-RPC 名は `devices` → `devices.list`、
`io_tap` → `device.io.tap`、`screencapture` → `device.screencapture`（セッション URL を返す）など。
以下の実測値と curl は調査時点（0.0.42）の名前のまま残す。

---

## 0. 結論（先に要点）

1. **表示は既にほぼ問題ない。ボトルネックは入力の往復遅延（実測 約600ms）**。
   MJPEG は 26.3fps・フレーム間隔 p50 38ms / p99 41ms と安定して届いている。
   一方 `io_tap` 1回に **578–632ms** かかっている。体感の「同期していない感」はここが主因。
2. **その 600ms のうち約 400ms は WebDriverAgent (XCTest) 由来で、mobilecli を最適化しても消えない**。
   WDA に直接 W3C actions を投げても 355–415ms かかる（quiescence 待ちを切っても 370ms）。
   → iOS Simulator で「完全同期」を目指すなら **WDA を入力経路から外す**しかない。
3. 疑っていた「拡張ホスト側の MJPEG パースが重い」は **誤り**。実測 0.05–0.2ms/frame で無視できる。
   （ただしコードとしては O(n²) で危ういので整理はすべき。優先度は低い）
4. 現実的な打ち手は 3 段階:
   - **Phase 1（1〜2日 / 低リスク）**: 表示を webview 直結にし、入力を押下時点で即送信する。遅延の「見え方」を改善。
   - **Phase 2（3〜5日 / 中リスク）**: WDA の MJPEG 設定を叩いて帯域を 1/6 に。Android は scrcpy 方式へ。
   - **Phase 3（1〜2週 / 高リスク・本命）**: iOS Simulator 専用の Swift サイドカーを作り、
     **Indigo HID 直接注入（~10ms）** + **SimulatorKit/ScreenCaptureKit キャプチャ** に置き換える。
     ここまでやって初めて「ドラッグに画面が追従する」= 完全同期になる。

---

## 1. 現状アーキテクチャの実測プロファイル

```
[iOS Simulator]
   ↑ HID/XCTest                    ↓ 画面
[WebDriverAgent :13001 (HTTP) / :13201 (MJPEG)]
   ↑ W3C actions                   ↓ multipart/x-mixed-replace
[mobilecli server :12000+ (JSON-RPC /rpc)]     ← src/utils/MobileCliServer.ts
   ↑ io_tap / io_gesture           ↓ POST /rpc screencapture を multipart で中継
[Extension Host (Node)]                         ← src/capture/MjpegCapture.ts で手動パース
   ↑ onDidReceiveMessage           ↓ webview.postMessage(Uint8Array)
[Webview]                                       ← media/webview/main.js
     createImageBitmap → canvas.drawImage
```

### 1.1 実測値

| 項目 | 実測 | 備考 |
|---|---|---|
| MJPEG フレームレート | **26.3 fps** (133 frames / 5s) | 安定 |
| フレーム間隔 | p50 38ms / p90 39ms / p99 41ms / max 43ms | ジッタは小さい |
| 1フレームサイズ | **107 KB** | 1206×2622（デバイス実解像度そのまま） |
| 帯域 | **2.9 MB/s**（mobilecli経由）/ 3.88 MB/s（WDA直） | サイドバー表示には過剰 |
| `io_tap` (mobilecli) | **578 / 595 / 596 / 596 / 632 ms** | ← 最大の問題 |
| `device_info` (mobilecli) | 280 ms | RPC 自体のオーバーヘッドも重い |
| WDA `/session/*/actions` 直叩き | **355 / 361 / 371 / 388 / 389 ms** | mobilecli を外しても 370ms 残る |
| 同上 + quiescence 無効化 | 370 ms 前後 | `waitForIdleTimeout:0` 等を入れても効果は僅か |
| `xcrun simctl io booted screenshot` | 90 ms | 単発取得の下限。ストリーム用途には不適 |
| 拡張ホストの MJPEG パース | **0.05–0.2 ms/frame** | 13.7MB/5s を 9–21ms で処理。ボトルネックではない |

> **入力 600ms・表示 38ms** という非対称が「操作が同期していない」体感の正体。
> タップして 0.6 秒後に反応するので、ドラッグ中の追従は原理的に不可能。

### 1.2 コード上の具体的な問題点

| # | 箇所 | 内容 | 影響 |
|---|---|---|---|
| A | `main.js:174-269` `mouseup` | ジェスチャを **指を離してから** まとめて送信 | ドラッグ中に画面が一切動かない。最大の体感劣化 |
| B | `SimulatorWebviewProvider.ts:495` | `io_gesture` はバッチ実行 API。途中経過を送れない | 慣性スクロール・ドラッグ追従が不可能 |
| C | `MjpegCapture.ts:199` | ループ毎に `new TextDecoder().decode(buffer)` でバッファ全体を UTF-8 デコード | 実測では軽いが O(n²)。将来の高解像度化で破綻 |
| D | `MjpegCapture.ts:186-193, 285-302` | `new Uint8Array` + `slice` の連続コピー | 同上（GC 圧） |
| E | `SimulatorWebviewProvider.ts:304-309` | 全フレームを `postMessage` で拡張ホスト→webview にコピー | 2.9MB/s の無駄なプロセス間コピー |
| F | `MjpegCapture.ts:376-386` `resetStream` | リセット時に `isCapturing=false` にするだけで **再接続しない** | 一度崩れると復帰しない |
| G | `MjpegCapture.ts:64-70` `updateConfig` | `this.start()` を await せず、`stop()` 直後に呼ぶ | 競合の可能性 |
| H | `SimulatorWebviewProvider.ts:62-66` | 非表示になると capture を止めるが、**再表示時に再開しない** | タブを戻すと黒画面 |
| I | `MobileCliServer.ts:142-151` | 既存サーバ検出は `12000` だけ。自前起動時は `12001+` | ポート探索と検出の不整合 |
| J | `MjpegCapture.ts` | `screencapture` の `scale` を未使用 | ただし **iOS では mobilecli 側が scale を無視する**（実測確認済） |
| K | `main.js:495-522` | キー入力を `io_text` に流すだけ。矢印キー・修飾キー・ハードキー未対応 | 「完全同期」には不足 |

---

## 2. 「完全同期」の定義（達成基準）

このレポートでは以下を満たす状態を「完全同期」と定義する。

| 軸 | 目標 |
|---|---|
| 表示遅延 | glass-to-glass **< 100ms**、30–60fps |
| 入力遅延 | pointerdown → 画面反映 **< 80ms** |
| ドラッグ追従 | 押下中の移動が **リアルタイムに** デバイス側へ流れる（バッチ送信でない） |
| 入力種別 | タップ / ドラッグ / 慣性スクロール / マルチタッチ（ピンチ）/ 物理キー / ハードキー / 回転 |
| テキスト | ホスト側キーボードがそのまま使える（IME・修飾キー含む） |
| クリップボード | ホスト ⇄ デバイス双方向 |
| 状態同期 | デバイス起動/終了/接続の自動追従、切断時の自動再接続 |
| エディタ統合 | デバッグセッション連動、スクリーンショット/録画のワークスペース保存 |

現状の達成度: 表示遅延 △ / 入力遅延 ✗ / ドラッグ追従 ✗ / 入力種別 △ / クリップボード ✗ / 状態同期 △

---

## 3. 選択肢の比較

### 3.1 表示（キャプチャ）経路

| 案 | 仕組み | 遅延 | 実装コスト | 備考 |
|---|---|---|---|---|
| **現行** | mobilecli /rpc → 拡張ホスト → postMessage | ~60–100ms | — | 余計な 2 ホップ |
| **A: webview 直結 MJPEG** | `<img src="http://localhost:PORT">` + `WebviewOptions.portMapping` | ~40–60ms | **小** | Chromium が multipart を**ネイティブ復号**。JS ゼロ |
| B: webview 内 fetch + ReadableStream | webview で自前パース → `createImageBitmap` | A と同等 | 中 | 古いフレームを捨てる制御が可能 |
| C: H.264 + WebCodecs | サイドカーで H.264 化 → WS → `VideoDecoder` | ~35–70ms | 大 | 帯域 1/10。VS Code/Cursor の Chromium は WebCodecs 対応済 |
| D: ScreenCaptureKit | Simulator.app のウィンドウを直接取り込む | 低 | 中 | 60fps 可。**画面収録権限**が必要、ウィンドウを開いておく必要あり |

> **A は「MJPEG が GET で取れる」場合のみ成立する。**
> mobilecli の MJPEG は `POST /rpc` なので `<img>` では取れない。ただし実測で
> **WDA の MJPEG サーバ (`http://localhost:13201/`) が GET で `multipart/x-mixed-replace` を直接返す**
> ことを確認済み。iOS はこれに直結できる。Android/汎用は拡張ホストに極小 GET プロキシを 1 本立てればよい。

```
Content-Type: multipart/x-mixed-replace; boundary=--BoundaryString
Server: WDA MJPEG Server
```

### 3.2 入力経路（ここが本丸）

| 案 | 仕組み | 実測/想定遅延 | リスク |
|---|---|---|---|
| **現行** | webview → 拡張ホスト → mobilecli → WDA | **600ms** | — |
| E: WDA 直叩き（セッション再利用） | webview → WS → WDA `/actions` | **370ms** | 低。だが目標未達 |
| F: WDA 設定チューニング | `waitForIdleTimeout:0` 等 | 370ms（効果ほぼ無し） | 低。**効果なしを実測済** |
| **G: Indigo HID 直接注入** | SimulatorKit の private SPI (`SimDeviceLegacyHIDClient` / `IndigoHID`) | **~10ms** | 高（private API・OS 更新で壊れる） |
| H: idb_companion | Meta の idb 経由で HID 注入 | ~10–30ms | 中（外部依存・要インストール） |
| I: scrcpy control socket (Android) | scrcpy-server の制御ソケット | <10ms | 低（枯れている） |

**G が唯一「押下追従」を実現できる。** 先行事例が複数ある:
- `mkloouo.ios-simulator-embed`（VS Code Marketplace）: ScreenCaptureKit + Indigo HID。Cursor 対応も明記。ただし **~12fps・CPU 重め**
- `tddworks/baguette`: SimulatorKit キャプチャ（MJPEG / H.264 AVCC）+ IndigoHID、WebSocket 双方向。
  iOS 26 では **Xcode 26 preview-kit の 9 引数シグネチャ / digitizer target `0x32`** を使う必要がある
- Claude Code の iOS Simulator ペイン: CoreSimulator private API を XPC 経由 + idb 由来の HID パス注入（`touch_path` で `{x,y,dt_ms}` の時系列を渡す）

### 3.3 Android

現状 mobilecli 依存（adb ベース、`input tap` 相当で 100–300ms 想定）。
**scrcpy 方式**（scrcpy-server を push → H.264/H.265 を adb ソケットで受信 → WebCodecs で復号、
制御ソケットにタッチイベントを直接流す）が実機/エミュ共通で最速・最も枯れている。
`ws-scrcpy` がブラウザ側 WebCodecs 復号の実装リファレンスになる。

> 注: 本調査環境には `adb` / `scrcpy` が未インストールのため、Android は**実測していない**（数値は文献値）。

---

## 4. 推奨アーキテクチャ

```
                    ┌─────────────── Webview ───────────────┐
                    │  <img src="http://localhost:PORT/…">  │  ← 表示: ネイティブ復号
                    │  pointerdown/move/up → WebSocket      │  ← 入力: 拡張ホストを経由しない
                    └────────┬──────────────────┬───────────┘
                             │ MJPEG(GET)       │ ws:// (binary/JSON)
                    ┌────────▼──────────────────▼───────────┐
                    │  Sidecar (Swift, extension bundle)     │
                    │   ├ Capture: SimulatorKit / SCKit      │
                    │   └ Input:   Indigo HID (直接注入)      │
                    └────────────────────────────────────────┘
                                     │ 起動/監視のみ
                    ┌────────────────▼───────────────────────┐
                    │  Extension Host (TS)                    │
                    │   デバイス一覧・起動・アプリ操作は mobilecli │
                    └─────────────────────────────────────────┘
```

**設計の要点**

1. **フレームを拡張ホストに通さない。** 表示は webview → ローカル HTTP/WS の直結にする。
   `WebviewOptions.portMapping` を使えば Remote SSH / Codespaces でも透過的に解決される
   （`@types/vscode` の該当箇所: 「webview が localhost にアクセスするなら、ポートが同じでも portMapping を指定することを推奨」）。
   **注意: portMapping は http/https のみ。`ws://` はマップされない** ので、
   WebSocket は実ポートを webview に渡す + リモート環境では `vscode.env.asExternalUri` で別途処理が必要。
2. **入力も拡張ホストを通さない。** `pointerdown` の瞬間に WS へ 1 メッセージ。
   `postMessage` → `handleMessage` → `fetch` の往復を挟むと、それだけで数十 ms 増える上に順序保証も弱い。
3. **mobilecli は「管理系」に残す。** デバイス一覧・boot/shutdown・アプリ install/launch・URL open は
   今のままで十分速く（280ms 程度）、クロスプラットフォームの価値がある。捨てる必要はない。
4. **CSP を更新する。** 現在は `default-src 'none'; img-src ${cspSource} data:` なので、
   `img-src` と `connect-src` にローカルサーバの origin を追加する必要がある
   （`SimulatorWebviewProvider.ts:786`）。

---

## 5. 段階的な実装プラン

### Phase 1 — 体感改善（1〜2日、リスク小、既存構成のまま）

遅延そのものは減らないが、「同期していない感」を大きく減らせる。

1. **押下と同時に送る**（`main.js:174-269` / `276-492`）
   - `pointerdown` で即 `pointerDown` を送信、`pointermove` を 16ms 間引きでストリーム、`pointerup` で確定。
   - Pointer Events API に統一し、mouse/touch の二重実装を解消する。
2. **楽観的フィードバック** — タップ位置に即座にリップルを描く。実デバイス反映を待たない。
3. **視覚的なドラッグ軌跡** — `gestureState.path` は既に収集済みなのに未描画。canvas にオーバーレイする。
4. **再接続とライフサイクル修正** — 上表 F/H/G/I を修正（`resetStream` 後の自動再接続、
   `onDidChangeVisibility` での再開、`updateConfig` の await、既存サーバ検出のポート範囲）。
5. **`io_tap` を待たない** — `handleTap` は `await` して webview をブロックする必要がない。fire-and-forget + エラー時のみ通知。

**達成見込み**: 体感遅延の「詰まり感」が消える。実遅延 600ms → 550ms 程度（本質的改善ではない）。

### Phase 2 — 経路短縮と帯域削減（3〜5日、リスク中）

6. **表示を webview 直結にする**
   - 拡張ホストに `GET /stream/:deviceId` の極小プロキシ（`http.createServer` + `pipe`、パース不要）を立てる。
     iOS だけなら WDA の 13201 に直結でもよいが、Android と実機を含めるならプロキシに寄せた方が一貫する。
   - webview 側は `<img>` 1 つ。`MjpegCapture.ts` / `enqueueFrame` / `createImageBitmap` の一式が不要になる。
   - CSP に `img-src http://localhost:PORT` を追加、`portMapping` を設定。
7. **WDA の MJPEG 設定を叩いて帯域を落とす**（実測で有効性確認済み）
   ```
   POST http://localhost:13001/session/<sid>/appium/settings
   {"settings":{"mjpegScalingFactor":35,"mjpegServerFramerate":30}}
   → 1206×2622 → 422×918 に縮小されることを確認
   ```
   サイドバー幅に合わせて `mjpegScalingFactor` を動的に変える。
   （`mjpegServerScreenshotQuality` は WDA 9.15.0 では期待通りに効かなかった。要追試）
   mobilecli の `scale` パラメータは **iOS では無視される**ので使えない（実測確認済み）。
8. **入力用 WebSocket** — 拡張ホストに WS サーバを立て、webview から直接ポインタイベントを流す。
   バックエンドは当面 WDA（370ms）だが、Phase 3 で差し替えられるよう
   `InputBackend` インターフェースで抽象化しておく。
9. **Android を scrcpy 方式へ** — `scrcpy-server` を adb push、H.264 を WebCodecs で復号、
   制御ソケットにタッチを流す。Android だけは Phase 2 の時点で「完全同期」に到達できる。

**達成見込み**: 表示遅延 40–60ms、帯域 2.9MB/s → 0.5MB/s。Android は入力 <10ms。iOS は 370ms のまま。

### Phase 3 — iOS Simulator ネイティブ経路（1〜2週、リスク高、本命）

> **2026-08-16 追記: 入力系は実装・実証済み。**
> タップ 0.044ms / ドラッグ 0.045ms / ホームボタン 0.036ms を実機で確認した。
> ピンチ・テキスト入力（修飾キー含む）・ホーム・ロックも動作する。
> Swift ABI を叩く必要はなく、全て ObjC ランタイム経由で完結する。
> スクロールホイールとホームインジケータのスワイプだけは動かせなかったが、
> それぞれドラッグとホームボタンで代替できるため実用上の欠落はない。
>
> 復元した API 仕様・target 定数・レートリミッタ・復旧手順は
> **[ios-hid-injection.md](./ios-hid-injection.md)** に、動作するコードは `spikes/simhid.m` にある。
> 以下の 10 番は当初の想定であり、実際にはより簡単だった（Swift サイドカーではなく ObjC で足りる）。

10. **Swift サイドカーバイナリを作る**（拡張に同梱、universal binary + 署名/公証）
    - 入力: `SimDeviceLegacyHIDClient` / `IndigoHID` による直接注入。
      iOS 26 では digitizer target `0x32` / Xcode 26 preview-kit の 9 引数シグネチャに対応が必要。
      `IOHIDEventCreateDigitizerEvent` + `IOHIDEventCreateDigitizerFingerEvent` を親子で構築すると
      ホームインジケータのスワイプやアプリスイッチャーのドラッグまで再現できる（baguette の実装が参考になる）。
    - 表示: SimulatorKit の IOSurface からフレームを取得 → JPEG または H.264(AVCC) 化 → WS 配信。
      代替として ScreenCaptureKit で Simulator.app のウィンドウを掴む方法もある（実装は容易だが
      **画面収録権限**と**ウィンドウが開いていること**が前提。先行拡張は ~12fps 止まり）。
11. **フォールバック設計** — private API が壊れた時に Phase 2 の WDA 経路へ自動降格する。
    Xcode / iOS のバージョン検出でバックエンドを選ぶ。
12. **残りの同期項目** — 物理キーボード（USB HID usage code、修飾キーは ⌘→Ctrl→Alt→Shift の順で押下、
    解放は逆順）、クリップボード双方向、回転、ハードキー、ファイル D&D でのアプリインストール。

**達成見込み**: 入力 ~10ms、表示 30–60fps。ドラッグ追従が成立し「完全同期」に到達。

---

## 6. リスクと判断が要る点

| リスク | 内容 | 緩和策 |
|---|---|---|
| private API 依存 | SimulatorKit / IndigoHID は非公開。Xcode 更新で壊れる（iOS 26 で実際にシグネチャ変更あり） | Phase 2 の WDA 経路を必ず残し自動降格。Xcode バージョン別の分岐 |
| 権限 | ScreenCaptureKit 採用時は画面収録権限のプロンプト | SimulatorKit 経路を第一候補にする（権限不要） |
| 配布 | Swift バイナリの同梱で VSIX が肥大化・署名/公証が必要 | universal binary 1 本に絞る。初回起動時ダウンロードも選択肢 |
| Cursor 互換 | Cursor 3.16.17 は VS Code 系フォークで API 世代が遅れる | `portMapping`(1.44+)・TypedArray 転送(WebviewView は 1.68+) はいずれも充足済み |
| リモート開発 | Remote SSH / Codespaces では localhost 直結が崩れる | http は `portMapping`、ws は `asExternalUri`。実機は remote 側にある前提で設計 |
| WDA セッション | セッション ID がローテーションする（実測で確認）。設定投入は毎回 ID 取得が必要 | `/status` から都度取得。mobilecli がセッションを握っている点にも注意 |

---

## 7. 補足: 検証したが「効かなかった/誤りだった」こと

再調査の無駄を避けるため記録しておく。

- ❌ **拡張ホストの MJPEG パースが重い** → 誤り。0.05–0.2ms/frame。最適化しても体感は変わらない。
- ❌ **`postMessage` が Uint8Array を JSON 配列に膨らませている** → 誤り。
  VS Code は 1.68（PR #148429）で WebviewView でも TypedArray 転送に対応済み。コピーは発生するが JSON 化はされない。
- ❌ **mobilecli の `screencapture` に `scale` を渡せば軽くなる** → iOS では無視される。
  100% / 50% で送っても出力は 1206×2622 のまま（実測）。Android では効く可能性あり（未検証）。
- ❌ **WDA の quiescence 待ちを切れば速くなる** → ほぼ効果なし（410ms → 370ms）。
- ❌ **`mjpegServerScreenshotQuality` で帯域を落とす** → WDA 9.15.0 では期待と逆の挙動（q20 の方が大きい）。
  効いたのは `mjpegScalingFactor` の方。
- ✅ **WDA の MJPEG は GET で直接取れる** → `http://localhost:13201/` が `multipart/x-mixed-replace` を返す。
- ✅ **WDA 直叩きでもセッション経由なら 370ms** → mobilecli の中継コストは約 200ms。

---

## 8. 再現手順

```bash
# サーバ起動
./node_modules/@mobilenext/mobilecli/bin/mobilecli-darwin-arm64 server start --cors --listen localhost:12099

# デバイス一覧 / 起動（調査時点。現行は `"method":"devices.list"`）
curl -s -X POST localhost:12099/rpc -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"devices","params":{"includeOffline":true}}'

# 入力遅延の計測（調査時点のメソッド名。現行は `device.io.tap`）
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w "%{time_total}\n" -X POST localhost:12099/rpc \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"io_tap","params":{"deviceId":"<UDID>","x":300,"y":900}}'
done

# WDA のポートを見つける（13001=HTTP, 13201=MJPEG）
lsof -nP -iTCP -sTCP:LISTEN | grep WebDriver

# WDA 直叩き（セッション ID は毎回取得すること）
SID=$(curl -s localhost:13001/status | python3 -c "import sys,json;print(json.load(sys.stdin)['sessionId'])")
curl -s -X POST localhost:13001/session/$SID/appium/settings \
  -H 'Content-Type: application/json' \
  -d '{"settings":{"mjpegScalingFactor":35,"mjpegServerFramerate":30}}'

# MJPEG を GET で直接取得（webview の <img> と同じ経路）
curl -s -m 5 http://localhost:13201/ -o wda.bin
```

---

## 9. 参考

- [VS Code: Improve transfer of ArrayBuffers to and from webviews (#115807)](https://github.com/microsoft/vscode/issues/115807)
- [VS Code: WebviewView でも TypedArray 転送に対応 (PR #148429, 2022年5月)](https://github.com/microsoft/vscode/pull/148429)
- [VS Code: Supporting Remote Development and GitHub Codespaces](https://code.visualstudio.com/api/advanced-topics/remote-extensions)
- [iOS Simulator (streamed panel) — ScreenCaptureKit + Indigo HID の先行拡張](https://marketplace.visualstudio.com/items?itemName=mkloouo.ios-simulator-embed)
- [tddworks/baguette — SimulatorKit キャプチャ + IndigoHID、iOS 26 対応の実装リファレンス](https://github.com/tddworks/baguette)
- [facebook/idb — HID 注入と video-stream](https://github.com/facebook/idb) / [idb: Video](https://fbidb.io/docs/video/)
- [himanshkukreja/ios-bridge — WS/WebRTC ストリーミング構成](https://github.com/himanshkukreja/ios-bridge)
- [What's Inside Claude Code's iOS Simulator Pane](https://mobai.run/blog/claude-code-ios-simulator-pane)
- [mobile-next/mobilecli](https://github.com/mobile-next/mobilecli)
