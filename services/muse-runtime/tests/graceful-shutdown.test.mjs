import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createBrokerShutdown } from '../graceful-shutdown.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

for (const path of ['/ensure', '/stop']) {
  test(`shutdown waits for an accepted ${path} request and its serialized Docker operation`, async () => {
    const accepted = deferred(), operation = deferred();
    const pending = new Map();
    let serial = Promise.resolve(), accepting = true, finished = false;
    const server = http.createServer(async (request, response) => {
      if (!accepting) { response.writeHead(503); response.end(); return; }
      const work = serial.then(() => operation.promise);
      serial = work.catch(() => {});
      if (request.url === '/ensure') pending.set('account', work);
      accepted.resolve();
      await work;
      pending.delete('account');
      response.end('{}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}${path}`;
    const response = fetch(url, { method: 'POST' }).then(result => result.text());
    await accepted.promise;
    const close = createBrokerShutdown({ server, operations: () => [...pending.values(), serial], stopAccepting: () => { accepting = false; } });
    const closing = close().then(() => { finished = true; });
    assert.equal(close(), close());
    assert.equal(accepting, false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    await assert.rejects(fetch(url, { method: 'POST' }));
    operation.resolve();
    assert.equal(await response, '{}');
    await closing;
    assert.equal(finished, true);
    assert.equal(server.listening, false);
  });
}

test('a rejected accepted operation still reaches quiescence', async () => {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const close = createBrokerShutdown({ server, operations: () => [Promise.reject(new Error('Docker operation failed'))], stopAccepting() {} });
  await close();
  assert.equal(server.listening, false);
});
