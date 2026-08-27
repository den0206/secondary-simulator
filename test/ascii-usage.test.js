// ASCII → HID usage の表が、拡張ホストと native で食い違わないことを見る。
//
// 表は 2 か所にある（`src/input/InputBackend.ts` の usageForAsciiChar と
// `native/simhid-server.m` の usageForChar）。二重管理になる理由は
// InputBackend.ts のコメントにあるとおりだが、**ずれると黙って壊れる**:
//
//   - native に無い文字を拡張ホストが「HID で送れる」と判定すると、
//     サイドカーが skip して**その文字だけ落ちる**（`:` を落として
//     `https//example.com` が入る、という気づきにくい壊れ方をしていた）
//   - 逆に拡張ホストの表だけが欠けると、HID で送れるはずの文字が WDA へ回り、
//     使う予定の無かった WebDriverAgent の起動を待つことになる
//
// ここでは「印字可能な ASCII を全て引けること」と「両方の表が一致すること」を落とす。
const fs = require('fs');
const path = require('path');

require('./helpers/vscode-stub').install();

const ROOT = path.join(__dirname, '..');
const {usageForAsciiChar} = require(path.join(ROOT, 'out/input/InputBackend'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

/** native の usageForChar から `文字 → {usage, shift}` を読み出す。 */
function parseNativeTable() {
  const src = fs.readFileSync(
    path.join(ROOT, 'native', 'simhid-server.m'),
    'utf8'
  );
  const start = src.indexOf('static uint8_t usageForChar(');
  if (start < 0) throw new Error('native に usageForChar が無い');
  const end = src.indexOf('\n}', start);
  const body = src.slice(start, end);

  const table = new Map();
  // 範囲で書かれているぶん（a-z / A-Z / 1-9）は表に展開する
  for (let i = 0; i < 26; i++) {
    table.set(String.fromCharCode(97 + i), {usage: 4 + i, shift: false});
    table.set(String.fromCharCode(65 + i), {usage: 4 + i, shift: true});
  }
  for (let i = 0; i < 9; i++) {
    table.set(String(i + 1), {usage: 0x1e + i, shift: false});
  }
  const zero = body.match(/c == '0'\)\s*return\s*(0x[0-9a-f]+)/i);
  if (zero) table.set('0', {usage: parseInt(zero[1], 16), shift: false});

  // switch の case を読む。`case 'X': [*shift = YES;] return 0xNN;`
  const re = /case '((?:\\.|[^'])+)':\s*(\*shift = YES;\s*)?return\s+(0x[0-9a-f]+);/gi;
  let m;
  while ((m = re.exec(body))) {
    const raw = m[1];
    const ch =
      raw === '\\n'
        ? '\n'
        : raw === '\\t'
          ? '\t'
          : raw === '\\\\'
            ? '\\'
            : raw === "\\'"
              ? "'"
              : raw;
    table.set(ch, {usage: parseInt(m[3], 16), shift: Boolean(m[2])});
  }
  return table;
}

const native = parseNativeTable();

console.log('1) 印字可能な ASCII を全て引ける');
{
  const missing = [];
  for (let c = 0x20; c <= 0x7e; c++) {
    const ch = String.fromCharCode(c);
    if (!usageForAsciiChar(ch)) missing.push(ch);
  }
  check(
    '拡張ホストの表に欠けが無い',
    missing.length === 0,
    `引けない: ${missing.join(' ')}`
  );
  const nativeMissing = [];
  for (let c = 0x20; c <= 0x7e; c++) {
    const ch = String.fromCharCode(c);
    if (!native.has(ch)) nativeMissing.push(ch);
  }
  check(
    'native の表にも欠けが無い（あると注入時に黙って落ちる）',
    nativeMissing.length === 0,
    `引けない: ${nativeMissing.join(' ')}`
  );
}

console.log('\n2) 改行とタブも引ける（WDA へ回さない）');
check('\\n', usageForAsciiChar('\n') !== undefined);
check('\\t', usageForAsciiChar('\t') !== undefined);
check('native も同じ', native.has('\n') && native.has('\t'));

console.log('\n3) 2 つの表が一致する');
{
  const mismatch = [];
  for (const [ch, expected] of native) {
    const actual = usageForAsciiChar(ch);
    if (!actual) {
      mismatch.push(`${JSON.stringify(ch)}: 拡張ホスト側に無い`);
      continue;
    }
    if (actual.usage !== expected.usage || actual.shift !== expected.shift) {
      mismatch.push(
        `${JSON.stringify(ch)}: native=0x${expected.usage.toString(16)}/${expected.shift} ` +
          `host=0x${actual.usage.toString(16)}/${actual.shift}`
      );
    }
  }
  check('usage と shift が揃っている', mismatch.length === 0, mismatch.join(', '));
}

console.log('\n4) URL に出る記号が Shift 付きで引ける（落ちていた文字）');
for (const [ch, usage] of [
  [':', 0x33],
  ['?', 0x38],
  ['@', 0x1f],
  ['_', 0x2d],
  ['&', 0x24],
  ['=', 0x2e],
  ['%', 0x22],
  ['#', 0x20],
]) {
  const got = usageForAsciiChar(ch);
  check(
    `${ch} → 0x${usage.toString(16)}`,
    got && got.usage === usage,
    JSON.stringify(got)
  );
}

console.log('\n5) 表に無いものは undefined（非 ASCII は WDA へ回す）');
check('日本語', usageForAsciiChar('あ') === undefined);
check('絵文字（サロゲートペア）', usageForAsciiChar('🙂') === undefined);
check('2 文字以上', usageForAsciiChar('ab') === undefined);
check('制御文字', usageForAsciiChar('') === undefined);

console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
process.exit(failures === 0 ? 0 : 1);
