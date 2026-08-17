// SidecarCapture の適応制御と停止検出。サイドカーは実プロセスを使わず、
// send / onFrame / onCaptureAlive だけを持つスタブで置き換える。
require('./helpers/vscode-stub').install();

const {SidecarCapture} = require('../out/capture/SidecarCapture');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 送られたコマンドを記録するだけのサイドカー。 */
function fakeSidecar() {
  return {
    sent: [],
    onFrame: undefined,
    onCaptureAlive: undefined,
    send(cmd) {
      this.sent.push(cmd);
      return Promise.resolve();
    },
    last(name) {
      return [...this.sent].reverse().find((c) => c.cmd === name);
    },
    count(name) {
      return this.sent.filter((c) => c.cmd === name).length;
    },
  };
}

function makeCapture(config, options) {
  const sidecar = fakeSidecar();
  const capture = new SidecarCapture(
    sidecar,
    () => Object.assign({fps: 30, maxWidth: 640, quality: 0.8}, config),
    options
  );
  capture.setDevice('UDID');
  return {sidecar, capture};
}

/** captureServe で指定ポートが埋まっている状況を作る。 */
function refusePorts(sidecar, ports) {
  const send = sidecar.send.bind(sidecar);
  sidecar.send = (cmd) => {
    if (cmd.cmd === 'captureServe' && cmd.enable && ports.includes(cmd.port)) {
      sidecar.sent.push(cmd);
      return Promise.reject(new Error('ポートが使えない'));
    }
    return send(cmd);
  };
}

(async () => {
  console.log('1) 開始時に設定を載せて captureStart を送る');
  {
    const {sidecar, capture} = makeCapture();
    await capture.start();
    const start = sidecar.last('captureStart');
    check('captureStart が届く', !!start);
    check('設定が載る', start.fps === 30 && start.maxWidth === 640 && start.quality === 0.8,
      JSON.stringify(start));
    capture.dispose();
  }

  console.log('\n2) 表示幅に追従する（張り直さない）');
  {
    const {sidecar, capture} = makeCapture();
    await capture.start();
    capture.setViewportWidth(320);
    await sleep(0);
    const cfg = sidecar.last('captureConfig');
    check('captureConfig で送る', !!cfg, JSON.stringify(sidecar.sent));
    check('狭い幅がそのまま入る', cfg && cfg.maxWidth === 320, JSON.stringify(cfg));
    check('張り直していない（captureStart は 1 回）', sidecar.count('captureStart') === 1);
    check('captureStop を挟まない', sidecar.count('captureStop') === 0);

    // 同じ幅を送り直しても増えない（数 px の揺れも無視する）
    const before = sidecar.count('captureConfig');
    capture.setViewportWidth(320);
    capture.setViewportWidth(325);
    await sleep(0);
    check('同じ幅では送り直さない', sidecar.count('captureConfig') === before,
      `${before} → ${sidecar.count('captureConfig')}`);
    capture.dispose();
  }

  console.log('\n3) 操作中だけ fps を上げる');
  {
    const {sidecar, capture} = makeCapture({}, {});
    await capture.start();
    capture.setInteracting(true);
    await sleep(0);
    check('押下で 60fps へ', sidecar.last('captureConfig')?.fps === 60,
      JSON.stringify(sidecar.last('captureConfig')));

    const during = sidecar.count('captureConfig');
    capture.setInteracting(true); // ドラッグ中の重複
    await sleep(0);
    check('押しっぱなしで送り直さない', sidecar.count('captureConfig') === during);

    capture.setInteracting(false);
    await sleep(0);
    check('離した直後はまだ戻さない（慣性のぶん待つ）',
      sidecar.last('captureConfig')?.fps === 60);
    await sleep(800);
    check('少し待つと元の fps へ戻る', sidecar.last('captureConfig')?.fps === 30,
      JSON.stringify(sidecar.last('captureConfig')));
    capture.dispose();
  }

  console.log('\n4) 停止検出');
  {
    // 生存通知を 1 度も受け取っていない間は張り直さない
    const {sidecar, capture} = makeCapture({}, {stallTimeoutMs: 40});
    await capture.start();
    await sleep(120);
    check('生存通知が無い相手は張り直さない（古いバイナリを再起動しない）',
      sidecar.count('captureStart') === 1, String(sidecar.count('captureStart')));

    // 生存通知を受け取ると停止検出が始まる
    sidecar.onCaptureAlive();
    await sleep(120);
    check('通知が途絶えたら張り直す', sidecar.count('captureStart') === 2,
      String(sidecar.count('captureStart')));
    check('張り直しの前に captureStop を送る', sidecar.count('captureStop') >= 1);
    capture.dispose();
  }

  console.log('\n5) 生存通知が続く間は張り直さない（静止画面でも切らない）');
  {
    const {sidecar, capture} = makeCapture({}, {stallTimeoutMs: 60});
    await capture.start();
    // フレームは 1 枚も来ない（画面が静止している）が、通知は届き続ける
    for (let i = 0; i < 6; i++) {
      sidecar.onCaptureAlive();
      await sleep(20);
    }
    check('フレームが 0 枚でも張り直さない', sidecar.count('captureStart') === 1,
      String(sidecar.count('captureStart')));
    capture.dispose();
  }

  console.log('\n6) フレームは base64 のまま渡り、停止検出も張り直る');
  {
    const {sidecar, capture} = makeCapture({}, {stallTimeoutMs: 60});
    const got = [];
    capture.onFrame((f) => got.push(f));
    await capture.start();
    sidecar.onCaptureAlive();
    for (let i = 0; i < 4; i++) {
      sidecar.onFrame('QUJD');
      await sleep(20);
    }
    check('base64 のまま届く', got.length === 4 && got[0] === 'QUJD', JSON.stringify(got));
    check('フレームが来ている間は張り直さない', sidecar.count('captureStart') === 1);
    capture.dispose();
  }

  console.log('\n7) stop / dispose でタイマーを残さない');
  {
    const {sidecar, capture} = makeCapture({}, {stallTimeoutMs: 40});
    await capture.start();
    sidecar.onCaptureAlive();
    capture.setInteracting(true);
    capture.setInteracting(false); // 慣性タイマーを起こす
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    capture.dispose();
    const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    check('タイマーが残らない', after < before || after === 0, `${before} → ${after}`);
    check('dispose 後に張り直さない', sidecar.count('captureStart') === 1);
    await sleep(120);
    check('待っても張り直さない', sidecar.count('captureStart') === 1,
      String(sidecar.count('captureStart')));
    check('onFrame の紐付けを外す', sidecar.onFrame === undefined);
    check('onCaptureAlive の紐付けを外す', sidecar.onCaptureAlive === undefined);
  }

  console.log('\n8) 直結配信（sink: http）');
  {
    const {sidecar, capture} = makeCapture({}, {sink: 'http'});
    let url = null;
    capture.onStreamChange = (u) => (url = u);
    await capture.start();

    const serve = sidecar.last('captureServe');
    check('captureServe を先に送る', !!serve && serve.enable === true);
    check('ポートは拡張ホストが決める（CSP の範囲の先頭）', serve.port === 12220,
      String(serve && serve.port));
    check('トークンを渡す', typeof serve.token === 'string' && serve.token.length >= 32,
      String(serve && serve.token));
    check('captureServe は captureStart より前',
      sidecar.sent.findIndex((c) => c.cmd === 'captureServe') <
        sidecar.sent.findIndex((c) => c.cmd === 'captureStart'));

    const start = sidecar.last('captureStart');
    check('captureStart に sink=http が載る', start.sink === 'http', JSON.stringify(start));
    check('URL が通知される', typeof url === 'string' && url.includes('127.0.0.1') === false);
    check('URL に device とトークンが載る',
      url.includes('device=UDID') && url.includes(`t=${serve.token}`), url);
    check('localhost で組み立てる（portMapping が効く形）',
      url.startsWith('http://localhost:12220/stream?'), url);

    // 停止で待ち受けも畳む（サイドカーは使い回されるので開けっ放しにしない）
    capture.stop();
    const off = sidecar.last('captureServe');
    check('stop で配信を止める', off.enable === false, JSON.stringify(off));
    capture.dispose();
  }

  console.log('\n8b) トークンはインスタンス毎に変わる');
  {
    const a = makeCapture({}, {sink: 'http'});
    const b = makeCapture({}, {sink: 'http'});
    await a.capture.start();
    await b.capture.start();
    const ta = a.sidecar.last('captureServe').token;
    const tb = b.sidecar.last('captureServe').token;
    check('別インスタンスで別のトークン', ta !== tb, `${ta} / ${tb}`);
    a.capture.dispose();
    b.capture.dispose();
  }

  console.log('\n9) 埋まっているポートは次を試す');
  {
    const {sidecar, capture} = makeCapture({}, {sink: 'http'});
    refusePorts(sidecar, [12220, 12221]);
    let url = null;
    capture.onStreamChange = (u) => (url = u);
    await capture.start();
    check('空くまで順に試す', url && url.includes(':12222/'), String(url));
    check('captureStart は 1 回だけ', sidecar.count('captureStart') === 1);
    capture.dispose();
  }

  console.log('\n10) 配信を張れなければ stdout へ降りる');
  {
    const {sidecar, capture} = makeCapture({}, {sink: 'http'});
    // 全ポート埋まり
    refusePorts(sidecar, Array.from({length: 20}, (_, i) => 12220 + i));
    let url = null;
    capture.onStreamChange = (u) => (url = u);
    const got = [];
    capture.onFrame((f) => got.push(f));
    await capture.start();
    check('取り込み自体は始まる', sidecar.count('captureStart') === 1);
    check('sink が stdout に落ちる', sidecar.last('captureStart').sink === 'stdout',
      JSON.stringify(sidecar.last('captureStart')));
    check('URL は通知しない', url === null, String(url));
    sidecar.onFrame('QUJD');
    check('stdout 経由でフレームが届く', got.length === 1, String(got.length));
    capture.dispose();
  }

  console.log('\n11) 取り込みの駆動方法を渡す');
  {
    const {sidecar, capture} = makeCapture({}, {mode: 'poll'});
    await capture.start();
    check('mode=poll を伝える', sidecar.last('captureStart').mode === 'poll');
    capture.dispose();
    const auto = makeCapture({}, {});
    await auto.capture.start();
    check('既定は auto（変更通知を試す）',
      auto.sidecar.last('captureStart').mode === 'auto');
    auto.capture.dispose();
  }

  console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('テストが例外で終了', e);
  process.exit(1);
});
