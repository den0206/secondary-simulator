// 録画中だけ立てる Android の「タップを表示」を検証する（実 adb 不要）。
//
// ここが壊れると、利用者の端末に設定が残る（勝手に ON のままになる）か、
// 逆に普段 ON にしている人の設定を黙って落とす。どちらも気づきにくいので、
// adb へ渡すコマンド列そのものを見る。
require('./helpers/vscode-stub').install();

const {
  normalizeSetting,
  enable,
  restore,
} = require('../out/simulator/ShowTouches');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

/** 呼ばれたコマンド列を記録する差し替え用 runner。 */
function recorder(getOutput) {
  const calls = [];
  const run = async (args) => {
    calls.push(args.join(' '));
    return getOutput ? getOutput(args) : '';
  };
  return {calls, run};
}

(async () => {
  console.log('1) settings get の出力を put で使える値に直す');
  check('未設定の "null" は 0 へ', normalizeSetting('null\n') === '0');
  check('空文字は 0 へ', normalizeSetting('') === '0');
  check('"1" はそのまま', normalizeSetting('1\n') === '1');
  check('"0" はそのまま', normalizeSetting('0\n') === '0');
  // 想定外の値をそのまま書き戻すと設定が壊れる。0/1 のどちらかに寄せる。
  check('想定外の値は 0 へ寄せる', normalizeSetting('yes') === '0');

  console.log('\n2) 元が OFF なら立てて、元の値を返す');
  {
    const {calls, run} = recorder(() => '0\n');
    const previous = await enable('emulator-5554', run);
    check('元の値 0 を返す', previous === '0', String(previous));
    check(
      '読んでから書く',
      calls[0] === 'shell settings get system show_touches' &&
        calls[1] === 'shell settings put system show_touches 1',
      JSON.stringify(calls)
    );
    check('余計なコマンドを叩かない', calls.length === 2, String(calls.length));
  }

  console.log('\n3) 元から ON なら触らない');
  {
    const {calls, run} = recorder(() => '1\n');
    const previous = await enable('emulator-5554', run);
    check(
      '復元不要（null）を返す',
      previous === null,
      String(previous)
    );
    check(
      '書き込まない（普段 ON の人の設定を落とさない）',
      calls.length === 1 && calls[0].startsWith('shell settings get'),
      JSON.stringify(calls)
    );
  }

  console.log('\n4) 失敗しても録画は止めない');
  {
    const run = async () => {
      throw new Error('device offline');
    };
    let threw = false;
    let previous;
    try {
      previous = await enable('emulator-5554', run);
    } catch {
      threw = true;
    }
    check('例外を投げない', !threw);
    check('復元不要を返す', previous === null, String(previous));
  }

  console.log('\n5) 元の値へ戻す');
  {
    const {calls, run} = recorder();
    await restore('emulator-5554', '0', run);
    check(
      '0 へ戻す',
      calls.length === 1 &&
        calls[0] === 'shell settings put system show_touches 0',
      JSON.stringify(calls)
    );
  }
  {
    // 元が 1 だった端末（enable は null を返すので通常ここへは来ないが、
    // 呼ばれたら渡された値をそのまま書く、が正しい）
    const {calls, run} = recorder();
    await restore('emulator-5554', '1', run);
    check(
      '渡された値をそのまま書く',
      calls[0] === 'shell settings put system show_touches 1',
      JSON.stringify(calls)
    );
  }
  {
    const run = async () => {
      throw new Error('device offline');
    };
    let threw = false;
    try {
      await restore('emulator-5554', '0', run);
    } catch {
      threw = true;
    }
    check('戻せなくても例外を投げない（停止処理を止めない）', !threw);
  }

  if (failures > 0) {
    console.log(`\n${failures} 件失敗`);
    process.exit(1);
  }
  console.log('\n全て成功');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
