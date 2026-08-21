// CHANGELOG のバージョン切り出しを検証する。
//
// 公開ページ（Marketplace / Open VSX）が出すのは **VSIX 内の CHANGELOG.md** なので、
// 切り出しに失敗すると利用者からは「全部 Unreleased」に見える。手作業に頼らないよう
// スクリプト化してあり、ここではその振る舞いと、いま入っている CHANGELOG の形を見る。
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {cutRelease} = require('../scripts/release-changelog.js');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
  } catch (e) {
    console.log(`  ❌ ${name} — ${e.message}`);
    failures++;
  }
}

const SAMPLE = `# Changelog

## [Unreleased]

### 追加

- 新機能

## [0.1.1] — 2026-08-18

### 修正

- 何か

[Unreleased]: https://example.com/o/r/compare/Ver_0.1.1...HEAD
[0.1.1]: https://example.com/o/r/compare/Ver_0.1.0...Ver_0.1.1
`;

console.log('1) [Unreleased] をバージョンへ切り出す');

check('見出しが日付付きで入る', () => {
  const {changed, text} = cutRelease(SAMPLE, '0.2.0', '2026-09-01');
  assert.strictEqual(changed, true);
  assert.match(text, /^## \[0\.2\.0\] — 2026-09-01$/m);
});

check('中身が新しい見出しの下へ移る', () => {
  const {text} = cutRelease(SAMPLE, '0.2.0', '2026-09-01');
  const idx = text.indexOf('## [0.2.0]');
  const item = text.indexOf('- 新機能');
  const older = text.indexOf('## [0.1.1]');
  assert.ok(idx < item && item < older, `順序が違う: ${idx} ${item} ${older}`);
});

check('[Unreleased] は残り、空になる', () => {
  const {text} = cutRelease(SAMPLE, '0.2.0', '2026-09-01');
  const between = text.slice(
    text.indexOf('## [Unreleased]') + '## [Unreleased]'.length,
    text.indexOf('## [0.2.0]')
  );
  assert.strictEqual(between.trim(), '', JSON.stringify(between));
});

check('過去のリリースを壊さない', () => {
  const {text} = cutRelease(SAMPLE, '0.2.0', '2026-09-01');
  assert.match(text, /## \[0\.1\.1\] — 2026-08-18/);
  assert.match(text, /- 何か/);
});

check('比較リンクを張り替える', () => {
  const {text} = cutRelease(SAMPLE, '0.2.0', '2026-09-01');
  assert.match(
    text,
    /^\[Unreleased\]: https:\/\/example\.com\/o\/r\/compare\/Ver_0\.2\.0\.\.\.HEAD$/m
  );
  assert.match(
    text,
    /^\[0\.2\.0\]: https:\/\/example\.com\/o\/r\/compare\/Ver_0\.1\.1\.\.\.Ver_0\.2\.0$/m
  );
});

console.log('\n2) 何度呼んでも安全（+N 再ビルド）');

check('同じバージョンを 2 度切っても増えない', () => {
  const once = cutRelease(SAMPLE, '0.2.0', '2026-09-01');
  const twice = cutRelease(once.text, '0.2.0', '2026-09-02');
  assert.strictEqual(twice.changed, false, twice.reason);
  assert.strictEqual(twice.text, once.text);
  assert.strictEqual((once.text.match(/## \[0\.2\.0\]/g) || []).length, 1);
});

check('項目が無ければ空の見出しを作らない', () => {
  const empty = '# Changelog\n\n## [Unreleased]\n\n## [0.1.1] — 2026-08-18\n\n- 何か\n';
  const r = cutRelease(empty, '0.2.0', '2026-09-01');
  assert.strictEqual(r.changed, false, r.reason);
  assert.match(r.reason, /項目が無い/);
});

console.log('\n3) 入力が壊れていたら止まる');

check('[Unreleased] が無ければ例外', () => {
  assert.throws(() => cutRelease('# Changelog\n', '0.2.0', '2026-09-01'), /Unreleased/);
});

check('バージョン形式を検査する', () => {
  assert.throws(() => cutRelease(SAMPLE, 'v0.2', '2026-09-01'), /X\.Y\.Z/);
});

check('日付形式を検査する', () => {
  assert.throws(() => cutRelease(SAMPLE, '0.2.0', '2026/09/01'), /YYYY-MM-DD/);
});

check('リンク定義が無くても壊れない', () => {
  const noLinks = '# Changelog\n\n## [Unreleased]\n\n- 何か\n';
  const r = cutRelease(noLinks, '0.2.0', '2026-09-01');
  assert.strictEqual(r.changed, true);
  assert.match(r.text, /## \[0\.2\.0\] — 2026-09-01/);
});

console.log('\n4) いま入っている CHANGELOG の形');

const actual = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
const headings = actual
  .split('\n')
  .filter((l) => l.startsWith('## '))
  .map((l) => l.trim());

check('先頭の見出しは [Unreleased]', () => {
  assert.strictEqual(headings[0], '## [Unreleased]');
});

check('リリース済みの見出しは日付を持つ', () => {
  const released = headings.slice(1);
  assert.ok(released.length >= 3, `見出しが少ない: ${released.length}`);
  for (const h of released) {
    assert.match(h, /^## \[\d+\.\d+\.\d+\] — \d{4}-\d{2}-\d{2}$/, h);
  }
});

check('新しい順に並んでいる', () => {
  const versions = headings
    .slice(1)
    .map((h) => /\[(\d+\.\d+\.\d+)\]/.exec(h)[1])
    .map((v) => v.split('.').map(Number));
  for (let i = 1; i < versions.length; i++) {
    const [a, b] = [versions[i - 1], versions[i]];
    const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    assert.ok(cmp > 0, `${a.join('.')} の次に ${b.join('.')} が来ている`);
  }
});

check('公開中の版が載っている（package.json の version）', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
  );
  assert.ok(
    headings.some((h) => h.includes(`[${pkg.version}]`)),
    `${pkg.version} の見出しが無い`
  );
});

// 公開ページは全世界から読まれる。日本語が混ざると、その節だけ読めない人が出る。
// 原文（英語）で書く運用を機械的に守る（コミットメッセージは日本語のままでよい）。
check('日本語が混ざっていない（英語で書く）', () => {
  const lines = actual.split('\n');
  const bad = [];
  lines.forEach((line, i) => {
    // ひらがな・カタカナ・漢字。半角カナや全角括弧までは見ない（誤検知を避ける）
    const m = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]/.exec(line);
    if (m) bad.push(`${i + 1}行目: ${line.trim().slice(0, 40)}`);
  });
  assert.strictEqual(bad.length, 0, `\n  ${bad.slice(0, 5).join('\n  ')}`);
});

check('節の見出しは Keep a Changelog の英語表記', () => {
  const known = new Set([
    'Added',
    'Changed',
    'Deprecated',
    'Removed',
    'Fixed',
    'Security',
  ]);
  const sections = actual
    .split('\n')
    .filter((l) => l.startsWith('### '))
    .map((l) => l.slice(4).trim());
  const unknown = [...new Set(sections)].filter((s) => !known.has(s));
  assert.strictEqual(unknown.length, 0, unknown.join(', '));
});

check('バージョン見出しが重複していない', () => {
  const seen = new Set();
  for (const h of headings.slice(1)) {
    const v = /\[(\d+\.\d+\.\d+)\]/.exec(h)[1];
    assert.ok(!seen.has(v), `${v} が重複`);
    seen.add(v);
  }
});

console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
process.exit(failures === 0 ? 0 : 1);
