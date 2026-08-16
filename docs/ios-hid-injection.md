# iOS Simulator への HID 直接注入 — 実証済み仕様

検証日: 2026-08-16 / 環境: macOS 26 (Darwin 25.6.0), Xcode 26.6 (Build 17F113),
iPhone 17 Simulator (iOS 26.5), Cursor 3.16.17 / VS Code 1.131.0

このドキュメントは非公開 API の**逆アセンブルと実機検証**から得た仕様をまとめたもの。
ヘッダも `.swiftinterface` も存在しないため、ここに書かれた内容が唯一の一次情報になる。
動作する参照実装は `spikes/simhid.m`。

---

## 0. 結論

**動く。しかも桁違いに速い。**

| 経路 | タップ1回の遅延 |
|---|---|
| 現行 (mobilecli → WDA) | 578〜632 ms |
| WDA 直叩き | 355〜415 ms |
| **HID 直接注入** | **0.04 ms** |

### 実装できたもの（全て実機で動作確認済み）

| 機能 | 手段 | 実測 |
|---|---|---|
| タップ | `IndigoHIDMessageForMouseNSEvent` target `0x32` | down 0.044ms / up 0.046ms |
| ドラッグ・スクロール | 同上（NSEventType 6 を連続送信） | 0.045〜0.13 ms/イベント |
| 2本指ピンチ | 同上（第2引数に2点目を渡す） | マップのズームを確認 |
| ホームボタン | `IndigoHIDMessageForButton(0, op, 0x33)` | 0.036ms |
| 電源/ロックボタン | `IndigoHIDMessageForButton(1, op, 0x33)` | 0.038ms |
| テキスト入力 | `IndigoHIDMessageForKeyboardArbitrary` | 「Hello World」を入力 |
| 修飾キー | `IndigoHIDMessageForModifierKeyBit(17, op)` = Shift | 大文字入力を確認 |

### できなかったもの

| 機能 | 状況 | 代替 |
|---|---|---|
| スクロールホイール | 送信は成功するが iOS が無反応 | **ドラッグで代替可**（実証済み） |
| ホームインジケータのスワイプ | 送信は成功するが無反応 | **ホームボタン(code 0)で代替可** |
| 音量・Siri 等のボタン | code 2〜16, 401, 3000 いずれも無反応 | なし |

代替手段が揃っているため、実用上の欠落はない。

**Simulator.app は不要**（`simctl boot` のヘッドレス状態で動作する）。

---

## 1. 全体の仕組み

```
自プロセス
  ├ dlopen CoreSimulator.framework   → SimDevice を取得（ObjC）
  ├ dlopen SimulatorKit.framework    → HID クライアント + Indigo メッセージ生成関数
  │    ├ objc_lookUpClass("_TtC12SimulatorKit24SimDeviceLegacyHIDClient")
  │    └ dlsym("IndigoHIDMessageFor…")
  └ sendWithMessage:… で mach ポートへ送信 → シミュレータの HID スタックへ
```

**重要**: `SimDeviceLegacyHIDClient` は Swift クラスだが `NSObject` を継承しているため
ObjC ランタイムに `_TtC12SimulatorKit24SimDeviceLegacyHIDClient` として登録されている。
**Swift ABI を直接叩く必要は一切ない。** 全て `objc_msgSend` で完結する。

### フレームワークのパス

```
/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/CoreSimulator
<DEVELOPER_DIR>/Library/PrivateFrameworks/SimulatorKit.framework/Versions/A/SimulatorKit
```
`<DEVELOPER_DIR>` は `xcode-select -p` で取得すること。ハードコードしない
（検証環境では `/Applications/Xcode.app` ではなく `/Applications/Xcode-26.6.0.app` が実体だった）。

---

## 2. target 定数 — 最大の落とし穴

Indigo のメッセージは「どの仮想 HID デバイス宛か」を表す `target` を持つ。
**これを誤ると受信側が壊れる。** 症状が分かりにくいので必ず把握しておくこと。

| target | 用途 | 出所 |
|---|---|---|
| **`0x32`** | タッチ（デジタイザ） | 実機の総当たりで確定 |
| **`0x33`** | ハードウェアボタン | `SimDeviceScreen.buttonTarget` の逆アセンブル |
| `0x35` | トラックパッド | SimulatorKit が渡している定数 |
| `0x36` | マウス | `IndigoHIDMessageToCreateMouseService` |
| `10000` | キーボード | 生成関数が内部で固定（引数不要） |
| `0x40000000` | `IndigoHIDTargetForScreen(0)` の戻り値。**タッチに使うと壊れる** | — |

### 誤った target を使ったときの症状

1. 1通目の送信は成功する（エラーが返らない）
2. 直後に画面が真っ黒になる
3. 2通目以降が `HIDError.machPortNotConnected` で失敗し続ける
4. デバイスを再起動するまで復旧しない

**副作用が遅れて出る**ため「送信は成功しているのに動かない」と誤読しやすい。

### 0x35 / 0x36 を使うならサービス登録が必要

`IndigoHIDMessageToCreatePointerService()` / `…CreateMouseService()` は
**引数なし**でメッセージを返す。これを先に送らずに target `0x35` へ送ると上記の症状になる。
登録しておけば送信自体はエラーなく通る（ただし後述の通り iOS 側は無反応）。

```
CreatePointerService : eventType=0x7fff0001, [0x30]=3, [0x40]=0x35
CreateMouseService   : eventType=0x7fff0001, [0x30]=5, [0x40]=0x36
```
解除は `…RemovePointerService()` / `…RemoveMouseService()`。

---

## 3. SimDevice の取得と HID クライアント

```objc
Class ctxCls = objc_lookUpClass("SimServiceContext");
id ctx = [ctxCls sharedServiceContextForDeveloperDir:developerDir error:&err];
id deviceSet = [ctx defaultDeviceSetWithError:&err];
NSArray *devices = [deviceSet devices];   // SimDevice の配列。d.UDID / d.stateString で絞り込む

Class hidCls = objc_lookUpClass("_TtC12SimulatorKit24SimDeviceLegacyHIDClient");
id client = [[hidCls alloc] initWithDevice:device error:&err];
```

ObjC から見えるメソッドは 4 つ（ランタイム走査で確認）:

| セレクタ | 型エンコーディング |
|---|---|
| `initWithDevice:error:` | `@32@0:8@16^@24` |
| `initWithDevice:sessionResetQueue:error:sessionResetHandler:` | `@48@0:8@16@24^@32@?40` |
| `resetHIDSession` | `v16@0:8` |
| `sendWithMessage:freeWhenDone:completionQueue:completion:` | `v44@0:8^{IndigoHIDMessageStruct=…}16B24@28@?36` |

### 送信とメモリ管理

```objc
[client sendWithMessage:msg freeWhenDone:NO completionQueue:queue completion:^(NSError *e){…}];
free(msg);   // メッセージは calloc 由来。自分で解放する
```

`freeWhenDone:YES` にすると、エラー時にリトライしたときへ**解放済みポインタを再送して
二重解放でクラッシュする**（`malloc: pointer being freed was not allocated` → SIGABRT）。
`NO` で送って自前で解放するのが安全。

### ポートが壊れたときの復旧 — `resetHIDSession` を呼んではいけない

実測した復旧手段の結果:

| 手段 | 結果 |
|---|---|
| `resetHIDSession` を呼ぶ | ❌ **呼んだ直後に `machPortNotConnected` になる**（むしろ壊す） |
| **クライアントを作り直す** | ✅ 復旧する |
| 数秒待つ | ✅ 復旧していた（作り直し後のため単独効果は不明） |

したがってエラー時のリトライは `initWithDevice:error:` からやり直すこと。

### 画面消灯はポート断ではない

シミュレータの画面が自動スリープで真っ黒（スクリーンショット約 52KB）になっても
HID ポートは生きている。ホームボタンを送れば復帰する。
**「黒画面 = 壊れた」と即断しないこと。** 壊れている場合は必ず送信エラーが伴う。

---

## 4. タッチ（タップ・ドラッグ・ピンチ）

SimulatorKit のタッチ経路は `SimDeviceLegacyHIDClient.simDigitizerInputView(_:touchEvent:)` を
逆アセンブルして特定した。内部で **`IndigoHIDMessageForMouseNSEvent`** を呼んでいる
（デジタイザ専用の生成関数は存在しない）。

```c
void *IndigoHIDMessageForMouseNSEvent(
    const CGPoint *p1,       // x0: 正規化座標 (0.0〜1.0)
    const CGPoint *p2,       // x1: 2点目。単指なら NULL
    uint64_t target,         // x2: 0x32
    uint64_t nsEventType,    // x3: NSEventType
    uint64_t buttonNumber,   // x4: 0
    double scaleX,           // d0: 1.0
    double scaleY);          // d1: 1.0
```

### NSEventType

| フェーズ | 値 | 定数 |
|---|---|---|
| 押下 | 1 | `NSEventTypeLeftMouseDown` |
| ドラッグ | 6 | `NSEventTypeLeftMouseDragged` |
| 解放 | 2 | `NSEventTypeLeftMouseUp` |

関数内のビットマスク判定が裏付け:
`0xa`(bit 1,3)=down系 / `0x14`(bit 2,4)=up系 / `0xc0`(bit 6,7)=drag系。

### ドラッグには約 16ms のレートリミッタがある

`IndigoHIDMessageForMouseNSEvent` 内に明示的なスロットリングがある:

```asm
mov  w12, #0x802
tst  w11, w12          ; down/up はフラグに 0x2 が立つので素通り
b.ne .proceed
ldr  x12, [x10, #0x430]   ; 前回のタイムスタンプ
mov  w13, #0x23ff
movk w13, #0xf4, lsl #16  ; 0xF423FF = 16,000,255 ns ≈ 16ms
sub  x12, x9, x12
cmp  x12, x13
b.hi .proceed
free(msg); return NULL    ; ← 16ms 以内の drag は破棄される
```

- **drag は前回から 16ms 以上空けないと NULL が返る**（約 60Hz が上限）
- down / up はこの制限を受けない
- 8ms 間隔だと 30件中 30件が NULL。**17ms 間隔なら全て通る**
- `down` の直後の最初の drag も対象なので、down 後にも 17ms 待つこと

実用上 60Hz あれば十分なので制約にはならないが、**知らないと「ドラッグだけ効かない」で必ずハマる**。

### 2本指（ピンチ）

`p2` に 2 点目を渡すだけ。メッセージのペイロード数が 2 → 3 に増える
（割り当てサイズ 0x160 → 0x200）。マップアプリでズームが動作することを確認済み。

---

## 5. ハードウェアボタン

```c
void *IndigoHIDMessageForButton(uint32_t keyCode, uint32_t op, uint32_t target);
// op: 1 = 押下, 2 = 解放 / target: 0x33
```

| keyCode | 機能 |
|---|---|
| **0** | **ホーム** |
| **1** | **電源 / ロック** |
| 2〜16, 401, 3000 | 無反応（実機で確認） |

`IndigoHIDTargetForScreen` の実体は `w0 | 0x40000000` を返すだけの 2 命令。
ボタンにこれを使うと壊れる。正しくは `SimDeviceScreen.buttonTarget` = **`0x33`**。

---

## 6. キーボード

```c
void *IndigoHIDMessageForKeyboardArbitrary(uint64_t usageCode, uint64_t op);
// op: 1 = 押下, 2 = 解放。target 引数はない（内部で 10000 固定）
```

`usageCode` は**標準の USB HID Keyboard/Keypad usage page**。
`IndigoHIDStringForKeyUsageCode(code, 0)` を総当たりで呼べば表が丸ごと吸い出せる
（NSDictionary を引くだけの関数）。主要な値:

| 文字 | usage | 文字 | usage |
|---|---|---|---|
| a〜z | 0x04〜0x1d | 1〜9 | 0x1e〜0x26 |
| 0 | 0x27 | Enter | 0x28 |
| Esc | 0x29 | Backspace | 0x2a |
| Tab | 0x2b | Space | 0x2c |
| `-` | 0x2d | `.` | 0x37 |
| `,` | 0x36 | `/` | 0x38 |
| `;` | 0x33 | ← → ↓ ↑ | 0x50 0x4f 0x51 0x52 |

### 修飾キー

```c
void *IndigoHIDMessageForModifierKeyBit(uint32_t bit, uint64_t op);
```

**`bit` の有効範囲は 16〜20 だけ。** 関数は `bit - 0x10` でテーブルを引くため、
16 未満を渡すと**範囲外読み**になり、以降のキー入力が壊れる
（bit=1 を渡したら後続の文字が全て飲まれた）。入口チェックは `bit <= 0x14` しかないので
小さい値でもエラーにならない点に注意。

| bit | usage | 意味 |
|---|---|---|
| 16 | 0x39 | Caps Lock |
| **17** | 0xE1 | **Left Shift** |
| 18 | 0xE0 | Left Control |
| 19 | 0xE2 | Left Option |
| 20 | 0xE3 | Left Command |

**`op` の意味がキーとは逆。** 逆アセンブル (`cmp w19,#0; cinc w10,w23,eq`) の通り
**非0 = 押下 / 0 = 解放**。キー側の 1=押下・2=解放 と混同しないこと。

---

## 7. 動かなかったもの（記録）

### スクロールホイール

```c
void *IndigoHIDMessageForScrollEvent(uint64_t target, uint64_t flags,
                                     double dx, double dy, double dz);
// arm64 では整数が x0/x1、浮動小数が d0〜d2 に割り当たる
```

- `flags = 0` または `2` → 画面が消灯する（不正値）
- `flags = 1` → 送信は成功し画面も消えないが、**iOS 側が一切反応しない**
- ポインタサービスを登録しても変わらない
- SimulatorKit 自身はこの関数を呼んでいない（`…FromHIDEventRef` 版だけを使う）ため参照実装がない

→ **ドラッグで代替する。** リストのスクロールは実証済み。

### ホームインジケータのスワイプ / エッジジェスチャ

- MouseNSEvent 経路で y=0.99〜1.0 から上方向に振っても反応しない（速度・ステップ数を変えても同じ）
- `IOHIDEventCreateDigitizerEvent` + `…FingerEvent` + `IndigoHIDMessageForTrackpadEventFromHIDEventRef`
  （target `0x35`、ポインタサービス登録済み）でも送信は 12/12 成功するが無反応
- ロック画面のスワイプ解除は MouseNSEvent で動くので、エッジ判定だけが別扱いになっている
- `SimDigitizerInputView.TouchEvent` に `edge: IndigoHIDEdge` フィールドがあり、
  `edge != 1` のとき 2 点目を渡す実装になっている。ここが鍵と思われるが未解明

→ **ホームボタン（keyCode 0）で代替する。**

---

## 8. メッセージ構造体

`sendWithMessage:` の ObjC 型エンコーディングから完全なレイアウトが取れる:

```
IndigoHIDMessageStruct = {
  {?=IIIIIi}   header;        // 0x00, 24バイト（calloc のままゼロで良い）
  I            payloadStride; // 0x18 = 0xa0 (160) 固定
  C            payloadCount;  // 0x1c  ボタン/キー=1, マウス単点=2, 2点=3
  [0 {…}]      payloads;      // 0x20 から stride 0xa0 で並ぶ
}
payload = {
  I  eventType;   // 0x20  2=button/keyboard, 6=scroll, 0xb=mouse, 0x7fff0001=service
  Q  timestamp;   // 0x28
  I  …;           // 0x30
  union _event {  // 0x38
    _extended, _touch_event{IIIdddddIIIIIdddddI}, _pointer_event{dddII},
    _button_event{IIIIII}, _scroll_event, _gamecontroller_event, …
  }
  c; C; [2C]; Q;
}
```

割り当てサイズは `0x20 + payloadCount * 0xa0`
（ボタン/キー=0xc0 / マウス単点=0x160 / 2点=0x200）。

---

## 9. バージョン耐性

全て非公開 API のため Xcode 更新で壊れる前提で設計すること。

1. 起動時に `objc_lookUpClass` と各 `dlsym` の成否を検査する
2. `target` 定数が変わりうる。`SimDeviceScreen.buttonTarget` のように
   実行時に取得できるものは取得する
3. 検査に失敗したら WDA 経路（約 400ms）へ自動降格する
4. iOS 26 で digitizer target が変わった実績がある（先行事例の baguette も言及）

---

## 10. 参考にした先行事例

- [tddworks/baguette](https://github.com/tddworks/baguette) — IndigoHID を使った実装
- [mkloouo.ios-simulator-embed](https://marketplace.visualstudio.com/items?itemName=mkloouo.ios-simulator-embed)
  — ScreenCaptureKit + Indigo HID の VS Code 拡張（約12fps）
- [facebook/idb](https://github.com/facebook/idb) — 旧 Xcode 時代の `SimDeviceLegacyHIDClient` 利用例

---

## 11. 再現手順

```bash
clang -fobjc-arc -framework Foundation -framework CoreFoundation -o simhid spikes/simhid.m
xcrun simctl boot <UDID>

./simhid <UDID> home
./simhid <UDID> tap   0.843 0.484
./simhid <UDID> drag  0.5 0.72 0.5 0.3
./simhid <UDID> pinch 0.5 0.4 0.06 0.3
./simhid <UDID> type  'Hello World'
./simhid <UDID> bench 0.5 0.5
./simhid <UDID> lock
```

`spikes/introspect.swift` は SimulatorKit / CoreSimulator の
クラスとシンボルをランタイムで一覧するツール。Xcode 更新時の差分確認に使う。
