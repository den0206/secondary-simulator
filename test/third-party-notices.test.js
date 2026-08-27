// 同梱する mobilecli の版と THIRD-PARTY-NOTICES.md が揃っているかを見る。
//
// mobilecli は FSL-1.1-ALv2（ソース公開型）で、再配布には全文と著作権表示、
// 対応ソースの同梱が要る。Dependabot が版上げの PR を出すようになったので、
// **通知ファイルだけ古い版のまま VSIX に入る**経路ができた。ここが落ちれば
// bot の PR も CI で止まる。
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

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

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const notices = fs.readFileSync(path.join(root, 'THIRD-PARTY-NOTICES.md'), 'utf8');

console.log('同梱物の通知');

const spec = pkg.dependencies?.mobilecli;

check('mobilecli は版を完全固定している', () => {
  assert.ok(spec, 'package.json の dependencies に mobilecli が無い');
  assert.match(spec, /^\d+\.\d+\.\d+$/, `範囲指定になっている: ${spec}`);
});

check('通知ファイルの版が package.json と一致する', () => {
  const m = notices.match(/\*\*Version bundled\*\*:\s*(\S+)/);
  assert.ok(m, '"**Version bundled**:" の行が無い');
  assert.strictEqual(m[1], spec);
});

check('対応ソースの revision が載っている', () => {
  assert.match(
    notices,
    /\*\*Corresponding Source\*\*:.*\/tree\/[0-9a-f]{40}/,
    'Corresponding Source が 40 桁の SHA を指していない'
  );
});

check('ライセンス全文が入っている', () => {
  assert.ok(
    notices.includes('Functional Source License, Version 1.1, ALv2 Future License'),
    'FSL の表題が無い'
  );
  // リンクだけで済ませない（Redistribution 条項は全文かリンクだが、
  // VSIX はオフラインで読まれるので全文を運ぶ）。
  assert.ok(notices.includes('Grant of Future License'), '全文の末尾条項が無い');
});

check('npx フォールバックの版が package.json の pin と一致する', () => {
  // 同梱バイナリが使えないときは `npx -y mobilecli@X` で実行する。版を固定するのは
  // 「利用者のマシンで未検証のコードを走らせない」ためなので、最後の砦だけ古い版に
  // 貼り付いていると目的から外れる（実際に 1.0.2 のまま取り残されていた）。
  const src = fs.readFileSync(
    path.join(root, 'src/utils/MobileCliServer.ts'),
    'utf8'
  );
  const m = src.match(/FALLBACK_MOBILECLI_VERSION\s*=\s*'([^']+)'/);
  assert.ok(m, 'FALLBACK_MOBILECLI_VERSION が無い');
  assert.strictEqual(m[1], spec);
  // 版が直接埋め込まれた npx 指定が他に残っていないこと
  assert.ok(
    !/'mobilecli@\d/.test(src),
    'mobilecli@X.Y.Z を直接書いている箇所が残っている'
  );
});

check('.vscodeignore が通知ファイルを VSIX に入れている', () => {
  const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
  assert.match(ignore, /^!THIRD-PARTY-NOTICES\.md$/m);
});

if (failures > 0) {
  console.log(`\n${failures} 件失敗`);
  process.exit(1);
}
console.log('\n全て成功');
