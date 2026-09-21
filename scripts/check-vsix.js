// Check the archive users install, not the developer's node_modules.
// Packaging runs on macOS/Linux, where unzip is available.
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const archive = process.argv[2];
assert.ok(archive, 'Usage: node scripts/check-vsix.js <file.vsix>');
const files = new Set(execFileSync('unzip', ['-Z1', archive], {encoding: 'utf8'}).trim().split('\n'));
const read = (file) => execFileSync('unzip', ['-p', archive, `extension/${file}`], {encoding: 'utf8'});
const pkg = JSON.parse(read('package.json'));
const mobilecli = JSON.parse(read('node_modules/mobilecli/package.json'));
assert.equal(mobilecli.version, pkg.dependencies.mobilecli);
for (const file of [pkg.main.replace(/^\.\//, ''), 'native/simhid-server',
  'media/webview/index.html', 'media/webview/main.js', 'media/webview/style.css',
  'THIRD-PARTY-NOTICES.md']) {
  assert.ok(files.has(`extension/${file}`), `Missing ${file}`);
}
for (const [name, version] of Object.entries(mobilecli.optionalDependencies)) {
  const dir = `node_modules/${name}`;
  const binary = name.split('/')[1] + (name.includes('-windows-') ? '.exe' : '');
  assert.ok(files.has(`extension/${dir}/${binary}`), `Missing ${binary}`);
  assert.equal(JSON.parse(read(`${dir}/package.json`)).version, version);
}
assert.ok(![...files].some((file) => /(^|\/)\.env(?:\.|$)/.test(file)), 'Packaged .env');
console.log(`VSIX verified: ${mobilecli.version}, all ${Object.keys(mobilecli.optionalDependencies).length} platform binaries`);
