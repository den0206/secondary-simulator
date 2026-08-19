// 録画ファイル名の既定値を検証する。
const {defaultRecordingName} = require('../out/simulator/RecordingName');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

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
