// Android（adb）タッチ経路の検証。
//
// mobilecli の device.io.gesture は Android では「1 アクション = adb 1 回」に展開され、
// duration は無視される。つまり **アクションの数がそのまま所要時間**で、
// **イベントが届いた実時刻がそのまま端末の見る時刻**になる。
// ここではその 2 点（数が爆発しないこと・指を離す前に届くこと）を実デバイス無しで見る。
const assert = require('node:assert');
require('./helpers/vscode-stub').install();

const {AndroidBackend} = require('../out/input/AndroidBackend');
const {SimulatorInputController} = require('../out/input/SimulatorInputController');

let failures = 0;
function check(name, ok, extra) {
  if (ok) {
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCREEN = {width: 1080, height: 2400};

/** adb 1 回ぶんの遅延を持つ偽 client。呼ばれた時刻とアクションを全部残す。 */
function fakeClient(latencyMs = 20) {
  const t0 = Date.now();
  const calls = [];
  return {
    calls,
    /** 送られたアクションを 1 本に潰したもの（端末が実際に見るイベント列）。 */
    events() {
      return calls
        .filter((c) => c.kind === 'gesture')
        .flatMap((c) => c.actions.map((a) => ({...a, at: c.at})));
    },
    taps() {
      return calls.filter((c) => c.kind === 'tap');
    },
    async gesture(_dev, actions) {
      calls.push({kind: 'gesture', actions, at: Date.now() - t0});
      await sleep(latencyMs);
    },
    async tap(_dev, x, y) {
      calls.push({kind: 'tap', x, y, at: Date.now() - t0});
      await sleep(latencyMs);
    },
    async inputText() {},
    async pressButton() {},
  };
}

const makeBackend = (client, screen = SCREEN) =>
  new AndroidBackend(client, 'emulator-5554', () => screen, {
    kind: 'wda',
    async button() {},
    async key() {},
    async modifier() {},
    async text() {},
    dispose() {},
  });

(async () => {
  console.log('\n1) ドラッグは指を離す前に送られ、アクション数が点数で爆発しない');
  {
    // adb shell input は 1 回 100ms 前後かかる。その往復に合わせて自動的に間引かれる。
    const client = fakeClient(100);
    const b = makeBackend(client);

    await b.touchDown(0.5, 0.8);
    // 60Hz で 1 秒ぶん（60 点）ドラッグする。実時間も進める
    for (let i = 1; i <= 60; i++) {
      await b.touchMove(0.5, 0.8 - i * 0.005);
      await sleep(16);
    }
    const duringDrag = client.calls.length;
    check(
      `指を離す前に端末へ届いている（実測 ${duringDrag} 回）`,
      duringDrag > 0,
      String(duringDrag)
    );

    await b.touchUp(0.5, 0.5);
    await sleep(300); // 最後の 1 往復を待つ

    const events = client.events();
    // 貯めて一括送信していた頃は 60 点 = adb 62 回（≒ 6 秒）だった。
    // 今は adb の往復に律速されるので、点数ではなく所要時間で頭打ちになる。
    check(
      `adb に展開されるイベント数が点数より十分少ない（60 点 → 実測 ${events.length}）`,
      events.length <= 20,
      String(events.length)
    );
    check(
      'down → move… → up の順で 1 セッションになっている',
      events[0].type === 'pointerMove' &&
        events[1].type === 'pointerDown' &&
        events[events.length - 1].type === 'pointerUp' &&
        events.filter((e) => e.type === 'pointerDown').length === 1 &&
        events.filter((e) => e.type === 'pointerUp').length === 1,
      JSON.stringify(events.map((e) => e.type))
    );

    // フリック（慣性）が効くには、端末が見る down..up の実時間が指の実時間と
    // 揃っている必要がある。1 秒のドラッグが数十秒に伸びないことを見る。
    const down = events.find((e) => e.type === 'pointerDown');
    const up = events[events.length - 1];
    const span = up.at - down.at;
    check(
      `down..up の実時間が指の操作時間に近い（1000ms の操作 → 実測 ${span}ms）`,
      span < 1600,
      `${span}ms`
    );

    // 途中経過が実際に「動いて」いる（同じ点を送り続けていない）
    const moves = events.filter((e) => e.type === 'pointerMove');
    const ys = new Set(moves.map((m) => m.y));
    check(`中間の move が動いている（相異なる y が ${ys.size} 個）`, ys.size >= 3);
    check(
      'up の座標が指を離した位置',
      moves[moves.length - 1].y === Math.round(0.5 * SCREEN.height),
      JSON.stringify(moves[moves.length - 1])
    );
  }

  console.log('\n2) 送信中に届いた move は最新の 1 点に畳まれる（溜めない）');
  {
    const client = fakeClient(100); // adb が遅い想定
    const b = makeBackend(client);

    await b.touchDown(0.5, 0.9);
    // 1 往復（100ms）のあいだに 30 点ぶん詰め込む
    for (let i = 1; i <= 30; i++) await b.touchMove(0.5, 0.9 - i * 0.01);
    await sleep(250);
    const sent = client.events().filter((e) => e.type === 'pointerMove');
    check(
      `詰め込んだ 30 点が数回に畳まれる（実測 ${sent.length} 件）`,
      sent.length <= 5,
      String(sent.length)
    );
    check(
      '畳まれた先は最新の点（古い点を再生しない）',
      sent[sent.length - 1].y === Math.round(0.6 * SCREEN.height),
      JSON.stringify(sent[sent.length - 1])
    );
    await b.touchUp(0.5, 0.6);
    await sleep(250);
    b.dispose();
  }

  console.log('\n3) タップ・長押し・slop 未満の揺れ');
  {
    const client = fakeClient(5);
    const b = makeBackend(client);
    await b.touchDown(0.3, 0.4);
    await b.touchUp(0.3, 0.4);
    check(
      'タップは gesture ではなく tap 1 回',
      client.taps().length === 1 && client.events().length === 0,
      JSON.stringify(client.calls)
    );
    check(
      'タップ座標がピクセルへ正しく変換される',
      client.taps()[0].x === Math.round(0.3 * SCREEN.width) &&
        client.taps()[0].y === Math.round(0.4 * SCREEN.height),
      JSON.stringify(client.taps()[0])
    );

    // 指の微妙な揺れ（slop 未満）はタップのまま
    const c2 = fakeClient(5);
    const b2 = makeBackend(c2);
    await b2.touchDown(0.5, 0.5);
    await b2.touchMove(0.5 + 2 / SCREEN.width, 0.5 + 2 / SCREEN.height);
    await b2.touchUp(0.5 + 2 / SCREEN.width, 0.5 + 2 / SCREEN.height);
    await sleep(20);
    check(
      'slop 未満の揺れはタップのまま（ドラッグにしない）',
      c2.taps().length === 1 && c2.events().length === 0,
      JSON.stringify(c2.calls)
    );

    // 長押し: down を先出しし、LONG_PRESS_MS 以上押してから離す
    const c3 = fakeClient(5);
    const b3 = makeBackend(c3);
    await b3.touchDown(0.5, 0.5);
    await sleep(AndroidBackend.LONG_PRESS_MS + 120);
    const beforeUp = c3.events();
    check(
      '静止したまま閾値を超えたら down が先に出る',
      beforeUp.some((e) => e.type === 'pointerDown') &&
        !beforeUp.some((e) => e.type === 'pointerUp'),
      JSON.stringify(beforeUp.map((e) => e.type))
    );
    await b3.touchUp(0.5, 0.5);
    await sleep(50);
    const ev3 = c3.events();
    const d3 = ev3.find((e) => e.type === 'pointerDown');
    const u3 = ev3.find((e) => e.type === 'pointerUp');
    check(
      `端末が見る押下時間が長押しとして成立する（実測 ${u3 ? u3.at - d3.at : -1}ms）`,
      u3 && u3.at - d3.at >= AndroidBackend.LONG_PRESS_MS - 20,
      String(u3 ? u3.at - d3.at : -1)
    );
    b3.dispose();
  }

  console.log('\n4) 長押しのあと動かしても、長押しが成立してから move が出る');
  {
    const client = fakeClient(5);
    const b = makeBackend(client);
    await b.touchDown(0.5, 0.5);
    // down が出るまで待ち、すぐ動かす（ドラッグ＆ドロップ）
    await sleep(AndroidBackend.LONG_PRESS_MS + 30);
    await b.touchMove(0.5, 0.3);
    await sleep(AndroidBackend.LONG_PRESS_MS + 80);
    const ev = client.events();
    const down = ev.find((e) => e.type === 'pointerDown');
    const move = ev.filter((e) => e.type === 'pointerMove').find((e) => e.at > down.at);
    check(
      `長押し成立前に move を出さない（down→move 実測 ${move ? move.at - down.at : -1}ms）`,
      move && move.at - down.at >= AndroidBackend.LONG_PRESS_MS - 20,
      String(move ? move.at - down.at : -1)
    );
    await b.touchUp(0.5, 0.3);
    await sleep(30);
    b.dispose();
  }

  console.log('\n5) 後始末（押しっぱなしを残さない・タイマーを残さない）');
  {
    const client = fakeClient(5);
    const b = makeBackend(client);
    await b.touchDown(0.5, 0.9);
    await b.touchMove(0.5, 0.5);
    await sleep(30);
    const before = client.events().filter((e) => e.type === 'pointerUp').length;
    b.dispose();
    await sleep(30);
    const after = client.events().filter((e) => e.type === 'pointerUp').length;
    check('ドラッグ中に dispose すると指を離す', before === 0 && after === 1);

    // pointerup を取りこぼしても、次の touchDown が前のセッションを閉じる
    const c2 = fakeClient(5);
    const b2 = makeBackend(c2);
    await b2.touchDown(0.5, 0.9);
    await b2.touchMove(0.5, 0.5);
    await sleep(30);
    await b2.touchDown(0.2, 0.2);
    await b2.touchUp(0.2, 0.2);
    await sleep(30);
    const ups = c2.events().filter((e) => e.type === 'pointerUp').length;
    const downs = c2.events().filter((e) => e.type === 'pointerDown').length;
    check('取りこぼした前のセッションが閉じられる', ups === downs, `${downs} down / ${ups} up`);
    b2.dispose();
  }

  console.log('\n5.5) 連打しても前のセッションの up が新しい座標へずれない');
  {
    const client = fakeClient(100);
    const b = makeBackend(client);
    await b.touchDown(0.5, 0.9);
    await b.touchMove(0.5, 0.5);
    await sleep(10); // まだ adb の往復中
    // touchUp の完了を待たずに次のタッチが始まる（素早い連打。provider は
    // メッセージごとに独立して handleTouch を呼ぶので実際に起こりうる）
    const up1 = b.touchUp(0.5, 0.5);
    const down2 = b.touchDown(0.1, 0.1);
    await Promise.all([up1, down2]);
    await b.touchUp(0.1, 0.1);
    await sleep(300);

    const ups = client.events().filter((e) => e.type === 'pointerUp');
    const moves = client.events().filter((e) => e.type === 'pointerMove');
    const upIdx = client.events().findIndex((e) => e.type === 'pointerUp');
    const beforeUp = client.events()[upIdx - 1];
    check(
      '1 回目の up が 1 回目の終点で出る',
      ups.length === 1 &&
        beforeUp.type === 'pointerMove' &&
        beforeUp.y === Math.round(0.5 * SCREEN.height),
      JSON.stringify({ups: ups.length, beforeUp})
    );
    check(
      '2 回目はタップとして送られる（gesture へ混ざらない）',
      client.taps().length === 1 &&
        client.taps()[0].y === Math.round(0.1 * SCREEN.height),
      JSON.stringify(client.taps())
    );
    check('1 回目の move が 2 回目の座標に汚染されない', !moves.some((m) => m.y === Math.round(0.1 * SCREEN.height)));
    b.dispose();
  }

  console.log('\n6) 経路の選択');
  {
    const client = fakeClient(5);
    const android = new SimulatorInputController({
      deviceId: 'emulator-5554',
      platform: 'android',
      type: 'emulator',
      mobileCliClient: client,
      getScreenSize: () => SCREEN,
      sidecarBinaryPath: '/nonexistent/simhid-server',
    });
    await android.init();
    check('Android は AndroidBackend を選ぶ', android.primary instanceof AndroidBackend);
    check('入力経路の表示は互換モード（WDA 系）のまま', android.backendKind === 'wda');
    android.dispose();

    const ios = new SimulatorInputController({
      deviceId: 'iphone',
      platform: 'ios',
      type: 'real',
      mobileCliClient: client,
      getScreenSize: () => SCREEN,
      sidecarBinaryPath: '/nonexistent/simhid-server',
    });
    await ios.init();
    check(
      'iOS は従来どおり WdaBackend（gesture の duration が効く経路）',
      !(ios.primary instanceof AndroidBackend)
    );
    ios.dispose();
  }

  assert.strictEqual(failures, 0, `${failures} 件のテストが失敗`);
  console.log('\n全て成功');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
