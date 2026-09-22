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
const {
  SimulatorWebviewProvider,
} = require('../out/webview/SimulatorWebviewProvider');

/** 秒読みの途中で端末が変わる provider を組む。 */
function providerWithSwitchDuringCountdown(source) {
  const sent = [];
  const p = Object.create(SimulatorWebviewProvider.prototype);
  Object.assign(p, {
    currentDeviceId: 'a',
    devices: [{id: 'a', name: 'A', state: 'Booted'}],
    mobileCliClient: {startScreenRecord: async () => {}},
    recording: null,
    recordingBusy: false,
    recordingStart: null,
    viewRecordingMime: 'video/webm',
    view: {visible: true},
    postMessage: (m) => sent.push(m),
    recordingSource: () => source,
    canRecordView: () => true,
    defaultSaveDir: () => ({fsPath: '/tmp'}),
    prepareViewCapture: async () => {},
    releaseViewCapture: async () => {},
    // 秒読みのあいだに別の端末へ移る
    countdownBeforeRecording: async () => {
      p.currentDeviceId = 'b';
    },
  });
  return {p, sent};
}

test('秒読み中に端末が変わったら、録画ボタンを idle に戻す', async () => {
  for (const source of ['device', 'view']) {
    const {p, sent} = providerWithSwitchDuringCountdown(source);
    await p.toggleRecording();
    const phases = sent
      .filter((m) => m.type === 'recording')
      .map((m) => m.phase);
    assert.deepEqual(phases, ['starting', 'idle'], source);
    assert.equal(p.recording, null, source);
    assert.equal(p.recordingBusy, false, source);
  }
});
