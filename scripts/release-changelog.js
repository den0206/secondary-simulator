#!/usr/bin/env node
// CHANGELOG.md の `[Unreleased]` をバージョン見出しへ切り出す。
//
//   node scripts/release-changelog.js 0.2.0 [YYYY-MM-DD]
//
// リリース（`release/Ver_X.Y.Z` の push）で release.yml が呼ぶ。**VSIX を作る前に**
// 走らせること — Marketplace / Open VSX が表示するのは VSIX 内の CHANGELOG.md なので、
// 後から main を直しても公開ページは `Unreleased` のままになる。
//
// 何度呼んでも安全（そのバージョンの見出しが既にあれば何もしない）。
// `+N` 再ビルドは同じ X.Y.Z を共有するため、2 回目以降は自然と no-op になる。

const fs = require('fs');
const path = require('path');

const UNRELEASED = '## [Unreleased]';

/** 見出し行（`## [0.1.1] — 2026-08-18` など）からバージョンを取る。 */
function versionOf(line) {
  const m = /^##\s+\[?(\d+\.\d+\.\d+)\]?/.exec(line);
  return m ? m[1] : null;
}

/**
 * `[Unreleased]` の内容を `## [version] — date` へ移す。
 *
 * @returns {{changed: boolean, text: string, reason?: string}}
 *   `changed` が false のときは `text` が入力そのまま（呼び出し側は書き戻さなくてよい）。
 */
function cutRelease(markdown, version, date) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`version が X.Y.Z 形式ではない: ${version}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`date が YYYY-MM-DD 形式ではない: ${date}`);
  }

  const lines = markdown.split('\n');
  const headIndex = lines.findIndex((l) => l.trim() === UNRELEASED);
  if (headIndex < 0) {
    throw new Error(`'${UNRELEASED}' が見つからない`);
  }
  if (lines.some((l) => versionOf(l) === version)) {
    return {changed: false, text: markdown, reason: `${version} は既に切り出し済み`};
  }

  // 次の見出し（= 直前のリリース）まで、あるいはリンク定義／末尾まで
  let end = lines.length;
  let previousVersion = null;
  for (let i = headIndex + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      end = i;
      previousVersion = versionOf(lines[i]);
      break;
    }
    // 末尾のリンク定義（`[Unreleased]: https://…`）より下は本文ではない
    if (/^\[[^\]]+\]:\s+\S+/.test(lines[i])) {
      end = i;
      break;
    }
  }

  const body = lines.slice(headIndex + 1, end);
  if (body.every((l) => l.trim() === '')) {
    // 空の見出しを量産しない。書き忘れに気づけるよう理由を返す
    return {changed: false, text: markdown, reason: '[Unreleased] に項目が無い'};
  }

  const trimmed = [...body];
  while (trimmed.length && trimmed[0].trim() === '') trimmed.shift();
  while (trimmed.length && trimmed[trimmed.length - 1].trim() === '') trimmed.pop();

  const out = [
    ...lines.slice(0, headIndex + 1),
    '',
    `## [${version}] — ${date}`,
    '',
    ...trimmed,
    '',
    ...lines.slice(end),
  ];

  return {changed: true, text: updateLinks(out.join('\n'), version, previousVersion)};
}

/**
 * 末尾の比較リンクを更新する。無ければ何もしない（リンクを持たない書式でも壊さない）。
 * タグは `Ver_X.Y.Z`（release.yml の採番と揃える）。
 */
function updateLinks(markdown, version, previousVersion) {
  const link = /^\[Unreleased\]:\s+(\S+?)\/compare\/\S+$/m.exec(markdown);
  if (!link) return markdown;
  const base = link[1]; // https://github.com/<owner>/<repo>
  const unreleased = `[Unreleased]: ${base}/compare/Ver_${version}...HEAD`;
  const added = previousVersion
    ? `[${version}]: ${base}/compare/Ver_${previousVersion}...Ver_${version}`
    : `[${version}]: ${base}/releases/tag/Ver_${version}`;
  return markdown.replace(link[0], `${unreleased}\n${added}`);
}

module.exports = {cutRelease};

if (require.main === module) {
  const [version, dateArg] = process.argv.slice(2);
  if (!version) {
    console.error('usage: node scripts/release-changelog.js <X.Y.Z> [YYYY-MM-DD]');
    process.exit(2);
  }
  const date = dateArg || new Date().toISOString().slice(0, 10);
  const file = path.join(__dirname, '..', 'CHANGELOG.md');
  const result = cutRelease(fs.readFileSync(file, 'utf8'), version, date);
  if (!result.changed) {
    console.log(`release-changelog: 変更なし（${result.reason}）`);
    process.exit(0);
  }
  fs.writeFileSync(file, result.text);
  console.log(`release-changelog: [Unreleased] を ${version} — ${date} へ切り出した`);
}
