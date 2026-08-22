// 「操作が本当にデバイスへ届いたか」を画面の変化で確かめる（iOS Simulator + HID 注入）。
//
// 単体テストは HID コマンドを組み立てるところまでしか見ない。実際の注入が壊れても
// simhid-server は黙って成功を返すことがあり（Xcode 更新で私有 API の挙動が変わる等）、
// scripts/check-xcode-hid.sh もシンボルが解決できるかしか見ていない。
// ここでは操作の前後でスクリーンショットを撮り、画面が動いたかどうかで判定する。
//
//   node test/tap-effect.device-test.js [UDID]
//
// UDID 省略時は起動中のシミュレータを使う。npm run build が済んでいること。
require('./helpers/vscode-stub').installVerbose();
const {execFile} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {promisify} = require('node:util');
const {diffRatio} = require('./helpers/screen-diff');

const execFileAsync = promisify(execFile);
const ROOT = path.join(__dirname, '..');
const {
  SimulatorInputController,
} = require(path.join(ROOT, 'out/input/SimulatorInputController'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 画面が「静止した」と見なす変化割合。時計やカーソルの点滅はこれ未満に収まる。 */
const STILL_RATIO = 0.002;
/** 操作が効いたと見なす変化割合。ノイズ床の実測値に足して使う。 */
const EFFECT_MARGIN = 0.01;

/**
 * 題材は設定アプリ。どのシミュレータにも必ず入っていて、
 * `terminate` してから `launch` すれば毎回トップ画面から始められる
 * （アプリを普通に起動すると iOS が前回の画面を復元してしまい、
 * 「何が映っているか」が実行ごとに変わる）。
 */
const SETTINGS_BUNDLE_ID = 'com.apple.Preferences';
/**
 * 設定トップの一番上のセル（Apple Account）の中心。iPhone 17 で実測。
 * セルは横幅いっぱいなので x は 0.5 でよく、縦だけが機種で動く。
 * **狙うのが一番背の高いセルなのは、機種差で外れにくくするため**
 * （アプリアイコンや Dock は並びと個数で位置が変わるので使わない）。
 *
 * **この比が通用するのは iPhone 15 以降**（ノッチ/Dynamic Island 世代で
 * 設定トップの縦配分がほぼ揃っている）。CI は機種を固定名では選ばないので、
 * ci.yml 側で「iPhone-15 以上の最新」に絞ってここと辻褄を合わせている。
 * 外れたら `xcrun simctl io booted screenshot` を撮って比を測り直す。
 */
const TOP_CELL_Y = 0.24;

let failures = 0;
function check(name, ok, extra) {
  if (ok) {
    console.log(`  ✅ ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    failures++;
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
  return ok;
}

/**
 * 落ちたときだけ、比べた 2 枚を残す。**割合だけでは原因が分からない**
 * （操作が届かなかったのか、そもそも想定した画面が出ていなかったのか）。
 */
function dump(name, before, after) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-effect-'));
  fs.writeFileSync(path.join(dir, `${name}-before.bmp`), before);
  fs.writeFileSync(path.join(dir, `${name}-after.bmp`), after);
  console.log(`     画像: ${dir}`);
}

const pct = (r) => `${(r * 100).toFixed(2)}%`;

/**
 * 確保したものを捨てる（CLAUDE.md「確保したものは必ず捨てる」）。
 * **例外で抜けるときも通る** — ここを通らないと simhid-server の子プロセスが残る。
 */
let controller = null;
function cleanup() {
  try {
    controller?.dispose();
  } catch {
    // dispose 中の失敗で後片付けを止めない
  }
  fs.rmSync(SHOT_PATH, {force: true});
}

/** テストの前提が崩れたら、判定を続けずにここで落とす。 */
function bail(message) {
  console.error(`\n${message}`);
  cleanup();
  process.exit(1);
}

/** 起動中のシミュレータの UDID。複数あれば先頭。 */
async function bootedUdid() {
  const {stdout} = await execFileAsync('xcrun', [
    'simctl',
    'list',
    'devices',
    'booted',
  ]);
  const m = stdout.match(/\(([0-9A-F-]{36})\) \(Booted\)/);
  return m ? m[1] : null;
}

/**
 * 1 枚撮って読み込む。ヘルプにある `-`（stdout）は実際には `-` という名の
 * ファイルへ書かれるので使えない。1 枚ぶんの一時ファイルを使い回し、最後に消す。
 * PNG ではなく BMP なのは screen-diff.js 参照。
 */
const SHOT_PATH = path.join(os.tmpdir(), `tap-effect-${process.pid}.bmp`);
async function shot(udid) {
  // screenshot に --force は無い（recordVideo だけ）。既にあると失敗するので先に消す
  fs.rmSync(SHOT_PATH, {force: true});
  await execFileAsync('xcrun', [
    'simctl', 'io', udid, 'screenshot', '--type=bmp', SHOT_PATH,
  ]);
  return fs.promises.readFile(SHOT_PATH);
}

/**
 * 画面が止まるまで待つ。スクロールの慣性やアニメーションが残ったまま差分を取ると、
 * 操作の効果と区別できない。**閾値は固定ではなく、ここで実測した床を後段が使う。**
 */
async function waitStill(udid, maxMs = 6000) {
  let prev = await shot(udid);
  const until = Date.now() + maxMs;
  let last = 1;
  while (Date.now() < until) {
    await sleep(250);
    const cur = await shot(udid);
    last = diffRatio(prev, cur);
    prev = cur;
    if (last < STILL_RATIO) return {image: cur, noise: last};
  }
  return {image: prev, noise: last, timedOut: true};
}

/**
 * 静止するまで待ち、**待てなければ落とす**。
 *
 * 止まらない画面のフレームを基準や閾値に使うと、後段の判定が全部おかしくなる
 * （ノイズ床が 0.9 なら閾値が 1 を超えて何をしても「変わらなかった」になるし、
 * アニメーション途中を基準にすると、測っているのが操作の効果か残りの動きか区別できない）。
 * 前提が崩れたことを、無関係な失敗に化けさせずにここで言う。
 */
async function stillOrBail(udid, label) {
  const r = await waitStill(udid);
  check(`画面が静止した（${label}）`, !r.timedOut, `直近の変化 ${pct(r.noise)}`);
  if (r.timedOut) {
    bail(`${label}: 画面が止まらないので判定できない（閾値も基準も決められない）`);
  }
  return r;
}

/**
 * 操作の効果が出そろうのを待つ。
 *
 * **操作の直後にいきなり静止を見てはいけない** — 反応が始まる前の 2 枚は当然そっくりで、
 * 「静止した」と誤判定してしまう（実際それで判定が実行ごとに揺れた）。
 * まず `before` から変わるのを待ち、変わってから静止を待つ。
 * 最後まで変わらなければ操作が届かなかったということなので、そのまま返して呼び手が落とす。
 */
async function settle(udid, before, threshold, maxMs = 6000) {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    const cur = await shot(udid);
    if (diffRatio(before, cur) > threshold) return (await waitStill(udid)).image;
    await sleep(150);
  }
  return shot(udid);
}

/** 設定アプリをトップ画面から開き直す。 */
async function openSettings(udid) {
  await execFileAsync('xcrun', ['simctl', 'terminate', udid, SETTINGS_BUNDLE_ID])
    .catch(() => {}); // 動いていなければ失敗するが、それでよい
  await execFileAsync('xcrun', ['simctl', 'launch', udid, SETTINGS_BUNDLE_ID]);
  await sleep(1500);
}

/** down → move ×steps → up。touchMove は応答を待たないので sleep で間隔を作る。 */
async function swipe(c, x0, y0, x1, y1, steps = 20, stepMs = 8) {
  await c.touchDown(x0, y0);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await c.touchMove(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
    await sleep(stepMs);
  }
  await c.touchUp(x1, y1);
}

async function tap(c, x, y) {
  await c.touchDown(x, y);
  await sleep(60);
  await c.touchUp(x, y);
}

/**
 * `WdaBackend` に渡す MobileCliClient のスタブ。HID が生きているあいだ触られないので、
 * **呼ばれたこと自体が「降格した」の証拠**。何のメソッドかを言って落ちる。
 * `then` だけ素通しするのは、await されたときに thenable と誤認されないため。
 */
function wdaTrap() {
  return new Proxy(
    {},
    {
      get: (_t, name) =>
        name === 'then'
          ? undefined
          : async () => {
              throw new Error(
                `WDA へ降格して ${String(name)}() が呼ばれた（HID テストの前提が崩れている）`
              );
            },
    }
  );
}

(async () => {
  const udid = process.argv[2] || (await bootedUdid());
  if (!udid) {
    console.error('起動中のシミュレータがありません（UDID を引数で渡すこともできます）');
    process.exit(2);
  }
  console.log(`device: ${udid}\n`);

  let backendKind = null;
  controller = new SimulatorInputController({
    deviceId: udid,
    platform: 'ios',
    type: 'simulator',
    // HID 経路では触られない。素の {} だと、降格後の呼び出しが
    // `pressButton is not a function` になって「降格した」が読めなくなるので、
    // 何を呼ばれたかを言って落ちるスタブを渡す
    mobileCliClient: wdaTrap(),
    getScreenSize: () => null,
    sidecarBinaryPath: path.join(ROOT, 'native/simhid-server'),
    onBackendChange: (kind) => (backendKind = kind),
  });
  await controller.init();

  // ここが 'wda' なら以降の差分は HID を通っていない。テストの前提が崩れるので止める
  check('HID バックエンドが選ばれた', backendKind === 'hid', `backend=${backendKind}`);
  if (backendKind !== 'hid') bail(`HID を選べなかった（backend=${backendKind}）`);

  // 捨ての 1 発。**しばらく操作していないと最初の注入が落ちることがある**
  // （実測: 間をあけて送る home が効かず、続けてもう一度送れば効く。再現条件までは
  // 特定できていない）。本体側は直していないので、ここで吸収しておかないと
  // 判定が実行ごとに揺れる。開いているアプリが閉じるだけで、直後に設定アプリを
  // 開き直すこのテストでは害がない。
  await controller.home();
  await sleep(1000);

  await openSettings(udid);

  console.log('ノイズ床の計測（無操作）');
  const {image: base, noise} = await stillOrBail(udid, 'ノイズ床');
  const threshold = noise + EFFECT_MARGIN;
  console.log(`  判定閾値: ${pct(threshold)}（ノイズ床 ${pct(noise)} + ${pct(EFFECT_MARGIN)}）`);

  console.log('\nホームボタン（HID の button）');
  await controller.home();
  const home = await settle(udid, base, threshold);
  const dHome = diffRatio(base, home);
  if (!check('ホームで画面が変わった', dHome > threshold, `変化 ${pct(dHome)}`)) dump('home', base, home);

  console.log('\nスワイプ（HID の touchDown/Move/Up）');
  await openSettings(udid);
  const swipeBase = (await stillOrBail(udid, 'スワイプ前')).image;
  await swipe(controller, 0.5, 0.72, 0.5, 0.3);
  const scrolled = await settle(udid, swipeBase, threshold);
  const dSwipe = diffRatio(swipeBase, scrolled);
  if (!check('スクロールで画面が変わった', dSwipe > threshold, `変化 ${pct(dSwipe)}`)) dump('swipe', swipeBase, scrolled);

  console.log('\nタップ（HID の touchDown/Up）');
  // スクロールで位置が動いているので、トップ画面から測り直す
  await openSettings(udid);
  const tapBase = (await stillOrBail(udid, 'タップ前')).image;
  await tap(controller, 0.5, TOP_CELL_Y);
  const tapped = await settle(udid, tapBase, threshold);
  const dTap = diffRatio(tapBase, tapped);
  if (!check('タップで画面が変わった', dTap > threshold, `変化 ${pct(dTap)}`)) dump('tap', tapBase, tapped);

  // 途中で降格していたら、上の差分は HID の証拠にならない
  check('最後まで HID のままだった', backendKind === 'hid', `backend=${backendKind}`);

  // 後片付け。次の実行が同じ状態から始まるように戻す
  await execFileAsync('xcrun', ['simctl', 'terminate', udid, SETTINGS_BUNDLE_ID])
    .catch(() => {});
  await controller.home();
  cleanup();
  console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  // 途中で投げても simhid-server の子プロセスを残さない
  cleanup();
  console.error('ERROR', e);
  process.exit(1);
});
