// 「増える一方の入れ物を作らない」（CLAUDE.md）の回帰テスト。
//
// 上限のあるバッファ・解放されるタイマー・破棄される参照を、実デバイス無しで検証する。
// 実測が要るもの（拡張ホストの RSS 推移など）はここでは扱わない。
const assert = require('node:assert');
require('./helpers/vscode-stub').install();

const {WdaBackend} = require('../out/input/WdaBackend');
const {MjpegParser} = require('../out/capture/MjpegParser');
const {MjpegCapture} = require('../out/capture/MjpegCapture');
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

/** 生きているタイマーの数（setTimeout / setInterval）。 */
function activeTimers() {
  return process
    .getActiveResourcesInfo()
    .filter((r) => r === 'Timeout' || r === 'Immediate').length;
}

const fakeClient = () => {
  const calls = [];
  return {
    calls,
    tap: async (...a) => calls.push(['tap', ...a]),
    gesture: async (d, actions) => calls.push(['gesture', actions.length]),
    inputText: async () => {},
    pressButton: async () => {},
  };
};

(async () => {
  console.log('\n1) WdaBackend: ドラッグの軌跡が伸び続けない');
  {
    const client = fakeClient();
    const b = new WdaBackend(client, 'dev', () => ({width: 1000, height: 2000}));

    // touchUp が来ないまま 60 秒ぶん（60Hz）の move が届いた場合
    await b.touchDown(0.5, 0.5);
    for (let i = 0; i < 60 * 60; i++) await b.touchMove(0.5, 0.5 + i * 1e-6);
    check(
      `保持点数が上限内（実測 ${b.points.length} 点 / 3600 回の move）`,
      b.points.length <= 240,
      String(b.points.length)
    );

    // さらに 10 倍流しても上限を超えない
    for (let i = 0; i < 36000; i++) await b.touchMove(0.5, 0.6);
    check(
      `10 倍流しても上限内（実測 ${b.points.length} 点）`,
      b.points.length <= 240,
      String(b.points.length)
    );

    // 離したときの RPC ペイロードも上限内
    await b.touchUp(0.9, 0.9);
    const gesture = client.calls.find((c) => c[0] === 'gesture');
    check(
      `1 回の gesture の action 数が上限内（実測 ${gesture?.[1]}）`,
      gesture && gesture[1] <= 250,
      String(gesture?.[1])
    );
    check('touchUp 後に軌跡が空になる', b.points.length === 0);

    // 間引いても始点と終点は保たれる（ドラッグの向きが壊れない）
    const c2 = fakeClient();
    const b2 = new WdaBackend(c2, 'dev', () => ({width: 1000, height: 1000}));
    await b2.touchDown(0.0, 0.0);
    for (let i = 1; i <= 2000; i++) await b2.touchMove(i / 2000, i / 2000);
    await b2.touchUp(1.0, 1.0);
    const g = c2.calls.find((c) => c[0] === 'gesture');
    check('長距離ドラッグが gesture として送られる', !!g, JSON.stringify(c2.calls));

    b2.dispose();
    check('dispose で軌跡が解放される', b2.points.length === 0);
  }

  console.log('\n2) MjpegParser: 入力が壊れてもバッファが伸びない');
  {
    // バウンダリの来ないゴミを 20MB 流す
    const p = new MjpegParser('--BoundaryString');
    for (let i = 0; i < 5000; i++) p.push(Buffer.alloc(4096, 0x41));
    check(
      `ゴミ 20MB 投入後の保持が boundary 長未満（実測 ${p.bufferedBytes}B）`,
      p.bufferedBytes < 16
    );

    // ヘッダ途中で止まったまま放置されても、1 パート分を超えない
    const p2 = new MjpegParser('--BoundaryString', {maxPartSize: 1024});
    p2.push(Buffer.from('--BoundaryString\r\nContent-Type: image/jpeg\r\n', 'latin1'));
    const held = p2.bufferedBytes;
    check(`ヘッダ待ちの保持が小さい（実測 ${held}B）`, held < 4096);
    p2.reset();
    check('reset で解放される', p2.bufferedBytes === 0);
  }

  console.log('\n3) MjpegCapture: タイマーを残さない');
  {
    const before = activeTimers();
    const caps = [];
    for (let i = 0; i < 20; i++) {
      const c = new MjpegCapture(1); // 繋がらないポート
      c.setDevice(`dev-${i}`);
      c.onFrame(() => {});
      // start は接続に失敗するが、再接続タイマーが予約される
      await c.start().catch(() => {});
      caps.push(c);
    }
    const during = activeTimers();
    for (const c of caps) c.dispose();
    // 解放が反映されるまで 1 tick 待つ
    await new Promise((r) => setImmediate(r));
    const after = activeTimers();
    check(
      `20 個 dispose 後にタイマーが残らない（前 ${before} / 最大 ${during} / 後 ${after}）`,
      after <= before,
      `after=${after} before=${before}`
    );
  }

  console.log('\n4) MjpegProxy: 起動と破棄を繰り返してもポートが残らない');
  {
    const before = activeTimers();
    for (let i = 0; i < 10; i++) {
      const proxy = new MjpegProxy(1);
      const port = await proxy.start(12800, 1); // 毎回同じポートを要求する
      if (port !== 12800) {
        check('同じポートを再取得できる', false, `回 ${i} で ${port}`);
        break;
      }
      proxy.dispose();
    }
    check('10 回の起動/破棄で同じポートを取り続けられる', true);
    await new Promise((r) => setImmediate(r));
    check(
      `ハンドルが残らない（前 ${before} / 後 ${activeTimers()}）`,
      activeTimers() <= before
    );
  }

  console.log('\n5) 上限値が CLAUDE.md の方針どおり定義されている');
  {
    // 数値そのものより「上限が存在すること」を守りたい
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'input', 'WdaBackend.ts'),
      'utf8'
    );
    check('WdaBackend に MAX_POINTS がある', /MAX_POINTS\s*=\s*\d+/.test(src));

    const sidecar = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'input', 'SimhidSidecar.ts'),
      'utf8'
    );
    check(
      'SimhidSidecar に stdout の上限がある',
      /MAX_STDOUT_BUFFER\s*=/.test(sidecar)
    );
    check(
      'SimhidSidecar が SIGKILL まで面倒を見る',
      /SIGKILL/.test(sidecar)
    );

    const server = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'utils', 'MobileCliServer.ts'),
      'utf8'
    );
    check('MobileCliServer が SIGKILL まで面倒を見る', /SIGKILL/.test(server));

    const main = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'media', 'webview', 'main.js'),
      'utf8'
    );
    check('webview の pointer 保持に上限がある', /MAX_POINTERS\s*=\s*\d+/.test(main));
    check('webview のフレームキューに上限がある', /MAX_FRAME_QUEUE\s*=\s*\d+/.test(main));
  }

  assert.strictEqual(failures, 0, `${failures} 件のテストが失敗`);
  console.log('\n全て成功');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
