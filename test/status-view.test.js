// ステータスバー／フッターの表示文字列を検証する。
// renderStatus は vscode に触らない純粋関数なので、ここだけをテストする。
require('./helpers/vscode-stub').install();

const {renderStatus} = require('../out/ui/DeviceStatusBar');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

console.log('1) 未接続では何も出さない');
const off = renderStatus({state: 'disconnected'});
check('ステータスバーを隠す', off.text === null, String(off.text));
check('フッターにも出さない', off.mode === null, String(off.mode));

console.log('\n2) 接続中はスピナー付き');
const connecting = renderStatus({state: 'connecting', name: 'iPhone 15'});
check('スピナーを出す', connecting.text.includes('$(sync~spin)'), connecting.text);
check('デバイス名が入る', connecting.text.includes('iPhone 15'), connecting.text);
check(
  'フッターには経路を出さない（まだ確定していない）',
  connecting.mode === null,
  String(connecting.mode)
);

console.log('\n3) 接続後は経路が分かる');
const hid = renderStatus({state: 'connected', name: 'iPhone 15', backend: 'hid'});
check('HID を表示', hid.text.includes('HID'), hid.text);
check('デバイス名が入る', hid.text.includes('iPhone 15'), hid.text);
check('フッターは日本語ラベル', hid.mode === '高速モード (HID)', hid.mode);

const wda = renderStatus({state: 'connected', name: 'Pixel 8', backend: 'wda'});
check('WDA を表示', wda.text.includes('WDA'), wda.text);
check('フッターは互換モード', wda.mode === '互換モード (WDA)', wda.mode);
check(
  '降格の理由がツールチップに出る',
  wda.tooltip.includes('降格'),
  wda.tooltip
);

console.log('\n4) HID と WDA で表示が変わる（降格に気づける）');
check('text が異なる', hid.text !== wda.text);
check('mode が異なる', hid.mode !== wda.mode);

console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
process.exit(failures === 0 ? 0 : 1);
