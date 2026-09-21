const assert = require('node:assert/strict');
const {test, mock} = require('node:test');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const childProcess = require('node:child_process');
require('./helpers/vscode-stub').install();
const {MobileCliServer} = require('../out/utils/MobileCliServer');

function setup(t) {
  const children = [];
  mock.method(childProcess, 'spawn', (command, args) => {
    const proc = new EventEmitter();
    Object.assign(proc, {
      command, args, pid: children.length + 100, stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null, signalCode: null, killed: false,
      kill(signal) { this.killed = true; this.signalCode = signal; },
    });
    children.push(proc);
    return proc;
  });
  const server = new MobileCliServer();
  server.mobilecliPath = '/bundled/mobilecli';
  server.checkServerHealth = async () => false;
  server.isPortAvailable = async () => true;
  const timeout = MobileCliServer.SERVER_STARTUP_TIMEOUT_MS;
  const interval = MobileCliServer.SERVER_HEALTH_CHECK_INTERVAL_MS;
  MobileCliServer.SERVER_STARTUP_TIMEOUT_MS = 30;
  MobileCliServer.SERVER_HEALTH_CHECK_INTERVAL_MS = 1;
  t.after(() => {
    server.stopServer();
    MobileCliServer.SERVER_STARTUP_TIMEOUT_MS = timeout;
    MobileCliServer.SERVER_HEALTH_CHECK_INTERVAL_MS = interval;
    mock.restoreAll();
  });
  return {server, children};
}

test('startup timeout kills the child; Retry launches a fresh server', async (t) => {
  const {server, children} = setup(t);
  await assert.rejects(server.launchServer(), /ready/);
  assert.equal(children[0].killed, true);
  assert.equal(server.isServerRunning(), false);
  server.checkServerHealth = async () => children.length === 2;
  await server.launchServer();
  assert.equal(children.length, 2);
  assert.equal(server.isServerRunning(), true);
  // The old child's delayed close must not clear the replacement.
  children[0].emit('close', 1);
  assert.equal(server.getPid(), children[1].pid);
  assert.equal(server.isServerRunning(), true);
});

test('spawn errors retain the actual cause instead of a generic timeout', async (t) => {
  const {server, children} = setup(t);
  const launch = server.launchServer();
  await new Promise(setImmediate);
  children[0].emit('error', new Error('spawn npx ENOENT'));
  await assert.rejects(launch, /ENOENT/);
  assert.equal(server.isServerRunning(), false);
});

test('early exit reports stderr and exit code', async (t) => {
  const {server, children} = setup(t);
  const launch = server.launchServer();
  await new Promise(setImmediate);
  children[0].stderr.write('listen: address already in use');
  children[0].exitCode = 1;
  children[0].emit('close', 1);
  await assert.rejects(launch, /code 1.*address already in use/);
});

test('an unrelated service without /health does not count as a free port', async (t) => {
  const {server, children} = setup(t);
  server.isPortAvailable = async (port) => port !== 12000;
  server.checkServerHealth = async () => children.length > 0;
  await server.launchServer();
  assert.equal(server.getServerPort(), 12001);
  assert.ok(children[0].args.includes('localhost:12001'));
});

test('invalidated live child is health checked and replaced when unresponsive', async (t) => {
  const {server, children} = setup(t);
  server.checkServerHealth = async () => children.length > 0;
  await server.launchServer();
  server.invalidateServer();
  server.checkServerHealth = async () => children.length > 1;
  await server.launchServer();
  assert.equal(children[0].killed, true);
  assert.equal(children.length, 2);
});

test('concurrent callers share startup and stop cancels pending startup', async (t) => {
  const {server, children} = setup(t);
  const launch = server.launchServer();
  assert.equal(server.launchServer(), launch);
  await new Promise(setImmediate);
  server.stopServer();
  await assert.rejects(launch, /stopped/);
  assert.equal(children.length, 1);
  assert.equal(server.isServerRunning(), false);
});

test('stop during discovery prevents spawning a child afterwards', async (t) => {
  const {server, children} = setup(t);
  let release;
  const health = new Promise((resolve) => { release = resolve; });
  server.checkServerHealth = () => health;
  const launch = server.launchServer();
  server.stopServer();
  release(false);
  await assert.rejects(launch, /stopped/);
  assert.equal(children.length, 0);
});

test('healthy owned and compatible external servers are reused', async (t) => {
  const {server, children} = setup(t);
  server.checkServerHealth = async () => true;
  server.isRpcCompatible = async () => true;
  await server.launchServer();
  await server.launchServer();
  assert.equal(server.isServerRunning(), true);
  assert.equal(children.length, 0);
  server.serverReady = false;
  server.checkServerHealth = async () => children.length > 0;
  await server.launchServer();
  await server.launchServer();
  assert.equal(children.length, 1);
  assert.equal(children[0].killed, false);
});

test('TCP probe detects a service that returns HTTP 404 for /health', async (t) => {
  const service = require('node:http').createServer((_req, res) => {
    res.writeHead(404).end();
  });
  await new Promise((resolve) => service.listen(0, 'localhost', resolve));
  t.after(() => service.close());
  const port = service.address().port;
  const server = new MobileCliServer();
  assert.equal(await server.checkServerHealth(port), false);
  assert.equal(await server.isPortAvailable(port), false);
  await new Promise((resolve) => service.close(resolve));
  assert.equal(await server.isPortAvailable(port), true);
});
