// README.md と README_JP.md のずれを落とす。
//
// 2 つの README は同じ内容を 2 言語で持っており、**片方だけ古くなっても誰も
// 気づけない**（docs/project-review.md §6 で「二重管理」として挙がっている）。
// 全文の同期は機械では見られないが、**構造と、書かれているべき設定の名前**なら
// 突き合わせられる。CHANGELOG を `test/changelog.test.js` で縛っているのと同じ発想。
//
// 見るのは 3 つ:
//   1. 見出しの階層が同じ並びであること（節の追加・削除の片側漏れ）
//   2. package.json の設定が両方に載っていること（設定を足して書き忘れる経路）
//   3. 存在しない設定が残っていないこと（消した・改名した設定の書き残し）
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = ['README.md', 'README_JP.md'];

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** 見出しの深さを出現順に並べる（文言は言語で違うので深さだけを見る）。 */
const headingLevels = (src) =>
  [...src.matchAll(/^(#+)\s/gm)].map((m) => m[1].length);

/** 本文に出てくる `secondarySimulator.*` の設定名。 */
const mentionedSettings = (src) =>
  new Set(
    [...src.matchAll(/secondarySimulator\.([A-Za-z]+)/g)].map(
      (m) => `secondarySimulator.${m[1]}`
    )
  );

const sources = Object.fromEntries(FILES.map((f) => [f, read(f)]));
const pkg = JSON.parse(read('package.json'));
const settings = Object.keys(pkg.contributes.configuration.properties);

console.log('1) 見出しの構造が揃っている');
{
  const [a, b] = FILES.map((f) => headingLevels(sources[f]));
  check(
    '見出しの数が同じ',
    a.length === b.length,
    `${FILES[0]}=${a.length} / ${FILES[1]}=${b.length}`
  );
  check(
    '見出しの深さの並びが同じ',
    a.join(',') === b.join(','),
    `${a.join(',')}\n     ${b.join(',')}`
  );
}

console.log('\n2) 設定が両方に載っている');
for (const file of FILES) {
  const mentioned = mentionedSettings(sources[file]);
  const missing = settings.filter((k) => !mentioned.has(k));
  check(`${file} に漏れが無い`, missing.length === 0, missing.join(', '));
}

console.log('\n3) 存在しない設定が書き残されていない');
for (const file of FILES) {
  const stale = [...mentionedSettings(sources[file])].filter(
    (k) => !settings.includes(k)
  );
  check(`${file} に古い設定が無い`, stale.length === 0, stale.join(', '));
}

console.log('\n4) 相互に行き来できる');
check(
  'README.md から日本語版へ',
  sources['README.md'].includes('README_JP.md'),
  'リンクが無い'
);
check(
  'README_JP.md から英語版へ',
  sources['README_JP.md'].includes('README.md'),
  'リンクが無い'
);

console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
process.exit(failures === 0 ? 0 : 1);
