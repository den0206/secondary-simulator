// mobilecli との JSON-RPC 層。**応答しないサーバで入力が止まり続けない**こと
// （既定の待機上限）と、失敗の文言に入力内容を載せないことを見る。
const assert = require('node:assert/strict');
const http = require('node:http');
const {test} = require('node:test');
const {JsonRpcClient} = require('../out/utils/JsonRpcClient');

/** 本文を受けて `handler` に任せるサーバ。 */
async function serve(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handler(JSON.parse(body), res));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {client: new JsonRpcClient(url), close: () => server.closeAllConnections() || server.close()};
}

test('既定の待機上限がある（無指定の入力 RPC も打ち切れる）', () => {
  assert.ok(JsonRpcClient.DEFAULT_TIMEOUT_MS > 0);
  assert.ok(JsonRpcClient.DEFAULT_TIMEOUT_MS <= 30_000);
});

test('応答しないサーバは指定時間で失敗し、次の要求は通る', async () => {
  let hang = true;
  const {client, close} = await serve((req, res) => {
    if (hang) return; // 返さない
    res.end(JSON.stringify({jsonrpc: '2.0', id: req.id, result: 'ok'}));
  });
  try {
    const started = Date.now();
    await assert.rejects(
      client.sendJsonRpcRequest('device.io.tap', {deviceId: 'D'}, 100),
      /timeout after 100ms for method: device\.io\.tap/
    );
    assert.ok(Date.now() - started < 2_000);
    hang = false;
    assert.equal(await client.sendJsonRpcRequest('device.io.tap', {deviceId: 'D'}), 'ok');
  } finally {
    close();
  }
});

test('失敗の文言にはメソッドと端末だけを載せ、送った文字は載せない', async () => {
  const {client, close} = await serve((req, res) => {
    res.end(JSON.stringify({jsonrpc: '2.0', id: req.id, error: {code: -1, message: 'boom'}}));
  });
  try {
    await assert.rejects(
      client.sendJsonRpcRequest('device.io.text', {deviceId: 'D', text: 'hunter2'}),
      (error) => {
        assert.match(error.message, /boom/);
        assert.match(error.message, /device\.io\.text, device: D/);
        assert.doesNotMatch(error.message, /hunter2/);
        return true;
      }
    );
  } finally {
    close();
  }
});

test('HTTP エラーは状態コードを伝える', async () => {
  const {client, close} = await serve((_req, res) => {
    res.statusCode = 500;
    res.end('down');
  });
  try {
    await assert.rejects(client.sendJsonRpcRequest('devices.list', {}), /status: 500/);
  } finally {
    close();
  }
});
