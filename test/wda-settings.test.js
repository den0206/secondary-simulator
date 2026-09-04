// WDA の帯域設定の「純粋な部分」を検証する（実機も lsof も要らない）。
//
// この経路は iOS 実機・シミュレータが要るので実行して確かめにくい。
// 少なくとも **lsof の出力の読み方**と**WDA へ渡す値の丸め方**は
// ここで固定しておく（設定しても効かない／WDA へ null を渡す、が無音で起きる）。
require('./helpers/vscode-stub').install();

const {WdaSettings} = require('../out/capture/WdaSettings');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

// 実際の lsof（macOS）の並び。WDA は HTTP と MJPEG の 2 つを開く。
const LSOF = [
  'COMMAND     PID          USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
  'WebDriver 51423 yuuki.sakai   21u  IPv4 0x9f1c2b4a5d6e7f80      0t0  TCP *:8100 (LISTEN)',
  'WebDriver 51423 yuuki.sakai   24u  IPv4 0x9f1c2b4a5d6e7f81      0t0  TCP *:9100 (LISTEN)',
  'node      50011 yuuki.sakai   19u  IPv4 0x9f1c2b4a5d6e7f82      0t0  TCP 127.0.0.1:12099 (LISTEN)',
  'Simulator 49888 yuuki.sakai   12u  IPv4 0x9f1c2b4a5d6e7f83      0t0  TCP *:52301 (LISTEN)',
].join('\n');

console.log('1) lsof の出力から WDA の LISTEN ポートだけを拾う');
const ports = WdaSettings.parseListenPorts(LSOF);
check(
  'WDA の 2 ポートを拾う（HTTP と MJPEG の判別は /status に聞く）',
  JSON.stringify(ports.sort((a, b) => a - b)) === '[8100,9100]',
  JSON.stringify(ports)
);
check(
  '他プロセスのポートは拾わない（mobilecli の 12099 を触らない）',
  !ports.includes(12099) && !ports.includes(52301),
  JSON.stringify(ports)
);
check('見出し行を数値にしない', !ports.some((p) => Number.isNaN(p)));
check('空の出力では何も返さない', WdaSettings.parseListenPorts('').length === 0);
check(
  'LISTEN でない行は拾わない（ESTABLISHED を掴まない）',
  WdaSettings.parseListenPorts(
    'WebDriver 1 u IPv4 0x1 0t0 TCP 127.0.0.1:8100->127.0.0.1:5000 (ESTABLISHED)'
  ).length === 0
);
check(
  '同じポートが複数行に出ても 1 つ',
  WdaSettings.parseListenPorts(
    ['WebDriver 1 u TCP *:8100 (LISTEN)', 'WebDriver 1 u TCP *:8100 (LISTEN)'].join(
      '\n'
    )
  ).length === 1
);

console.log('\n2) WDA へ渡す値へ丸める（scale は % になる）');
const s = (scale, quality) => WdaSettings.clampMjpegSettings(scale, quality);
check(
  '既定（1.0 / 80）はそのまま',
  s(1, 80).mjpegScalingFactor === 100 &&
    s(1, 80).mjpegServerScreenshotQuality === 80,
  JSON.stringify(s(1, 80))
);
check('割合を % に直す', s(0.5, 80).mjpegScalingFactor === 50);
check(
  '上限を超えたら丸める',
  s(2, 500).mjpegScalingFactor === 100 &&
    s(2, 500).mjpegServerScreenshotQuality === 100,
  JSON.stringify(s(2, 500))
);
check(
  '下限を下回ったら丸める（0 を渡して真っ白にしない）',
  s(0, 0).mjpegScalingFactor === 10 &&
    s(0, 0).mjpegServerScreenshotQuality === 1,
  JSON.stringify(s(0, 0))
);
check('負でも下限で止まる', s(-1, -1).mjpegScalingFactor === 10);
check('整数になる（WDA は % を整数で受ける）', Number.isInteger(s(0.333, 80.5).mjpegScalingFactor));
// settings.json は手で書けるので、スキーマの範囲を当てにしない。
// NaN をそのまま渡すと JSON では null になり、無音で効かなくなる
check(
  'NaN は既定へ倒す（WDA へ null を渡さない）',
  s(NaN, NaN).mjpegScalingFactor === 100 &&
    s(NaN, NaN).mjpegServerScreenshotQuality === 100,
  JSON.stringify(s(NaN, NaN))
);
check(
  'JSON にしても null が混ざらない',
  !JSON.stringify(s(NaN, Infinity)).includes('null'),
  JSON.stringify(s(NaN, Infinity))
);

console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
process.exit(failures === 0 ? 0 : 1);
