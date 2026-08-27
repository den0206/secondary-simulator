// captureRate / captureConfigAction の検証。vscode に触らない純粋関数。
const assert = require('node:assert');
require('./helpers/vscode-stub').install();

const {
  captureRate,
  captureConfigAction,
  effectiveCaptureConfig,
  RECORDING_WIDTH,
} = require('../out/capture/CaptureStats');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
  } catch (e) {
    console.log(`  ❌ ${name} — ${e.message}`);
    failures++;
  }
}

console.log('1) 取り込みレートの集計');

check('30 フレーム / 1 秒 → 30fps', () => {
  assert.strictEqual(captureRate(30, 0, 1000).fps, 30);
});

check('30 秒の集計期間でも毎秒へ直す', () => {
  assert.strictEqual(captureRate(900, 0, 30_000).fps, 30);
});

check('静止画面は 0.x fps を潰さない', () => {
  // 30 秒で 3 枚 = 0.1fps。整数に丸めると「止まっている」と見分けが付かなくなる
  assert.strictEqual(captureRate(3, 0, 30_000).fps, 0.1);
});

check('帯域は KB/s（base64 の文字数で数える）', () => {
  // 30 秒で 30MB → 1024KB/s
  assert.strictEqual(captureRate(0, 1024 * 1024 * 30, 30_000).kbps, 1024);
});

check('期間 0 は測れていないので 0 を返す（Infinity にしない）', () => {
  assert.deepStrictEqual(captureRate(10, 1000, 0), {fps: 0, kbps: 0});
});

check('負の期間・NaN でも 0', () => {
  assert.deepStrictEqual(captureRate(10, 1000, -5), {fps: 0, kbps: 0});
  assert.deepStrictEqual(captureRate(10, 1000, NaN), {fps: 0, kbps: 0});
});

check('フレーム 0 でも例外にならない', () => {
  assert.deepStrictEqual(captureRate(0, 0, 30_000), {fps: 0, kbps: 0});
});

console.log('\n2) 設定変更で取り込みをどう扱うか');

// affectsConfiguration の代わり。渡されたキーだけ true を返す。
const changed = (...keys) => (section) => keys.includes(section);

check('captureFps / 幅 / 品質は張り直さず差し替える', () => {
  for (const key of [
    'secondarySimulator.captureFps',
    'secondarySimulator.captureMaxWidth',
    'secondarySimulator.streamQuality',
  ]) {
    assert.strictEqual(captureConfigAction(changed(key)), 'tune', key);
  }
});

check('経路そのものが変わる設定は作り直す', () => {
  for (const key of [
    'secondarySimulator.captureSource',
    'secondarySimulator.directStream',
    'secondarySimulator.captureMode',
    'secondarySimulator.streamScale',
  ]) {
    assert.strictEqual(captureConfigAction(changed(key)), 'recreate', key);
  }
});

check('autoConnect では触れない（Auto ボタンで画面を切らない）', () => {
  assert.strictEqual(
    captureConfigAction(changed('secondarySimulator.autoConnect')),
    'none'
  );
});

check('logLevel / keyInput でも触れない', () => {
  assert.strictEqual(
    captureConfigAction(changed('secondarySimulator.logLevel')),
    'none'
  );
  assert.strictEqual(
    captureConfigAction(changed('secondarySimulator.keyInput')),
    'none'
  );
});

check('何も変わっていなければ触れない', () => {
  assert.strictEqual(captureConfigAction(changed()), 'none');
});

check('判定できないとき（イベント無し）は作り直す側に倒す', () => {
  assert.strictEqual(captureConfigAction(undefined), 'recreate');
});

console.log('\n3) 表示幅と操作状態に追従する取り込み設定');

const cfg = {fps: 30, maxWidth: 640, quality: 0.8};
const ctx = (over) =>
  Object.assign({viewportWidth: null, interacting: false, recording: false}, over);

check('未報告なら設定値のまま', () => {
  assert.deepStrictEqual(effectiveCaptureConfig(cfg, ctx()), {
    fps: 30,
    maxWidth: 640,
    quality: 0.8,
  });
});

check('狭いサイドバーには狭く送る', () => {
  assert.strictEqual(
    effectiveCaptureConfig(cfg, ctx({viewportWidth: 320})).maxWidth,
    320
  );
});

check('設定値が上限（広げても勝手に増やさない）', () => {
  assert.strictEqual(
    effectiveCaptureConfig(cfg, ctx({viewportWidth: 1800})).maxWidth,
    640
  );
});

check('極端に狭くても最低幅を割らない', () => {
  assert.strictEqual(
    effectiveCaptureConfig(cfg, ctx({viewportWidth: 20})).maxWidth,
    160
  );
});

check('操作中は 2 倍', () => {
  assert.strictEqual(effectiveCaptureConfig(cfg, ctx({interacting: true})).fps, 60);
});

check('操作中でも 60fps を超えない', () => {
  assert.strictEqual(
    effectiveCaptureConfig({...cfg, fps: 50}, ctx({interacting: true})).fps,
    60
  );
});

check('通常時は設定値のまま（今より遅くならない）', () => {
  for (const fps of [1, 10, 30, 60]) {
    assert.strictEqual(effectiveCaptureConfig({...cfg, fps}, ctx()).fps, fps);
  }
});

check('壊れた設定値でも 1fps を下回らない', () => {
  assert.strictEqual(effectiveCaptureConfig({...cfg, fps: 0}, ctx()).fps, 1);
  assert.strictEqual(effectiveCaptureConfig({...cfg, fps: NaN}, ctx()).fps, 1);
  assert.strictEqual(effectiveCaptureConfig({...cfg, fps: -5}, ctx()).fps, 1);
});

check('品質はそのまま通す', () => {
  assert.strictEqual(
    effectiveCaptureConfig({...cfg, quality: 0.3}, ctx({interacting: true})).quality,
    0.3
  );
});

console.log('\n4) 録画中は表示幅より粗くしない');

check('狭いサイドバーでも録画幅を割らない', () => {
  // 録画していなければ 320 まで落ちる（3 節）。録画中は落とさない
  assert.strictEqual(
    effectiveCaptureConfig(cfg, ctx({viewportWidth: 320, recording: true}))
      .maxWidth,
    RECORDING_WIDTH
  );
});

check('設定値が録画幅より小さくても上書きする', () => {
  // 既定の captureMaxWidth は 640。録画中だけは上限として扱わない
  assert.strictEqual(
    effectiveCaptureConfig({...cfg, maxWidth: 640}, ctx({recording: true}))
      .maxWidth,
    RECORDING_WIDTH
  );
});

check('表示が録画幅より広ければそちらに従う', () => {
  assert.strictEqual(
    effectiveCaptureConfig(
      {...cfg, maxWidth: 2000},
      ctx({viewportWidth: 1600, recording: true})
    ).maxWidth,
    1600
  );
});

check('録画中でも設定値の上限は超えない（設定 > 録画幅のとき）', () => {
  assert.strictEqual(
    effectiveCaptureConfig(
      {...cfg, maxWidth: 1200},
      ctx({viewportWidth: 1800, recording: true})
    ).maxWidth,
    1200
  );
});

check('録画を止めれば元の追従へ戻る', () => {
  assert.strictEqual(
    effectiveCaptureConfig(cfg, ctx({viewportWidth: 320, recording: false}))
      .maxWidth,
    320
  );
});

check('録画幅はサイドカーの 1 行上限（1MB）の内側に収まる大きさ', () => {
  // 実測 107KB / 1206px 幅（docs/sync-research.md §1.1）。面積比で見積もっても
  // base64 込みで 1MB には遠い。ここを上げるなら SimhidSidecar の蓋も見直すこと。
  const estimatedBytes = 107 * 1024 * (RECORDING_WIDTH / 1206) ** 2;
  assert.ok(
    (estimatedBytes * 4) / 3 < 1024 * 1024,
    `base64 で ${Math.round((estimatedBytes * 4) / 3 / 1024)}KB`
  );
});

check('fps の 2 倍は録画中も変わらない（幅だけの話）', () => {
  assert.strictEqual(
    effectiveCaptureConfig(cfg, ctx({recording: true, interacting: true})).fps,
    60
  );
});

console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
process.exit(failures === 0 ? 0 : 1);
