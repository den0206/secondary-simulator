// 録画を「始められなかった」経路で、webview を `starting` のまま置き去りにしない。
//
// Rec ボタンは `phase: 'starting'` のあいだ押せない（media/webview/main.js）。
// 秒読み中の端末切替や自動切断で中断したときに `idle` を送り直さないと、
// 表示したままのビューでは二度と録画を始められない（非表示にすれば webview が
// 作り直されて治るが、それは回復手段とは言えない）。
const assert = require('node:assert/strict');
const {test} = require('node:test');
const stub = require('./helpers/vscode-stub');
const base = stub.install();
// 保存ダイアログは「選んだ」で返す。ここで止まると本題（中断の後始末）を見られない。
base.window.showSaveDialog = async () => ({fsPath: '/tmp/rec.mp4'});
base.Uri = {joinPath: (dir, name) => ({fsPath: `${dir.fsPath}/${name}`})};
const {RecordingController} = require('../out/webview/RecordingController');

/** 秒読みの途中で端末が変わる録画を組む。 */
function recorderWithSwitchDuringCountdown(source) {
  const sent = [];
  let deviceId = 'a';
  const r = new RecordingController({
    currentDeviceId: () => deviceId,
    client: () => ({startScreenRecord: async () => {}}),
    deviceName: () => 'A',
    hasView: () => true,
    isVisible: () => true,
    post: (m) => sent.push(m),
    defaultSaveDir: () => ({fsPath: '/tmp'}),
    prepareViewCapture: async () => {},
    releaseViewCapture: async () => {},
  });
  r.viewMime = 'video/webm';
  r.source = () => source;
  // 秒読みのあいだに別の端末へ移る
  r.countdown = async () => {
    deviceId = 'b';
  };
  return {r, sent};
}

test('秒読み中に端末が変わったら、録画ボタンを idle に戻す', async () => {
  for (const source of ['device', 'view']) {
    const {r, sent} = recorderWithSwitchDuringCountdown(source);
    await r.toggle();
    const phases = sent
      .filter((m) => m.type === 'recording')
      .map((m) => m.phase);
    assert.deepEqual(phases, ['starting', 'idle'], source);
    assert.equal(r.active, false, source);
    assert.equal(r.isBusy, false, source);
  }
});
