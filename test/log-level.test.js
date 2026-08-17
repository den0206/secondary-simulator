// secondarySimulator.logLevel がログ出力を絞ることを検証する。
//
// OutputChannel は VS Code が全文をメモリに持ち、古い行を捨てる API が無い
// （docs/project-review.md §3.5.7）。書く量を絞れることが CLAUDE.md の
// 「無制限に伸びる入れ物を作らない」を守る唯一の手段なので、ここは落とせない。
const path = require('path');

const lines = [];
let level = 'info'; // 設定の現在値。テスト中に差し替える。

require('./helpers/vscode-stub').install({
  window: {
    createOutputChannel: () => ({
      appendLine(line) {
        lines.push(line);
      },
      show() {},
      clear() {
        lines.length = 0;
      },
      dispose() {},
    }),
  },
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => (key === 'logLevel' ? level : fallback),
    }),
  },
});

const ROOT = path.join(__dirname, '..');
const {Logger} = require(path.join(ROOT, 'out/utils/Logger'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

/** 現在の設定で 4 段階すべてを書き、実際に出た段階を返す。 */
function emitAll() {
  lines.length = 0;
  Logger.error('e');
  Logger.warn('w');
  Logger.info('i');
  Logger.debug('d');
  return lines.map((l) => l.replace(/^\[[^\]]+\] \[([A-Z]+)\].*$/, '$1'));
}

console.log('1) 既定は info（debug を落とす）');
level = 'info';
Logger.initialize();
check('既定値が info', Logger.level === 'info', Logger.level);
check(
  'ERROR/WARN/INFO だけ出る',
  JSON.stringify(emitAll()) === JSON.stringify(['ERROR', 'WARN', 'INFO']),
  JSON.stringify(emitAll())
);

console.log('\n2) debug にすると全部出る');
level = 'debug';
Logger.refreshLevel();
check(
  'DEBUG まで出る',
  JSON.stringify(emitAll()) ===
    JSON.stringify(['ERROR', 'WARN', 'INFO', 'DEBUG']),
  JSON.stringify(emitAll())
);

console.log('\n3) 段階ごとに絞れる');
level = 'warn';
Logger.refreshLevel();
check(
  'warn は ERROR/WARN のみ',
  JSON.stringify(emitAll()) === JSON.stringify(['ERROR', 'WARN']),
  JSON.stringify(emitAll())
);

level = 'error';
Logger.refreshLevel();
check(
  'error は ERROR のみ',
  JSON.stringify(emitAll()) === JSON.stringify(['ERROR']),
  JSON.stringify(emitAll())
);

console.log('\n4) off は 1 行も書かない');
level = 'off';
Logger.refreshLevel();
check('何も出ない', emitAll().length === 0, JSON.stringify(emitAll()));
// error(message, error) の 2 行目（スタック）も抑止されること
lines.length = 0;
Logger.error('boom', new Error('stack'));
check('スタックも出ない', lines.length === 0, JSON.stringify(lines));

console.log('\n5) 未知の値は既定へ倒す');
level = 'verbose';
Logger.refreshLevel();
check('info として扱う', Logger.level === 'info', Logger.level);
check(
  'info 相当で出る',
  JSON.stringify(emitAll()) === JSON.stringify(['ERROR', 'WARN', 'INFO']),
  JSON.stringify(emitAll())
);

console.log('\n6) isEnabled が閾値と一致する');
level = 'warn';
Logger.refreshLevel();
check('warn は有効', Logger.isEnabled('warn'));
check('info は無効', !Logger.isEnabled('info'));
check('debug は無効', !Logger.isEnabled('debug'));

console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
process.exit(failures === 0 ? 0 : 1);
