// ステータスバー／フッターの表示文字列を検証する。
// renderStatus は vscode に触らない純粋関数なので、ここだけをテストする。
require('./helpers/vscode-stub').install();

const {
  renderStatus,
  DEFAULT_STATUS_STRINGS,
} = require('../out/ui/DeviceStatusBar');

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
check('フッターは既定（英語）のラベル', hid.mode === 'Fast mode (HID)', hid.mode);

const wda = renderStatus({state: 'connected', name: 'Pixel 8', backend: 'wda'});
check('WDA を表示', wda.text.includes('WDA'), wda.text);
check('フッターは互換モード', wda.mode === 'Compatible mode (WDA)', wda.mode);
check(
  '降格の理由がツールチップに出る',
  wda.tooltip.includes('demoted'),
  wda.tooltip
);

console.log('\n4) HID と WDA で表示が変わる（降格に気づける）');
check('text が異なる', hid.text !== wda.text);
check('mode が異なる', hid.mode !== wda.mode);

console.log('\n5) 文言は外から差し替えられる（vscode に触らないまま翻訳する）');
const ja = {
  ...DEFAULT_STATUS_STRINGS,
  hid: '高速モード (HID)',
  connected: 'Secondary Simulator: {0} に接続中（{1}）',
  hidDetail: 'タッチとキーを HID で直接注入している。',
};
const jaHid = renderStatus(
  {state: 'connected', name: 'iPhone 15', backend: 'hid'},
  ja
);
check('フッターのラベルが差し替わる', jaHid.mode === '高速モード (HID)', jaHid.mode);
check(
  'ツールチップの {0} {1} が埋まる',
  jaHid.tooltip.startsWith(
    'Secondary Simulator: iPhone 15 に接続中（高速モード (HID)）'
  ),
  jaHid.tooltip
);
check(
  '差し替えても text は言語に依らない（アイコンと経路名）',
  jaHid.text === hid.text,
  jaHid.text
);
// 既定を渡さなくても壊れない（引数なしの呼び出しが残っていてもよい）
check('引数なしなら既定の英語', renderStatus({state: 'disconnected'}).text === null);

console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
process.exit(failures === 0 ? 0 : 1);
