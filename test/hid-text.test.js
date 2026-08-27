// HID 経路のテキスト注入を検証する（実デバイス不要・偽サイドカーで代用）。
//
// サイドカーの injectText は **1 文字ずつ同期で待つ**（native/simhid-server.m。
// キーの間に 12ms、文字の間に 20ms）。応答は注入を終えてから返るので、
// 全コマンド共通の 3 秒で待つと **約 90 文字で必ず timeout していた** —— 注入は
// 続いているのに上位はエラー表示へ落ち、表示中のフレームまで捨てられる。
//
// ここでは「文字数に応じて待つ」「長い文字列を刻んで送る」の 2 つを見る。
const fs = require('fs');
const os = require('os');
const path = require('path');

require('./helpers/vscode-stub').install();

const ROOT = path.join(__dirname, '..');
const {SimhidSidecar} = require(path.join(ROOT, 'out/input/SimhidSidecar'));
const {HidSidecarBackend} = require(path.join(
  ROOT,
  'out/input/HidSidecarBackend'
));

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

/**
 * 1 文字あたり ms かけて応答する偽サイドカー。本物と同じく **1 本のキューで
 * 順に捌く**ので、長い text の間は次のコマンドも待たされる。
 */
function writeFakeSidecar(msPerChar) {
  const body = `
const lines = [];
let queue = Promise.resolve();
process.stdout.write(JSON.stringify({event: 'ready', pid: process.pid}) + '\\n');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const chars = typeof msg.value === 'string' ? msg.value.length : 0;
    queue = queue.then(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            process.stdout.write(
              JSON.stringify({id: msg.id, ok: true, chars}) + '\\n'
            );
            resolve();
          }, chars * ${msPerChar});
        })
    );
  }
});
`;
  const p = path.join(
    os.tmpdir(),
    `fake-simhid-text-${Date.now()}-${Math.random().toString(36).slice(2)}.js`
  );
  fs.writeFileSync(p, '#!/usr/bin/env node\n' + body, {mode: 0o755});
  return p;
}

async function main() {
  console.log('1) 待ち時間は文字数から決まる（純粋関数）');
  const base = HidSidecarBackend.textTimeoutMs(0);
  check('0 文字でも下駄がある', base >= 1000, String(base));
  check(
    '長いほど伸びる',
    HidSidecarBackend.textTimeoutMs(48) > HidSidecarBackend.textTimeoutMs(1),
    `${HidSidecarBackend.textTimeoutMs(1)} / ${HidSidecarBackend.textTimeoutMs(48)}`
  );
  // native の実測（32ms/文字、Shift 付きで 48ms）を下回ると、また timeout に戻る
  check(
    '1 チャンクぶんの見積りが実測を上回る',
    HidSidecarBackend.textTimeoutMs(HidSidecarBackend.TEXT_CHUNK_CHARS) >
      HidSidecarBackend.TEXT_CHUNK_CHARS * 48,
    String(HidSidecarBackend.textTimeoutMs(HidSidecarBackend.TEXT_CHUNK_CHARS))
  );
  check(
    '不正な長さでも下駄へ倒す',
    HidSidecarBackend.textTimeoutMs(NaN) === base &&
      HidSidecarBackend.textTimeoutMs(-5) === base
  );

  console.log('\n2) 3 秒を超える貼り付けが timeout しない');
  // 1 文字 30ms（実測とほぼ同じ）で 200 文字 = 6 秒。既定の 3 秒なら必ず落ちる長さ。
  const binary = writeFakeSidecar(30);
  const sidecar = new SimhidSidecar(binary);
  await sidecar.start();
  const backend = new HidSidecarBackend(sidecar, 'UDID-1');
  const value = 'a'.repeat(200);
  const started = Date.now();
  let error = null;
  try {
    await backend.text(value);
  } catch (e) {
    error = e;
  }
  const elapsed = Date.now() - started;
  check('reject しない', error === null, error && error.message);
  check(
    '実際に 3 秒より長くかかっている（見積りが効いている）',
    elapsed > 3000,
    `${elapsed}ms`
  );

  console.log('\n3) 刻んで送る（1 コマンドで入力全体を止めない）');
  const expected = Math.ceil(value.length / HidSidecarBackend.TEXT_CHUNK_CHARS);
  // 偽サイドカーは 1 コマンド 1 応答なので、送った回数は id の消費数で分かる
  check(
    `${expected} 回に分けて送る`,
    sidecar.nextId - 1 === expected,
    `id を ${sidecar.nextId - 1} 個消費`
  );
  check(
    '1 チャンクは 48 文字以内',
    HidSidecarBackend.TEXT_CHUNK_CHARS <= 48,
    String(HidSidecarBackend.TEXT_CHUNK_CHARS)
  );

  console.log('\n4) 短い文字列は 1 回で送る（刻みで往復を増やさない）');
  const before = sidecar.nextId;
  await backend.text('hello');
  check('1 コマンド', sidecar.nextId - before === 1, String(sidecar.nextId - before));

  console.log('\n5) 空文字は何も送らない');
  const beforeEmpty = sidecar.nextId;
  await backend.text('');
  check('送らない', sidecar.nextId === beforeEmpty);

  sidecar.dispose();
  fs.unlinkSync(binary);
}

main()
  .then(() => {
    console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
