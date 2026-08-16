// device.screenshot の応答デコードを検証する。
// 応答の形は mobilecli の版で変わるため、受け口を広げてあることを確かめる。
const assert = require('node:assert');
require('./helpers/vscode-stub').install();
const {
  decodeScreenshotResult,
  defaultScreenshotName,
} = require('../out/capture/Screenshot');

let failures = 0;
function check(name, ok, extra) {
  if (ok) {
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);

console.log('\n1) 応答の形を問わず取り出せる');
{
  const cases = [
    ['生の base64 文字列', PNG.toString('base64')],
    ['{data}', {data: PNG.toString('base64')}],
    ['{base64}', {base64: PNG.toString('base64')}],
    ['{image}', {image: PNG.toString('base64')}],
    ['{screenshot}', {screenshot: PNG.toString('base64')}],
    ['{content}', {content: PNG.toString('base64')}],
    ['{data:{data}}', {data: {data: PNG.toString('base64')}}],
    ['data URL', `data:image/png;base64,${PNG.toString('base64')}`],
  ];
  for (const [label, input] of cases) {
    let ok = false;
    let detail = '';
    try {
      const out = decodeScreenshotResult(input, 'png');
      ok = Buffer.from(out.bytes).equals(PNG) && out.ext === 'png';
      detail = out.ext;
    } catch (e) {
      detail = e.message;
    }
    check(`${label} から復元できる`, ok, detail);
  }
}

console.log('\n2) 拡張子はマジックナンバーで決める');
{
  const jpg = decodeScreenshotResult({data: JPG.toString('base64')}, 'png');
  check('JPEG なら要求が png でも jpg', jpg.ext === 'jpg', jpg.ext);
  const png = decodeScreenshotResult({data: PNG.toString('base64')}, 'jpeg');
  check('PNG なら要求が jpeg でも png', png.ext === 'png', png.ext);

  // 判別できないバイト列は要求した形式に従う
  const unknown = decodeScreenshotResult(
    {data: Buffer.from([1, 2, 3, 4]).toString('base64')},
    'jpeg'
  );
  check('判別不能なら要求形式を使う', unknown.ext === 'jpg', unknown.ext);

  const dataUrlJpeg = decodeScreenshotResult(
    `data:image/jpeg;base64,${JPG.toString('base64')}`
  );
  check('data URL の jpeg も jpg', dataUrlJpeg.ext === 'jpg', dataUrlJpeg.ext);
}

console.log('\n3) 想定外の応答は例外にする');
{
  const bad = [null, undefined, {}, {data: ''}, {other: 'x'}, 42, {data: 123}];
  let allThrew = true;
  let detail = '';
  for (const input of bad) {
    try {
      decodeScreenshotResult(input);
      allThrew = false;
      detail = JSON.stringify(input);
      break;
    } catch {
      /* 期待どおり */
    }
  }
  check('画像を取り出せない応答は例外', allThrew, detail);

  let emptyThrew = false;
  try {
    decodeScreenshotResult({data: Buffer.alloc(0).toString('base64')});
  } catch {
    emptyThrew = true;
  }
  check('空の画像は例外', emptyThrew);
}

console.log('\n4) 既定のファイル名');
{
  const at = new Date(2026, 7, 16, 9, 5, 3); // 2026-08-16 09:05:03（ローカル）
  const name = defaultScreenshotName('iPhone 17 Pro', 'png', at);
  check('端末名と日時を含む', name === 'iPhone_17_Pro-20260816-090503.png', name);
  check(
    'ファイル名に使えない文字を落とす',
    !/[/\\:*?"<>|]/.test(defaultScreenshotName('iPad/Pro:11"', 'jpg', at)),
    defaultScreenshotName('iPad/Pro:11"', 'jpg', at)
  );
  check(
    '名前が空でも成立する',
    defaultScreenshotName('///', 'png', at) === 'device-20260816-090503.png',
    defaultScreenshotName('///', 'png', at)
  );
}

assert.strictEqual(failures, 0, `${failures} 件のテストが失敗`);
console.log('\n全て成功');
