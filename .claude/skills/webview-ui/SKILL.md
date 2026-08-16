---
name: webview-ui
description: この拡張の webview UI（media/webview/ の index.html / style.css / main.js）を触るときの作法。見た目の変更、ボタン・トグルの追加、オーバーレイやリソース表示の調整、webview と拡張ホストのメッセージ追加で使う。
---

# webview UI

対象は `media/webview/` の 3 ファイルだけ。ホスト側は
`src/webview/SimulatorWebviewProvider.ts` の `handleMessage` / `postMessage`。

## 制約（外すと即壊れる）

- **CSP 下で動く**。外部 CDN・インライン `<script>`・Web フォントは不可。
  `img-src` は `webview.cspSource` と `data:` のみ（`SimulatorWebviewProvider` の
  `cspMeta`）。画像が要るなら CSS で描くか data URI にする。
- **色はテーマ変数**（`--vscode-button-background` など）を第一候補に、
  `var(--x, フォールバック)` で書く。固定色は端末の筐体（`.phone-frame`）だけ。
- **座標は正規化 [0,1]** で送る。ピクセル変換は webview の外でやらない。

## レイアウト

`body` が flex column。`.toolbar { margin-bottom: auto }` と
`.resources { margin-top: auto }` の 2 つの auto が余白を等分し、
`.stage`（筐体＋ボタン列）が縦中央に来る。**この 2 行が中央寄せの本体**なので、
`.phone-frame` に `margin: auto` を足すと筐体とボタン列の間が開く。

## 状態の置き場

- webview 内で完結する表示の好み（Trail など）→ `vscode.setState()`。
- 拡張ホストや設定と共有するもの（autoConnect など）→ `postMessage` でホストへ渡し、
  ホストからの通知で確定させる（楽観更新 → 上書き）。
- `globalState` / ファイル書き込みは使わない（CLAUDE.md「ストレージ / メモリ管理」）。

## 高頻度パスに触るとき

`frame` は毎秒 20〜30 回、`touchMove` はドラッグ中 60Hz。ここで
**DOM を毎回書き換えない・ログを出さない**。`setOverlayVisible` が直近状態を
覚えて差分だけ適用しているのが手本。バッファ・キュー・配列を足すなら上限も同時に書く。

## 確認

```bash
npm test   # test/webview-pointer.test.js が main.js を DOM スタブ上で実行する
```

DOM スタブは `test/webview-pointer.test.js` の `makeEl` / `els`。
新しい `getElementById` を足したら `els` にも足す（無いと no-op の偽要素が返り、
テストが素通りする）。見た目だけの CSS 変更はテスト不要、
**振る舞いが増えたらケースを 1 つ足す**。
