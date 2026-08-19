// device.io.orientation.get の応答解釈と、録画ファイル名の既定値を検証する。
//
// 送る側の値（portrait / landscape の小文字）は mobilecli の検証メッセージ
// "invalid orientation value '%s', must be 'portrait' or 'landscape'" で確定しているが、
// **返ってくる形は版に依存する**。ここで受け口の広さを固定する。
require('./helpers/vscode-stub').install();

const {
  decodeOrientation,
  flipOrientation,
  defaultRecordingName,
} = require('../out/simulator/Orientation');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

console.log('1) 生の文字列');
check('portrait', decodeOrientation('portrait') === 'portrait');
check('landscape', decodeOrientation('landscape') === 'landscape');
check('大文字も受ける', decodeOrientation('PORTRAIT') === 'portrait');
check('前後の空白を落とす', decodeOrientation('  LANDSCAPE\n') === 'landscape');

console.log('\n2) 派生した表記は素の向きへ畳む');
// 端末側からは PORTRAIT_UPSIDEDOWN / LANDSCAPE_LEFT のような値も返りうる
check('PORTRAIT_UPSIDEDOWN', decodeOrientation('PORTRAIT_UPSIDEDOWN') === 'portrait');
check('landscape_left', decodeOrientation('landscape_left') === 'landscape');

console.log('\n3) オブジェクトの形');
check('{orientation}', decodeOrientation({orientation: 'landscape'}) === 'landscape');
check('{value}', decodeOrientation({value: 'portrait'}) === 'portrait');
check('{result}', decodeOrientation({result: 'landscape'}) === 'landscape');
check('{data: "..."}', decodeOrientation({data: 'portrait'}) === 'portrait');
check(
  '一段深い {data:{orientation}}',
  decodeOrientation({data: {orientation: 'landscape'}}) === 'landscape'
);
check(
  '{device:{orientation}}',
  decodeOrientation({device: {orientation: 'portrait'}}) === 'portrait'
);

console.log('\n4) 読めないものは null（例外を投げない・縦と決めつけない）');
// 分からないのに portrait を返すと、トグルが逆へ回って「押しても戻る」になる
for (const bad of [null, undefined, '', 'sideways', 42, [], {}, {orientation: 7}]) {
  check(`${JSON.stringify(bad)} → null`, decodeOrientation(bad) === null);
}

console.log('\n5) 反転');
check('portrait → landscape', flipOrientation('portrait') === 'landscape');
check('landscape → portrait', flipOrientation('landscape') === 'portrait');

console.log('\n6) 既定の録画ファイル名');
const at = new Date(2026, 7, 19, 9, 5, 3); // 2026-08-19 09:05:03
check(
  '端末名と時刻から作る',
  defaultRecordingName('iPhone 17', at) === 'iPhone_17-20260819-090503.mp4',
  defaultRecordingName('iPhone 17', at)
);
check(
  'ファイル名に使えない文字を潰す',
  defaultRecordingName('iPad Pro (M4) / 13"', at) ===
    'iPad_Pro_M4_13-20260819-090503.mp4',
  defaultRecordingName('iPad Pro (M4) / 13"', at)
);
check(
  '名前が空でも作れる',
  defaultRecordingName('', at) === 'device-20260819-090503.mp4',
  defaultRecordingName('', at)
);

console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
process.exit(failures === 0 ? 0 : 1);
