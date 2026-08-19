// 保存ダイアログの初期フォルダを検証する。
const path = require('node:path');
const {resolveSaveDirectory} = require('../out/simulator/SaveDirectory');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    failures++;
  }
}

const home = '/Users/me';

check(
  'workspace は開いているフォルダ',
  resolveSaveDirectory({
    saveLocation: 'workspace',
    customPath: '',
    workspaceFolder: '/proj',
    homeDir: home,
  }) === '/proj'
);
check(
  'workspace 未開きは home',
  resolveSaveDirectory({
    saveLocation: 'workspace',
    customPath: '',
    homeDir: home,
  }) === home
);
check(
  'desktop は ~/Desktop',
  resolveSaveDirectory({
    saveLocation: 'desktop',
    customPath: '',
    homeDir: home,
  }) === path.join(home, 'Desktop')
);
check(
  'custom は指定パス',
  resolveSaveDirectory({
    saveLocation: 'custom',
    customPath: '  /tmp/out  ',
    homeDir: home,
  }) === '/tmp/out'
);
check(
  'custom が空なら home',
  resolveSaveDirectory({
    saveLocation: 'custom',
    customPath: '   ',
    homeDir: home,
  }) === home
);

console.log(failures === 0 ? '\n全て成功' : `\n${failures} 件失敗`);
process.exit(failures === 0 ? 0 : 1);
