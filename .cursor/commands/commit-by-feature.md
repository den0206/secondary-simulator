# 機能別に Conventional Commit でコミットする

現在の未コミット変更を**レビューしたうえで**、**機能・役割ごとに分けて**複数のコミットに分割する。

**必ずコミット前にレビューする。** レビュー不合格のまま `git commit` しない。

## 手順

### 1. 変更の把握

- `git status -s` と `git diff --name-only`（必要なら `git diff --name-only --cached`）で変更・未追跡ファイル一覧を取得する。
- 各ファイルの役割を考慮し、**論理的なグループ**に分類する。

secondary-simulator 向けの典型グループ例:

| グループ例 | 対象の目安 |
|------------|------------|
| `input` | `src/input/`（HID/WDA・Controller・sidecar クライアント） |
| `capture` | `src/capture/`（MJPEG / プロキシ / WDA 設定 / H.264） |
| `webview` | `src/webview/`・`media/webview/` |
| `native` | `native/simhid-server.m` とビルドスクリプト（`package.json` の native 部分） |
| `mobilecli` / `utils` | `src/utils/`・`src/simulator/` |
| `test` | `test/` |
| `docs` | `docs/`・`README.md` |
| `chore` | `package.json`・`.gitignore`・`.vscodeignore`・`.vscode/`・`.cursor/` |
| `spikes` | `spikes/`（調査用。本番機能と混ぜない） |

同じ機能の「新規ファイル」と「既存ファイルの修正」、対応するテストは**同じグループ**に含めてよい。  
`package.json` が native ビルドとテストスクリプトの両方を含む場合は、主たる変更に寄せるか、`chore` を分けてよい。

### 2. コミット前レビュー（必須）

コミット操作の前に、変更全体をレビューする。

- 直前に `/review-for-merge` を実行済みで**取り込み可**なら、その結果を再利用してよい（差分が変わっていない場合）。
- 未実施、または差分が変わっている場合は、`/review-for-merge` と同等の確認を行う:
  - 差分を読む（未追跡はファイルを読む）
  - [docs/sidecar-protocol.md](docs/sidecar-protocol.md) の境界（`InputBackend`・正規化座標・HID は iOS Simulator のみ・私有 API は `native/` のみ）を確認
  - ロジック変更があれば `npm test` を実行し、失敗ならコミットしない
- ブロッカーがある、またはテスト失敗なら**ここで停止**し、修正を促す。コミットに進まない。

レビューの要約（変更概要・ブロッカー有無・テスト結果）を短く示してから次へ進む。

### 3. グループ分け案の提示

- 機能・役割ごとのグループ分け案と、想定コミットメッセージを**簡潔に提示**する。
- 問題なければ次へ進む。ユーザーが修正を求めたら案を直す。
- `AskQuestion` が使える場合は「この案でコミットする / 案を修正する / やめる」を提示する。
- ユーザーが特定ファイル（例: `docs/remaining-work.md`）を除外するよう指示していれば、そのファイルはステージしない。

### 4. グループごとにコミット

各グループに対して順に以下を実行する:

1. そのグループに属するファイルだけを `git add` する。
2. **Conventional Commit** 形式で、**簡潔な日本語の一行**のコミットメッセージで `git commit` する。
3. ユーザーの git ルールに従う（`-i` 不使用、秘密情報を含めない、`git_write` 権限が必要）。

## Conventional Commit の形式

```
<type>(<scope>): <簡潔な日本語の一行説明>
```

- **type**: `feat`（新機能）, `fix`（修正）, `docs`（ドキュメント）, `style`（見た目・フォーマット）, `refactor`（リファクタ）, `chore`（ビルド・設定・スクリプト）, `test` など。
- **scope**: 任意。プロジェクト文脈に合わせて短く指定する例:
  - `input` / `hid` / `wda` / `sidecar`
  - `capture` / `mjpeg` / `proxy`
  - `webview` / `pointer`
  - `native` / `mobilecli`
  - `test` / `docs` / `build`
- **本文**: 何をしたかを一行で日本語で書く。句点は不要。

## コミットメッセージの例

- `feat(input): HID/WDA を切り替える入力バックエンドを追加`
- `feat(native): simhid-server の JSON Lines サイドカーを追加`
- `feat(webview): pointer イベントを即時 touchDown/Move/Up に変換`
- `feat(capture): MJPEG を webview 直結するプロキシを追加`
- `fix(wda): ロングプレスが tap に退行しないよう gesture を維持`
- `test(sidecar): JSON Lines 往復とバックエンド選択を検証`
- `docs: HID 注入のプロトコル設計を追加`
- `chore(build): simhid-server の native ビルドスクリプトを追加`

## 注意

- 1 コミット＝1 つの論理的な変更単位にする。
- **レビュー不合格・テスト失敗のままコミットしない。**
- 実行前にグループ分け案を提示し、問題なければ `git add` と `git commit` を順に実行する。
- コミット後に `git status` で残りがないことを確認する（意図的に残したファイルは明記する）。
