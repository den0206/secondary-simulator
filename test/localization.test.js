// ローカリゼーションの取りこぼしを防ぐ。
//
// 文言を足したときに翻訳を忘れると、その言語だけ静かに英語へ戻る（エラーにならない）。
// ここでソースの原文とバンドルを突き合わせ、**過不足の両方**を落とす。
//
// 対象は 2 系統ある。
//   - package.json の貢献点 → `%key%` と package.nls*.json
//   - 実行時の文言          → vscode.l10n.t('原文') と l10n/bundle.l10n.*.json
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
/** 英語は原文がそのまま出るのでバンドルを持たない。追加する言語はここへ足す。 */
const LOCALES = ['ja', 'zh-cn'];

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const diff = (a, b) => a.filter((x) => !b.includes(x));

/** ソースから `vscode.l10n.t('...')` の第 1 引数を集める。 */
function collectRuntimeKeys(dir) {
  const keys = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      keys.push(...collectRuntimeKeys(p));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    const src = fs.readFileSync(p, 'utf8');
    const call = /vscode\.l10n\.t\(\s*'/g;
    let m;
    while ((m = call.exec(src))) {
      // 単一引用符の文字列を、エスケープを見ながら読み切る
      let i = call.lastIndex;
      let out = '';
      for (; i < src.length; i++) {
        if (src[i] === '\\') {
          out += src[i + 1] === "'" ? "'" : src[i] + src[i + 1];
          i++;
          continue;
        }
        if (src[i] === "'") break;
        out += src[i];
      }
      keys.push(out);
    }
  }
  return keys;
}

/** `{0}` などのプレースホルダを昇順で返す。 */
const placeholders = (text) =>
  [...String(text).matchAll(/\{(\d)\}/g)].map((m) => m[1]).sort();

console.log('1) package.json の貢献点');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const used = [...JSON.stringify(pkg).matchAll(/%([\w.-]+)%/g)].map((m) => m[1]);
  const uniqueUsed = [...new Set(used)];
  check('%key% が使われている', uniqueUsed.length > 0, String(uniqueUsed.length));

  const base = readJson(path.join(ROOT, 'package.nls.json'));
  const baseKeys = Object.keys(base);
  check(
    'package.nls.json が全ての %key% を持つ',
    diff(uniqueUsed, baseKeys).length === 0,
    diff(uniqueUsed, baseKeys).join(', ')
  );
  check(
    'package.nls.json に使われていないキーが無い',
    diff(baseKeys, uniqueUsed).length === 0,
    diff(baseKeys, uniqueUsed).join(', ')
  );
  check(
    '英語の値が空でない',
    baseKeys.every((k) => typeof base[k] === 'string' && base[k].length > 0)
  );

  for (const locale of LOCALES) {
    const file = path.join(ROOT, `package.nls.${locale}.json`);
    check(`package.nls.${locale}.json がある`, fs.existsSync(file), file);
    if (!fs.existsSync(file)) continue;
    const loc = readJson(file);
    const locKeys = Object.keys(loc);
    check(
      `${locale}: 翻訳漏れが無い`,
      diff(baseKeys, locKeys).length === 0,
      diff(baseKeys, locKeys).join(', ')
    );
    check(
      `${locale}: 余分なキーが無い`,
      diff(locKeys, baseKeys).length === 0,
      diff(locKeys, baseKeys).join(', ')
    );
    check(
      `${locale}: 値が空でない`,
      locKeys.every((k) => typeof loc[k] === 'string' && loc[k].length > 0)
    );
  }
}

console.log('\n2) 実行時の文言（vscode.l10n）');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('package.json が l10n の場所を宣言している', pkg.l10n === './l10n', String(pkg.l10n));

  const keys = [...new Set(collectRuntimeKeys(path.join(ROOT, 'src')))];
  check('原文を集められた', keys.length > 20, String(keys.length));

  for (const locale of LOCALES) {
    const file = path.join(ROOT, 'l10n', `bundle.l10n.${locale}.json`);
    check(`bundle.l10n.${locale}.json がある`, fs.existsSync(file), file);
    if (!fs.existsSync(file)) continue;
    const bundle = readJson(file);
    const bundleKeys = Object.keys(bundle);
    check(
      `${locale}: 翻訳漏れが無い`,
      diff(keys, bundleKeys).length === 0,
      diff(keys, bundleKeys).join(' | ')
    );
    // 使われていない原文が残ると、原文を直したときに古い訳が生き残る
    check(
      `${locale}: 使われていない原文が無い`,
      diff(bundleKeys, keys).length === 0,
      diff(bundleKeys, keys).join(' | ')
    );
    check(
      `${locale}: 値が空でない`,
      bundleKeys.every((k) => typeof bundle[k] === 'string' && bundle[k].length > 0)
    );
    // {0} を落とすとデバイス名やエラーが消える。数と番号が一致することを見る
    const broken = bundleKeys.filter(
      (k) => placeholders(k).join() !== placeholders(bundle[k]).join()
    );
    check(
      `${locale}: プレースホルダが原文と一致する`,
      broken.length === 0,
      broken.join(' | ')
    );
  }
}

console.log('\n3) webview へ渡す辞書');
{
  require('./helpers/vscode-stub').install();
  const {webviewStrings} = require('../out/utils/Strings');
  const dict = webviewStrings();
  const keys = Object.keys(dict);
  check('辞書が空でない', keys.length > 0, String(keys.length));
  check(
    '値が空でない',
    keys.every((k) => typeof dict[k] === 'string' && dict[k].length > 0)
  );

  // main.js が引くキーと、index.html の data-i18n が指すキーを突き合わせる。
  // 綴り違いは実行時に「キー名がそのまま表示される」形で出るので、ここで止める。
  const mainJs = fs.readFileSync(
    path.join(ROOT, 'media', 'webview', 'main.js'),
    'utf8'
  );
  const html = fs.readFileSync(
    path.join(ROOT, 'media', 'webview', 'index.html'),
    'utf8'
  );
  const used = new Set([
    ...[...mainJs.matchAll(/\bt\('([A-Za-z][\w]*)'/g)].map((m) => m[1]),
    ...[...html.matchAll(/data-i18n(?:-title)?="([\w]+)"/g)].map((m) => m[1]),
  ]);
  const missing = [...used].filter((k) => !keys.includes(k));
  check(
    'webview が引くキーは全て辞書にある',
    missing.length === 0,
    missing.join(', ')
  );

  const unused = keys.filter((k) => !used.has(k));
  check('辞書に使われていないキーが無い', unused.length === 0, unused.join(', '));
}

console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
process.exit(failures === 0 ? 0 : 1);
