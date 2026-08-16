# マージ前の厳密レビュー（取り込み可否の判定）

現在の未コミット変更を**厳密にレビュー**し、マージの安全性とコード品質を担保する。取り込める状態になるまで改善点を明確にし、指摘を解消する。

**コミットはレビュー合格後にのみ行う。** このコマンドはレビューが主目的であり、コミットは判定後の選択肢からのみ実行する。

## 手順

### 1. 変更の把握

- `git status -s` と `git diff`（未追跡は該当ファイルを読む）で**変更内容をすべて把握**する。
- 変更ファイル一覧と差分の概要を簡潔にまとめる。
- レイヤー別に分類する。

| レイヤー | パスの目安 |
|----------|------------|
| 拡張ホスト / webview 橋渡し | `src/extension.ts` / `src/webview/` |
| 入力 | `src/input/` |
| 表示・キャプチャ | `src/capture/` |
| デバイス / mobilecli | `src/simulator/` / `src/utils/` |
| webview UI | `media/webview/` |
| ネイティブサイドカー | `native/` |
| テスト | `test/` |
| ドキュメント | `docs/` / `README.md` |
| ビルド・設定 | `package.json` / `.gitignore` / `.vscodeignore` / `.vscode/` / `.cursor/` |
| 調査用（通常はマージ対象外） | `spikes/` |

### 2. プロジェクト基準の確認

以下を参照し、既存パターンとの一貫性をチェックする。

- **[docs/sidecar-protocol.md](docs/sidecar-protocol.md)** — 入力経路（webview → 拡張ホスト → HID/WDA）・JSON Lines・降格
- **[docs/ios-hid-injection.md](docs/ios-hid-injection.md)** — HID 注入の制約（レートリミッタ・座標は正規化・私有 API）
- **[docs/sync-research.md](docs/sync-research.md)** — 表示経路（拡張ホスト経由 vs webview 直結）と帯域
- **[docs/remaining-work.md](docs/remaining-work.md)** — 既知の残作業・意図的な保留（Android scrcpy 等）

特に次を確認する。

| ルール | 確認内容 |
|--------|----------|
| **入力抽象** | タッチ/キーは `InputBackend` 経由か。webview や Provider が HID/WDA を直接呼び出していないか |
| **座標** | 拡張ホスト以降は正規化 `[0,1]`。ピクセル変換は `WdaBackend` のみか |
| **HID 対象** | HID は iOS Simulator のみ。実機・Android・`type` 不明時は WDA フォールバックか |
| **私有 API 隔離** | SimulatorKit / IndigoHID / `objc_msgSend` は `native/simhid-server.m` のみか。TypeScript から直接呼んでいないか |
| **サイドカープロトコル** | stdin/stdout は JSON Lines。stderr はログ専用。コマンドには `device`（UDID）があるか |
| **降格** | HID 起動失敗・fatal・バイナリ欠損で WDA に落ちるか。WDA 経路で tap/longPress/特殊キーが退行していないか |
| **表示経路** | フレームの重い処理を拡張ホストに増やしていないか。`directStream` 時はプロキシが GET+pipe に留まっているか |
| **webview CSP** | `script-src` は nonce。直結 MJPEG なら `img-src` に localhost が必要か確認 |

### 3. 品質チェックの実行

- **テスト**: `npm test` を実行し、失敗が 0 であることを確認する。
- **コンパイル**: テストが `compile` を含まない場合、または native/TS の型が変わっている場合は `npm run compile` も実行する。
- **lint**: 入力・webview・capture のロジック変更があれば `npm run lint` を実行する（失敗はブロッカー）。
- **native**: `native/simhid-server.m` を変更した場合は、可能なら `npm run build:native` も実行する（macOS 以外ではスキップし、手動検証に回す）。
- GUI / 実 Simulator / タッチ追従など自動テスト不能な変更がある場合は、短く列挙する（例: webview の pointer 経路、HID→WDA 降格の status 表示、`directStream` の `<img>` 表示）。

### 4. 厳密レビュー観点

以下を**必須**で確認する。

| 観点 | 確認内容 |
|------|----------|
| **セキュリティ** | 待ち受けは localhost 限定か。外部 URL への送信・認証情報のログがないか。webview が任意 URL を読み込まないか。私有 API が native 外に漏れていないか |
| **入力の正しさ** | `init()` 完了前に tap 等が走って落ちないか。longPress が WDA で tap に化けないか。Delete/Escape 等の special key が WDA で no-op になっていないか。`device.type` 欠落で実機に HID を選んでいないか |
| **ライフサイクル** | デバイス切替・非表示・disconnect で sidecar / capture / proxy を dispose しているか。再表示でキャプチャが再開するか。プロセス再起動は無限ループになっていないか |
| **並行性・応答性** | `touchMove` が応答待ちで UI を塞いでいないか（HID は fire-and-forget）。MJPEG のキューがメモリを膨らませていないか |
| **フォールバック** | HID が使えない環境（非 Mac、バイナリ未ビルド、実機）でも WDA で従来どおり操作できるか |
| **配布・ビルド** | `vscode:prepublish` / `build:native` が非 macOS で無防備に失敗しないか。`.vscodeignore` がソースを誤って同梱/除外していないか |
| **テスト** | ロジック変更に対応するテストがあるか。`test/webview-pointer.test.js`（pointer/座標）と `test/sidecar-protocol.test.js`（JSON Lines・バックエンド選択）の回帰が壊れていないか |

### 5. レビュー結果の出力形式

以下の形式で**必ず**出力する。

```
## 変更概要
- （変更ファイルと役割の一行サマリ）

## 品質チェック
- npm test: （結果）
- npm run compile / lint / build:native: （実行した場合のみ・結果）
- 手動検証が必要な項目: （あれば列挙、なければ「なし」）

## マージ安全性
- **ブロッカー（必須で直す）**: （あれば箇所と理由、なければ「なし」）
- **強く推奨（直すべき）**: （あれば箇所と理由、なければ「なし」）
- **任意の改善**: （あれば簡潔に、なければ「なし」）

## 判定
- **取り込み可** / **要修正のため取り込み不可**
  - 取り込み不可の場合は、上記ブロッカー（と強く推奨）を解消したうえで再度このコマンドを実行すること。
```

### 6. 判定基準

- **ブロッカーが 1 つでもある**、または **`npm test` が失敗** → **取り込み不可**。
- ブロッカーがなく、強く推奨のみ → **取り込み可**（強く推奨は修正を依頼するが、マージは許可）。
- ブロッカーも強く推奨もない → **取り込み可**。

意図的な保留（Android scrcpy、サイドカーの署名・公証など [docs/remaining-work.md](docs/remaining-work.md) 記載）は、今回の差分がそれを壊していなければブロッカーにしない。

### 7. 次のアクション選択

レビュー結果の出力後、**判定に応じた選択肢**を `AskQuestion` ツールで提示する（使えなければ同等の質問を会話で行う）。

#### 「取り込み可」の場合

| 選択肢 | 説明 |
|--------|------|
| **機能別にコミット** | `/commit-by-feature` の手順で、機能・役割ごとに分割コミットする（コミット前にグループ分け案を提示して確認） |
| **全変更を 1 コミット** | 変更をまとめて 1 コミットする（メッセージは変更内容から生成し、実行前に確認） |
| **強く推奨の項目を先に修正** | 強く推奨がある場合のみ表示。指摘を自動修正してから再レビューする |
| **何もしない** | レビュー結果の確認のみで終了する |

#### 「取り込み不可」の場合

| 選択肢 | 説明 |
|--------|------|
| **ブロッカーを自動修正** | 指摘されたブロッカー（と強く推奨）を自動修正し、再度 `/review-for-merge` を実行する |
| **何もしない（手動で直す）** | レビュー結果を参考に手動で修正する。修正後に再度 `/review-for-merge` を実行すること |

選択に応じて対応を実行する。**レビュー未実施・取り込み不可のままコミットしない。**

## 注意

- レビューは**コードの内容に基づいて**行う。推測で「多分大丈夫」にしない。
- 入力の正しさ（HID 対象の限定・WDA 退行防止）と私有 API の隔離を最優先する。
- `AskQuestion` の選択肢は判定結果に応じて動的に変える（不要な選択肢は出さない）。
