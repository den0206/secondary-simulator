// サイドカーのプロトコル（JSON Lines 往復）と、Controller のバックエンド選択・降格を検証する。
// 実デバイス不要: 偽サイドカー（Node スクリプト）と偽 mobilecli クライアントを使う。
const fs = require('fs');
const os = require('os');
const path = require('path');

// vscode をスタブ（Logger が依存）
require('./helpers/vscode-stub').install();

const ROOT = path.join(__dirname, '..');
const {SimhidSidecar} = require(path.join(ROOT, 'out/input/SimhidSidecar'));
const {SimulatorInputController} = require(path.join(
  ROOT,
  'out/input/SimulatorInputController'
));

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

// 指定の挙動をする偽サイドカーを一時ファイルに書き出し、実行可能にする
function writeFakeSidecar(body) {
  const p = path.join(os.tmpdir(), `fake-simhid-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(p, '#!/usr/bin/env node\n' + body, {mode: 0o755});
  return p;
}

const NORMAL = `
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({event: 'ready', pid: process.pid});
let buf = '';
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.cmd === 'fail') { if (m.id) out({id: m.id, ok: false, error: 'boom'}); continue; }
    if (m.cmd === 'silent') continue;              // 応答しない → timeout 検証
    if (m.id) out({id: m.id, ok: true, latencyMs: 0.05});
    process.stderr.write('got ' + m.cmd + '\\n');   // 受信記録
  }
});
`;

const FATAL = `
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({event: 'fatal', reason: 'シンボル解決に失敗'});
setTimeout(() => process.exit(1), 50);
`;

(async () => {
  console.log('1) 正常なサイドカーとの往復');
  {
    const bin = writeFakeSidecar(NORMAL);
    const s = new SimhidSidecar(bin);
    await s.start();
    check('ready を受けて start が解決する', true);
    await s.send({cmd: 'touchDown', device: 'X', x: 0.5, y: 0.5});
    check('ok 応答で resolve する', true);

    let rejected = false;
    try {
      await s.send({cmd: 'fail', device: 'X'});
    } catch (e) {
      rejected = /boom/.test(e.message);
    }
    check('error 応答で reject する', rejected);

    s.sendNoWait({cmd: 'touchMove', device: 'X', x: 0.1, y: 0.1});
    check('sendNoWait が例外を投げない', true);

    s.dispose();
    fs.unlinkSync(bin);
  }

  console.log('\n2) fatal を出すサイドカー');
  {
    const bin = writeFakeSidecar(FATAL);
    const s = new SimhidSidecar(bin);
    let threw = false;
    try {
      await s.start();
    } catch (e) {
      threw = /fatal/.test(e.message);
    }
    check('start が fatal で reject する', threw);
    check('isFatal が true', s.isFatal());
    s.dispose();
    fs.unlinkSync(bin);
  }

  console.log('\n3) バイナリが無いとき');
  {
    const s = new SimhidSidecar('/nonexistent/simhid-server');
    let threw = false;
    try {
      await s.start();
    } catch {
      threw = true;
    }
    check('start が reject する', threw);
    s.dispose();
  }

  console.log('\n4) Controller のバックエンド選択');
  {
    // HID が使えるケース
    const bin = writeFakeSidecar(NORMAL);
    const kinds = [];
    const ctrl = new SimulatorInputController({
      deviceId: 'X',
      platform: 'ios',
      type: 'simulator',
      mobileCliClient: {},
      getScreenSize: () => ({width: 100, height: 200}),
      sidecarBinaryPath: bin,
      onBackendChange: (k) => kinds.push(k),
    });
    await ctrl.init();
    check('iOS Simulator では hid を選ぶ', ctrl.backendKind === 'hid', ctrl.backendKind);
    check('onBackendChange が hid を通知', kinds[0] === 'hid');
    ctrl.dispose();
    fs.unlinkSync(bin);
  }

  console.log('\n5) Android は WDA にフォールバック');
  {
    const calls = [];
    const fakeCli = {
      tap: async (...a) => calls.push(['tap', ...a]),
      gesture: async (...a) => calls.push(['gesture', a[1].length]),
      inputText: async (...a) => calls.push(['inputText', a[1]]),
      pressButton: async (...a) => calls.push(['pressButton', a[1]]),
    };
    const ctrl = new SimulatorInputController({
      deviceId: 'A',
      platform: 'android',
      type: 'emulator',
      mobileCliClient: fakeCli,
      getScreenSize: () => ({width: 1000, height: 2000}),
      sidecarBinaryPath: '/nonexistent',
      onBackendChange: () => {},
    });
    check('init 前でも primary は wda（未初期化で落ちない）', ctrl.backendKind === 'wda');
    await ctrl.init();
    check('Android では wda を選ぶ', ctrl.backendKind === 'wda', ctrl.backendKind);

    // WDA 経路: down→up の短距離は tap になる
    await ctrl.touchDown(0.5, 0.5);
    await ctrl.touchUp(0.5, 0.5);
    check('短距離は tap に変換される', calls.some((c) => c[0] === 'tap'), JSON.stringify(calls));
    check('tap がピクセル座標に変換される',
      calls.find((c) => c[0] === 'tap')?.[2] === 500, JSON.stringify(calls[0]));

    // 長距離ドラッグは gesture になる
    calls.length = 0;
    await ctrl.touchDown(0.5, 0.8);
    await ctrl.touchMove(0.5, 0.5);
    await ctrl.touchUp(0.5, 0.2);
    check('長距離は gesture に変換される', calls.some((c) => c[0] === 'gesture'),
      JSON.stringify(calls));

    // 静止ホールドは tap にせず long press 相当の gesture にする
    calls.length = 0;
    await ctrl.touchDown(0.4, 0.4);
    await new Promise((r) => setTimeout(r, 450));
    await ctrl.touchUp(0.4, 0.4);
    check('長押し静止は gesture になる', calls.some((c) => c[0] === 'gesture'),
      JSON.stringify(calls));
    check('長押し静止は tap にしない', !calls.some((c) => c[0] === 'tap'),
      JSON.stringify(calls));

    // iOS ではない → back は BACK ボタン
    calls.length = 0;
    await ctrl.back();
    check('Android の back は BACK を送る',
      calls.some((c) => c[0] === 'pressButton' && c[1] === 'BACK'), JSON.stringify(calls));

    ctrl.dispose();
  }

  console.log('\n6) iOS の back は no-op');
  {
    const calls = [];
    const bin = writeFakeSidecar(NORMAL);
    const ctrl = new SimulatorInputController({
      deviceId: 'X',
      platform: 'ios',
      type: 'simulator',
      mobileCliClient: {pressButton: async (...a) => calls.push(a[1])},
      getScreenSize: () => ({width: 100, height: 200}),
      sidecarBinaryPath: bin,
      onBackendChange: () => {},
    });
    await ctrl.init();
    await ctrl.back();
    check('iOS では何も送らない', calls.length === 0, JSON.stringify(calls));
    ctrl.dispose();
    fs.unlinkSync(bin);
  }

  console.log('\n7) type 不明の iOS は HID を選ばない');
  {
    const bin = writeFakeSidecar(NORMAL);
    const ctrl = new SimulatorInputController({
      deviceId: 'X',
      platform: 'ios',
      type: 'real',
      mobileCliClient: {},
      getScreenSize: () => ({width: 100, height: 200}),
      sidecarBinaryPath: bin,
      onBackendChange: () => {},
    });
    await ctrl.init();
    check('実機扱いは wda', ctrl.backendKind === 'wda', ctrl.backendKind);
    ctrl.dispose();
    fs.unlinkSync(bin);
  }

  console.log('\n8) 画面取り込み（captureStart → frame 通知）');
  {
    // captureStart を受けたら frame を 2 枚流す偽サイドカー
    const bin = writeFakeSidecar(`
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({event: 'ready', pid: process.pid});
let buf = '';
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id) out({id: m.id, ok: true});
    if (m.cmd === 'captureStart') {
      out({event: 'frame', device: m.device, w: 4, h: 8, data: Buffer.from([0xff, 0xd8, 0x01]).toString('base64')});
      out({event: 'frame', device: m.device, w: 4, h: 8, data: Buffer.from([0xff, 0xd8, 0x02]).toString('base64')});
    }
  }
});
`);
    const sidecar = new SimhidSidecar(bin);
    await sidecar.start();
    const {SidecarCapture} = require(path.join(ROOT, 'out/capture/SidecarCapture'));
    const capture = new SidecarCapture(sidecar, () => ({
      fps: 30,
      maxWidth: 640,
      quality: 0.6,
    }));
    const frames = [];
    capture.setDevice('UDID');
    capture.onFrame((f) => frames.push(Buffer.from(f)));
    await capture.start();
    await new Promise((r) => setTimeout(r, 150));
    check('frame 通知が届く', frames.length === 2, String(frames.length));
    check(
      'base64 がバイト列へ戻る',
      frames[0] && frames[0].equals(Buffer.from([0xff, 0xd8, 0x01])),
      frames[0] && frames[0].toString('hex')
    );
    capture.stop();
    await new Promise((r) => setTimeout(r, 50));
    frames.length = 0;
    // stop 後に来たフレームは捨てる（onFrame を外しているため）
    check('stop 後は受け取らない', frames.length === 0);
    capture.dispose();
    sidecar.dispose();
    fs.unlinkSync(bin);
  }

  console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('テストが例外で終了', e);
  process.exit(1);
});
