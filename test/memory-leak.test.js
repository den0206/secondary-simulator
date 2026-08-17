// 「増える一方の入れ物を作らない」（CLAUDE.md）の回帰テスト。
//
// 上限のあるバッファ・解放されるタイマー・破棄される参照を、実デバイス無しで検証する。
// 実測が要るもの（拡張ホストの RSS 推移など）はここでは扱わない。
const assert = require('node:assert');
require('./helpers/vscode-stub').install();

const {WdaBackend} = require('../out/input/WdaBackend');
const {AndroidBackend} = require('../out/input/AndroidBackend');
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

  console.log('\n1.5) AndroidBackend: 軌跡もタイマーも持ち越さない');
  {
    // 押しているあいだ「最新の 1 点だけ」を送るので、そもそも貯める入れ物が無い。
    // 入れ物が増えていないこと・タイマーが残らないことを守る。
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const keys = {
      kind: 'wda',
      async button() {},
      async key() {},
      async modifier() {},
      async text() {},
      dispose() {},
    };
    let maxActions = 0;
    let maxBytes = 0;
    const client = {
      async gesture(_dev, actions) {
        maxActions = Math.max(maxActions, actions.length);
        maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(actions)));
      },
      async tap() {},
      async inputText() {},
      async pressButton() {},
    };
    const screen = () => ({width: 1080, height: 2400});

    // touchUp が来ないまま 60 秒ぶん（60Hz）の move が届いた場合
    const a = new AndroidBackend(client, 'dev', screen, keys);
    await a.touchDown(0.5, 0.95);
    for (let i = 1; i <= 3600; i++) await a.touchMove(0.5, 0.95 - (i % 500) * 0.001);
    const held = Object.keys(a)
      .filter((k) => k !== 'client' && k !== 'keys')
      .map((k) => a[k]);
    check(
      '配列・Map・Set を保持しない（貯める入れ物が無い）',
      !held.some((v) => Array.isArray(v) || v instanceof Map || v instanceof Set)
    );
    await a.touchUp(0.5, 0.5);
    // 1 回の RPC は down/move/up を数個持つだけで、点数に比例しない
    // （WdaBackend は同じ入力で 1 回に 200 超のアクションを積む）。
    check(
      `1 回の gesture の action 数が一定（3600 move → 最大 ${maxActions} 個 / ${maxBytes}B）`,
      maxActions <= 4 && maxBytes < 256,
      `${maxActions} / ${maxBytes}B`
    );
    a.dispose();

    // タップ／ドラッグを繰り返してもタイマーが積み上がらない
    const base = activeTimers();
    const b = new AndroidBackend(client, 'dev', screen, keys);
    for (let i = 0; i < 500; i++) {
      await b.touchDown(0.5, 0.9);
      await b.touchUp(0.5, 0.9); // タップ
      await b.touchDown(0.5, 0.9);
      await b.touchMove(0.5, 0.5); // ドラッグ
      await b.touchUp(0.5, 0.5);
    }
    check(`500 往復してもタイマーが増えない（実測 ${activeTimers() - base}）`, activeTimers() === base);
    b.dispose();

    // 長押し判定のタイマーを抱えたまま dispose される場合
    const c = new AndroidBackend(client, 'dev', screen, keys);
    await c.touchDown(0.5, 0.9);
    check('長押し待ちのタイマーは 1 本だけ', activeTimers() - base === 1);
    c.dispose();
    check('dispose で長押し待ちのタイマーが外れる', activeTimers() === base);

    // 長押し成立待ち（holdTimer）の最中に dispose される場合。
    // clearTimeout だけだと待っている送信ループが解けずに残る。
    const d = new AndroidBackend(client, 'dev', screen, keys);
    await d.touchDown(0.5, 0.9);
    await sleep(AndroidBackend.LONG_PRESS_MS + 40); // down を先出し済み
    const pending = d.touchUp(0.5, 0.9); // 長押し成立まで待つ
    await sleep(10);
    check('長押し成立待ちのタイマーは 1 本だけ', activeTimers() - base === 1);
    d.dispose();
    await pending; // 待っていた送信ループがちゃんと解ける（解けないとここで止まる）
    check('dispose で成立待ちのタイマーが外れる', activeTimers() === base);
    check('送信ループの参照も外れる', d.pumping === null);
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

    const android = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'input', 'AndroidBackend.ts'),
      'utf8'
    );
    check(
      'AndroidBackend のエラーログに上限がある（ドラッグは高頻度パス）',
      /MAX_ERROR_LOGS\s*=\s*\d+/.test(android)
    );
    check(
      'AndroidBackend が抱えたタイマーを dispose で外す',
      /clearPressTimer\(\);[\s\S]{0,80}clearHoldTimer\(\);/.test(android)
    );

    check(
      'AndroidBackend の dispose が 2 度呼ばれても効くのは 1 回',
      /if \(this\.disposed\) return;/.test(android)
    );

    const adbTouch = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'input', 'AdbTouch.ts'),
      'utf8'
    );
    check('AdbTouch に stdout の上限がある', /MAX_BUF\s*=\s*\d+/.test(adbTouch));
    check('AdbTouch に応答待ちの上限がある', /MAX_PENDING\s*=\s*\d+/.test(adbTouch));
    check(
      'AdbTouch が返らない adb を待ち続けない',
      /TIMEOUT_MS\s*=\s*\d+/.test(adbTouch) && /clearTimeout\(timer\)/.test(adbTouch)
    );
    check(
      'AdbTouch が子プロセスを捨てる（pid は ResourceStats へ出す）',
      /proc\?\.kill\(\)/.test(adbTouch) && /get pid\(\)/.test(adbTouch)
    );

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
    // フレームは <img> へ直接渡すので、webview 側にキューを持たない
    // （溜める入れ物が無ければ上限も要らない。間引きは Chromium がやる）。
    check('webview がフレームを溜め込まない', !/frameQueue/.test(main));
    // 描画カウンタは集計の度に 0 へ戻す。読み捨てないと増える一方になる。
    check('描画カウンタを 0 に戻す', /paintedFrames\s*=\s*0/.test(main));
  }

  assert.strictEqual(failures, 0, `${failures} 件のテストが失敗`);
  console.log('\n全て成功');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
