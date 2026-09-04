// package.json の貢献点と実装のずれを落とす。
//
// **宣言と実装が別のファイルにある**ので、片方だけ直しても型チェックもテストも
// 通ってしまう。実際にこの形の欠陥が 2 つ出ている（docs/project-review.md）:
//
// - §1.3 キーバインドの `when` が `view == simulatorView` で、**宣言されているだけで
//   一度も発火していなかった**（`view` はビュータイトルのメニュー用のキーで、
//   キーバインドの評価時には設定されない）
// - §5.2 `simulator.selectDevice` がビューへフォーカスするだけで、何も選べなかった
//
// どちらも「実行してみるまで分からない」種類なので、静的に突き合わせられる分は
// ここで突き合わせる。文言（`%key%`）の過不足は test/localization.test.js が見る。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const extensionSrc = fs.readFileSync(
  path.join(ROOT, 'src', 'extension.ts'),
  'utf8'
);

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

/** src 以下の .ts を全部読む（設定キーの利用箇所を探すため）。 */
function readAllSources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readAllSources(full));
    else if (entry.name.endsWith('.ts')) out.push(fs.readFileSync(full, 'utf8'));
  }
  return out;
}
const allSources = readAllSources(path.join(ROOT, 'src')).join('\n');

console.log('1) 宣言したコマンドと registerCommand が 1 対 1');
const declared = (pkg.contributes.commands ?? []).map((c) => c.command).sort();
const registered = [
  ...extensionSrc.matchAll(/registerCommand\(\s*'([^']+)'/g),
].map((m) => m[1]).sort();
check('1 つ以上ある（読めている）', declared.length > 0, String(declared.length));
for (const id of declared) {
  check(
    `${id} を registerCommand している`,
    registered.includes(id),
    'package.json にあるがハンドラが無い（コマンドパレットから実行すると失敗する）'
  );
}
for (const id of registered) {
  check(
    `${id} を package.json が宣言している`,
    declared.includes(id),
    'registerCommand はあるが宣言が無い（コマンドパレットに出ない）'
  );
}

console.log('\n2) メニュー・キーバインドが実在するコマンドだけを指す');
const menuCommands = Object.values(pkg.contributes.menus ?? {})
  .flat()
  .map((m) => m.command)
  .filter(Boolean);
for (const id of menuCommands) {
  check(`メニューの ${id} が宣言済み`, declared.includes(id));
}
const keybindings = pkg.contributes.keybindings ?? [];
check('キーバインドがある', keybindings.length > 0);
for (const kb of keybindings) {
  check(`キーバインドの ${kb.command} が宣言済み`, declared.includes(kb.command));
}

// **`view ==` はキーバインドでは効かない。** ビュータイトルのメニュー用の
// コンテキストキーなので、キーバインドの評価時には設定されていない
// （project-review §1.3。宣言されているのに一度も発火しない状態が実際にあった）。
console.log('\n2b) キーバインドの when がビューのフォーカスを見ている');
for (const kb of keybindings) {
  check(
    `${kb.command} の when が focusedView を使う`,
    typeof kb.when === 'string' && /\bfocusedView\s*==/.test(kb.when),
    `when: ${kb.when}`
  );
  check(
    `${kb.command} が view == を使っていない（発火しない）`,
    !/(^|[^d])\bview\s*==/.test(kb.when ?? ''),
    `when: ${kb.when}`
  );
}

console.log('\n3) 宣言した設定が実際に読まれている');
const settings = Object.keys(pkg.contributes.configuration.properties);
for (const key of settings) {
  check(
    `${key} の接頭辞が secondarySimulator`,
    key.startsWith('secondarySimulator.'),
    key
  );
}
const names = settings.map((k) => k.slice('secondarySimulator.'.length));
// 設定の読み出しは必ず型引数を伴う（`get<boolean>('autoConnect', true)`）。
// `URLSearchParams.get('t')` のような同名メソッドと混ざらないよう、そこで見分ける。
const readKeys = new Set(
  [...allSources.matchAll(/\.get<[^>]*>\(\s*'([^']+)'/g)].map((m) => m[1])
);
for (const name of names) {
  check(
    `${name} を読んでいる`,
    readKeys.has(name),
    '宣言だけで参照が無い（設定しても効かない）'
  );
}
for (const key of readKeys) {
  check(
    `読んでいる ${key} が宣言されている`,
    names.includes(key),
    '設定画面に出ないキーを読んでいる（綴り違いの可能性）'
  );
}

console.log('\n4) 起動イベントとビューの宣言');
// デバッグ開始でビューを出す機能は、ビューを開くまで拡張が起きないと
// 「隠れているときに出す」という一番効かせたい場面で効かない
check(
  'onDebug で起動する（autoShow が効くために要る）',
  (pkg.activationEvents ?? []).includes('onDebug'),
  JSON.stringify(pkg.activationEvents)
);
const views = Object.values(pkg.contributes.views ?? {}).flat();
check('webview ビューを 1 つ宣言している', views.length === 1, String(views.length));
check(
  'ビュー ID が実装の viewType と揃っている',
  fs
    .readFileSync(
      path.join(ROOT, 'src', 'webview', 'SimulatorWebviewProvider.ts'),
      'utf8'
    )
    .includes(`viewType = '${views[0].id}'`),
  views[0].id
);
// メニューの when はビュー ID を直接書くので、ずれると項目が出ない
for (const items of Object.values(pkg.contributes.menus ?? {})) {
  for (const item of items) {
    if (typeof item.when !== 'string' || !item.when.includes('view ==')) continue;
    check(
      `メニューの when が実在するビューを指す（${item.command}）`,
      item.when.includes(views[0].id),
      item.when
    );
  }
}

console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
process.exit(failures === 0 ? 0 : 1);
