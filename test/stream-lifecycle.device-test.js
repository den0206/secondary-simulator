// 手動修正の検証:
//  (a) pauseStream で <img> の GET が実際に閉じ、サーバ側の接続も切れるか
//  (b) 再度 streamUrl を受けたら復帰するか
//  (c) MjpegCapture の streamGen が stop→start の競合を防ぐか
require('./helpers/vscode-stub').installVerbose();
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..');
const {MjpegProxy} = require(path.join(ROOT, 'out/capture/MjpegProxy'));
const {MjpegCapture} = require(path.join(ROOT, 'out/capture/MjpegCapture'));

const UDID = process.argv[2];
if (!UDID) {
  console.error('使い方: node test/stream-lifecycle.device-test.js <UDID>');
  console.error('起動中のシミュレータと mobilecli(:12099) が必要です');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 初回接続は mobilecli が WDA を起動するまで数秒かかる。固定 sleep だと不安定なので
// 条件が満たされるまでポーリングする。
// **既定を 60 秒にしてあるのは CI の macOS ランナーが遅いから** — 20 秒では
// 温まる前に判定してしまい、切断・復帰ではなく起動の速さを測ることになる。
const waitFor = async (fn, timeoutMs = 60000, stepMs = 250) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (fn()) return true;
    await sleep(stepMs);
  }
  return false;
};
let failures = 0;
const check = (n, c, d) => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && d ? ' — ' + d : ''}`);
  if (!c) failures++;
};

(async () => {
  console.log('(a)(b) 直結ストリームの切断と復帰');
  const proxy = new MjpegProxy(12099);
  await proxy.start(12400);

  // 接続1: <img src=...> 相当。**これが起動待ちも兼ねる。**
  //
  // 別に「ウォームアップ用の接続」を張って捨てると、その破棄が終わる前に次の接続が
  // 来ることになり、mobilecli 側のセッションが競合して**新しい接続にフレームが
  // 流れなくなる**（CI 実測: ウォームアップを挟むと接続1が 60 秒で 2 枚、
  // その接続を捨てたあとの再接続は 8 秒で 10 枚超）。張り直さずに待つ。
  let f1 = 0;
  const r1 = http.get(proxy.streamUrl(UDID), (res) => {
    let tail = '';
    res.on('data', (c) => {
      const s = tail + c.toString('latin1');
      const m = s.match(/--BoundaryString/g);
      if (m) f1 += m.length;
      tail = s.slice(-32);
    });
  });
  r1.on('error', () => {});
  // 枚数の下限が 2 なのは、**この経路が「動いているか」しか見ていない**から。
  // CI の端末は誰も触らないので画面が静止していて、フレームはほとんど流れない
  // （実測で 60 秒に数枚）。ここで fps を要求すると、検証したい切断・復帰ではなく
  // 端末の暇さを測ることになる。
  await waitFor(() => f1 > 2, 180000);
  const framesBefore = f1;
  check('接続1がフレームを受信', framesBefore > 2, `frames=${framesBefore}`);

  // pauseStream 相当: img.src='' → GET を破棄
  r1.destroy();
  await sleep(1200);
  const afterDestroy = f1;
  await sleep(1200);
  check('切断後にフレームが増えない', f1 === afterDestroy, `${afterDestroy} → ${f1}`);

  // 再開: 新しい streamUrl 相当
  let f2 = 0;
  const r2 = http.get(proxy.streamUrl(UDID), (res) => {
    let tail = '';
    res.on('data', (c) => {
      const s = tail + c.toString('latin1');
      const m = s.match(/--BoundaryString/g);
      if (m) f2 += m.length;
      tail = s.slice(-32);
    });
  });
  r2.on('error', () => {});
  await waitFor(() => f2 > 10);
  check('再接続でフレームが再開', f2 > 10, `frames=${f2}`);
  r2.destroy();
  proxy.dispose();

  console.log('\n(c) MjpegCapture: stop→start の連続で二重ストリームにならない');
  const cap = new MjpegCapture(12099);
  cap.setDevice(UDID);
  let frames = 0;
  cap.onFrame(() => frames++);
  await cap.start();
  await waitFor(() => frames > 5);
  const n1 = frames;
  check('start でフレームが来る', n1 > 5, `frames=${n1}`);

  // 素早く stop→start（世代管理が無いと旧ストリームが残り二重になる）
  cap.stop();
  await cap.start();
  await waitFor(() => frames - n1 > 5);
  const n2 = frames - n1;
  check('再 start 後もフレームが来る', n2 > 5, `frames=${n2}`);

  // stop 後はフレームが止まる（再接続タイマも動かない）
  cap.stop();
  const atStop = frames;
  await sleep(1500);
  check('stop 後はフレームが増えない', frames === atStop, `${atStop} → ${frames}`);
  cap.dispose();

  console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
