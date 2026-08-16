// MjpegProxy のアクセス制御とライフサイクルを、実際に listen させて検証する。
// 上流（mobilecli）は立てないので、通る経路は 502 まで到達すれば「通った」とみなす。
const assert = require('node:assert');
const http = require('node:http');
require('./helpers/vscode-stub').install();
const {MjpegProxy} = require('../out/capture/MjpegProxy');

let failures = 0;
function check(name, ok, extra) {
  if (ok) {
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({host: '127.0.0.1', port, path}, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
  });
}

(async () => {
  // 上流は使わないので、繋がらないポートを指定して 502 に倒す
  const proxy = new MjpegProxy(1);
  const port = await proxy.start(12730);

  console.log('\n1) トークンによるアクセス制御');
  {
    const url = proxy.streamUrl('UDID-1');
    check('streamUrl が listen 中のポートを指す', url.includes(`:${port}/stream`));
    check('streamUrl が device を含む', url.includes('device=UDID-1'));
    const token = new URL(url).searchParams.get('t');
    check('streamUrl がトークンを含む', !!token && token.length >= 32);

    check(
      'トークン無しは 404',
      (await get(port, '/stream?device=UDID-1')) === 404
    );
    check(
      '誤ったトークンは 404',
      (await get(port, '/stream?device=UDID-1&t=deadbeef')) === 404
    );
    check(
      '長さ違いのトークンでも落ちずに 404',
      (await get(port, `/stream?device=UDID-1&t=${token}xx`)) === 404
    );
    check(
      '別経路は 404',
      (await get(port, `/../etc/passwd?t=${token}`)) === 404
    );

    // 正しいトークンなら上流接続まで進む（上流が死んでいるので 502）
    const okStatus = await get(port, `/stream?device=UDID-1&t=${token}`);
    check('正しいトークンは上流へ進む（502）', okStatus === 502, `status=${okStatus}`);

    check(
      'device 欠落は 400',
      (await get(port, `/stream?t=${token}`)) === 400
    );
  }

  console.log('\n2) トークンはインスタンス毎に変わる');
  {
    const other = new MjpegProxy(1);
    const p2 = await other.start(12760);
    const t1 = new URL(proxy.streamUrl('x')).searchParams.get('t');
    const t2 = new URL(other.streamUrl('x')).searchParams.get('t');
    check('別インスタンスは別トークン', t1 !== t2);
    check('他インスタンスのトークンは通らない', (await get(p2, `/stream?device=x&t=${t1}`)) === 404);
    other.dispose();
  }

  console.log('\n3) dispose でポートが解放される');
  {
    proxy.dispose();
    check('isRunning が false', proxy.isRunning() === false);
    // 同じポートで listen し直せる = ソケットが残っていない
    const again = new MjpegProxy(1);
    const reused = await again.start(12730, 1);
    check('同じポートを再取得できる', reused === 12730, `got ${reused}`);
    again.dispose();
  }

  assert.strictEqual(failures, 0, `${failures} 件のテストが失敗`);
  console.log('\n全て成功');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
