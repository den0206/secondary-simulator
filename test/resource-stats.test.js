// ResourceStats: ディレクトリサイズ集計と統計取得を検証する（実デバイス不要）。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const {
  dirSizeBytes,
  collectResourceStats,
} = require(path.join(ROOT, 'out/utils/ResourceStats'));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'res-stats-'));
  fs.writeFileSync(path.join(tmp, 'a.bin'), Buffer.alloc(1000));
  fs.mkdirSync(path.join(tmp, 'sub'));
  fs.writeFileSync(path.join(tmp, 'sub', 'b.bin'), Buffer.alloc(2000));
  fs.symlinkSync(path.join(tmp, 'a.bin'), path.join(tmp, 'link.bin'));
  fs.mkdirSync(path.join(tmp, '.git'));
  fs.writeFileSync(path.join(tmp, '.git', 'objects'), Buffer.alloc(10000));
  fs.mkdirSync(path.join(tmp, 'node_modules', 'mobilecli'), {recursive: true});
  fs.writeFileSync(path.join(tmp, 'node_modules', 'mobilecli', 'bin'), Buffer.alloc(400));
  fs.mkdirSync(path.join(tmp, 'node_modules', 'typescript'), {recursive: true});
  fs.writeFileSync(path.join(tmp, 'node_modules', 'typescript', 'lib.js'), Buffer.alloc(8000));

  // 再帰で合計する。symlink / .git / 開発用 node_modules は含めない。
  assert.strictEqual(await dirSizeBytes(tmp), 3400);

  // 計測に失敗しても落ちず、0 をキャッシュしない
  const missing = path.join(tmp, 'nope');
  assert.strictEqual((await collectResourceStats(missing, [])).storageMb, 0);

  // 自分自身の pid を渡せば ps 経由で RSS が取れる（Windows は 0）
  fs.writeFileSync(path.join(tmp, 'big.bin'), Buffer.alloc(300 * 1024));
  const stats = await collectResourceStats(tmp, [process.pid]);
  assert.ok(stats.rssMb > 0, 'rssMb');
  assert.ok(stats.heapUsedMb > 0, 'heapUsedMb');
  // 前回失敗をキャッシュしていれば 0 のまま。測り直せているので > 0。
  assert.ok(stats.storageMb > 0, 'storageMb 再試行');
  if (process.platform !== 'win32') {
    assert.ok(stats.childrenMb > 0, 'childrenMb');
  }
  // 存在しない pid でも落ちない
  assert.strictEqual((await collectResourceStats(tmp, [])).childrenMb, 0);

  fs.rmSync(tmp, {recursive: true, force: true});
  console.log('全て成功');
})().catch((e) => {
  console.error('テストが例外で終了', e);
  process.exit(1);
});
