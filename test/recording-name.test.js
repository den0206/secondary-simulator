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
  defaultRecordingName('iPhone 17', 'mp4', at) === 'iPhone_17-20260819-090503.mp4',
  defaultRecordingName('iPhone 17', 'mp4', at)
);
check(
  'ファイル名に使えない文字を潰す',
  defaultRecordingName('iPad Pro (M4) / 13"', 'mp4', at) ===
    'iPad_Pro_M4_13-20260819-090503.mp4',
  defaultRecordingName('iPad Pro (M4) / 13"', 'mp4', at)
);
check(
  '名前が空でも作れる',
  defaultRecordingName('', 'mp4', at) === 'device-20260819-090503.mp4',
  defaultRecordingName('', 'mp4', at)
);

// ビュー録画は MediaRecorder が通したコンテナ次第。中身と拡張子を食い違わせない。
check(
  '拡張子を指定できる（ビュー録画の webm）',
  defaultRecordingName('Pixel 9', 'webm', at) === 'Pixel_9-20260819-090503.webm',
  defaultRecordingName('Pixel 9', 'webm', at)
);

console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
process.exit(failures === 0 ? 0 : 1);
