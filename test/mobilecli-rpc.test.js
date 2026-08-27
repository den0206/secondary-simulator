// `MobileCliClient` が使う RPC 名とパラメータ名が、**同梱している mobilecli の
// バイナリに実在する**ことを見る。
//
// この拡張のデバイス操作は全て JSON-RPC の文字列でできている。名前が変わっても
// TypeScript は何も言わないし、単体テストも通る —— 気づくのは実機で「効かない」と
// 言われたときになる。実際に 0.0.x → 0.1.x で `devices` が `devices.list` へ変わり、
// その痕跡が `MobileCliServer.isRpcCompatible`（版を見分けるための呼び出し）として
// 残っている。
//
// Dependabot が mobilecli の版上げ PR を出す運用なので、**上げた PR がここで落ちる**
// ことが唯一の自動検知になる。バイナリのシンボル表と突き合わせるだけなので、
// 実デバイスも起動中のサーバも要らない。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

/**
 * 同梱バイナリを 1 つ選ぶ。どのプラットフォーム向けでも RPC 名は同じ
 * （Go の同じソースから吐いている）ので、動く必要は無く読めればよい。
 */
function findBinary() {
  const dir = path.join(ROOT, 'node_modules', 'mobilecli', 'bin');
  if (!fs.existsSync(dir)) return null;
  const entries = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('mobilecli-'))
    .sort();
  return entries.length ? path.join(dir, entries[0]) : null;
}

const binary = findBinary();
if (!binary) {
  // npm install 前など。ここで落とすと「入れていないから赤い」になるだけなので、
  // 見送ったことを明示して終わる（CI は npm ci の後に走るので必ず読める）。
  console.log('mobilecli の同梱バイナリが無いので検査を見送る');
  process.exit(0);
}

const blob = fs.readFileSync(binary).toString('latin1');
console.log(`対象: ${path.basename(binary)}（${Math.round(blob.length / 1e6)}MB）`);

/** `MobileCliClient` が投げる RPC。名前を変えたらここも直す。 */
const METHODS = [
  'devices.list',
  'device.info',
  'device.boot',
  'device.url',
  'device.screenshot',
  'device.screenrecord',
  'device.screenrecord.stop',
  'device.io.tap',
  'device.io.gesture',
  'device.io.text',
  'device.io.button',
];

/**
 * 送っているパラメータのキー。**Go の構造体タグ（`json:"…"`）として探す** —
 * `text` や `url` のような短い語は、どんな Go バイナリにも必ず出てくるので、
 * 素の文字列で照合しても何も確かめたことにならない。
 * 末尾は開いたまま比べる（`json:"includeOffline,omitempty"` のような形があるため）。
 */
const PARAM_KEYS = [
  'deviceId',
  'includeOffline',
  'format',
  'output',
  'url',
  'text',
  'button',
  'actions',
];

/** `device.io.button` に渡すボタン名。Android の DPAD は矢印キーで使う。 */
const BUTTONS = [
  'HOME',
  'BACK',
  'POWER',
  'DPAD_UP',
  'DPAD_DOWN',
  'DPAD_LEFT',
  'DPAD_RIGHT',
];

console.log('\n1) RPC 名がバイナリに実在する');
for (const method of METHODS) {
  check(method, blob.includes(method));
}

console.log('\n2) ソースと突き合わせる（載せ忘れ・消し忘れを落とす）');
{
  const src = fs.readFileSync(
    path.join(ROOT, 'src/utils/MobileCliClient.ts'),
    'utf8'
  );
  const used = [
    ...src.matchAll(/sendJsonRpcRequest(?:<[^>]*>)?\(\s*'([^']+)'/g),
  ].map((m) => m[1]);
  const unique = [...new Set(used)];
  check(
    '実装が投げる RPC は全てこの表にある',
    unique.every((m) => METHODS.includes(m)),
    unique.filter((m) => !METHODS.includes(m)).join(', ')
  );
  check(
    '表に使われていない RPC が残っていない',
    METHODS.every((m) => unique.includes(m)),
    METHODS.filter((m) => !unique.includes(m)).join(', ')
  );
}

console.log('\n3) パラメータ名が構造体タグとして実在する');
for (const key of PARAM_KEYS) {
  check(`json:"${key}"`, blob.includes(`json:"${key}`));
}

console.log('\n4) ボタン名が実在する');
// Android は KEYCODE_*、iOS は WDA 側の名前になるので、どちらかで引ければよい
for (const button of BUTTONS) {
  check(button, blob.includes(`KEYCODE_${button}`) || blob.includes(`"${button}"`));
}

console.log('\n4b) 照合が空振りしていない（表そのものの見張り）');
// 実在しない名前が通ってしまうなら、上の ✅ は何も確かめていない
check('存在しない RPC は落ちる', !blob.includes('device.io.nonexistent'));
check('存在しないタグは落ちる', !blob.includes('json:"notAParam"'));

console.log('\n5) 版が package.json の pin と一致する');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const installed = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, 'node_modules/mobilecli/package.json'),
      'utf8'
    )
  );
  check(
    `${pkg.dependencies.mobilecli} が入っている`,
    installed.version === pkg.dependencies.mobilecli,
    `入っているのは ${installed.version}`
  );
}

console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
process.exit(failures === 0 ? 0 : 1);
