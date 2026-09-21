// npm installs only the host platform; the universal VSIX needs every supported binary.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const version = require('../package.json').dependencies.mobilecli;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mobilecli-'));
try {
  for (const name of Object.keys(require('mobilecli/package.json').optionalDependencies)) {
    const dir = path.resolve(__dirname, '..', 'node_modules', name);
    const packs = JSON.parse(execFileSync('npm', [
      'pack', `${name}@${version}`, '--ignore-scripts', '--json', '--pack-destination', temp,
    ], {encoding: 'utf8'}));
    fs.mkdirSync(dir, {recursive: true});
    execFileSync('tar', ['-xzf', path.join(temp, packs[0].filename), '-C', dir, '--strip-components=1']);
  }
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}
