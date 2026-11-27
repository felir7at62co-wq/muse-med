/** Offline HTTP fixtures for MediaKit admission and task lookup. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {createMediaKitProvider} from './mediakit-provider.mjs';

const endpoint = 'https://mediakit.cn-beijing.volces.com/api/v1';
const apiKey = 'test-key-not-a-real-credential';
const source = 'https://source.example.com/clip.mp4?signature=source-fixture';
const resultUrl = 'https://out.example.com/result.mp4?signature=output-fixture';
const upscale = {operation: 'upscale', videoUrl: source, resolution: '1080p', clientToken: 'muse-fixture-001'};
const erase = {operation: 'erase_subtitle', videoUrl: source, clientToken: 'muse-fixture-002'};
const upscaleTask = 'amk-tool-enhance-video-generative-123';
const eraseTask = 'amk-tool-erase-video-subtitle-pro-456';
const invalidResponse = {state: 'unknown', code: 'MEDIAKIT_INVALID_RESPONSE'};

function fixture(answer, options = {}) {
  const calls = [];
  const provider = createMediaKitProvider({
    apiKey,
    timeoutMs: 1000,
    ...options,
    fetchImpl: async (url, init) => {
      calls.push({url, init});
      return answer();
    },
  });
  return {calls, provider};
}

test('submits HD enhancement with the requested resolution and provider idempotency token', async () => {
  const {calls, provider} = fixture(() => Response.json({success: true, task_id: upscaleTask}), {queueId: 'qfixture'});
  assert.deepEqual(await provider.submit(upscale), {state: 'accepted', taskId: upscaleTask});
  assert.equal(calls.length, 1);
  const [{url, init}] = calls;
  assert.equal(url, endpoint + '/tools/enhance-video-generative');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.headers.Authorization, 'Bearer ' + apiKey);
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), {
    video_url: source,
    client_token: 'muse-fixture-001',
    queue_id: 'qfixture',
    resolution: '1080p',
  });
});

test('submits subtitle erasure with the documented v5 model and default queue', async () => {
  const {calls, provider} = fixture(() => Response.json({success: true, task_id: eraseTask}));
  assert.deepEqual(await provider.submit(erase), {state: 'accepted', taskId: eraseTask});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, endpoint + '/tools/erase-video-subtitle-pro');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    video_url: source,
    client_token: 'muse-fixture-002',
    model_version: 'v5',
    mode: 'Subtitle',
  });
});

test('rejects invalid local operation, URL, resolution and client token without dispatch', async () => {
  const {calls, provider} = fixture(() => assert.fail('unexpected dispatch'));
  for (const input of [
    {...upscale, operation: 'unknown'},
    {...upscale, videoUrl: 'http://source.example.com/clip.mp4'},
    {...upscale, videoUrl: 'https://user:password@source.example.com/clip.mp4'},
    {...upscale, videoUrl: source + '\n'},
    {...upscale, resolution: '4k'},
    {...upscale, clientToken: 'x'.repeat(65)},
    {...upscale, clientToken: 'test\n'},
    {...erase, resolution: '1080p'},
  ]) {
    assert.deepEqual(await provider.submit(input), {state: 'rejected', code: 'MEDIAKIT_INVALID_ARGUMENT'});
  }
  assert.equal(calls.length, 0);
});

test('classifies documented rejection envelopes without exposing provider detail', async () => {
  const detail = source + ' API key ' + apiKey;
  for (const [body, status, code] of [
    [{success: false, task_id: '', error: {code: 'InvalidParameter', message: detail}}, 200, 'MEDIAKIT_INVALID_ARGUMENT'],
    [{success: false, error: {code: 'MissingParameter', message: detail}}, 400, 'MEDIAKIT_INVALID_ARGUMENT'],
    [{code: 'AuthenticationError', message: detail}, 401, 'MEDIAKIT_AUTHENTICATION_REQUIRED'],
    [{code: 'AccessDenied', message: detail}, 403, 'MEDIAKIT_PERMISSION_DENIED'],
    [{code: 'RequestLimitExceeded', message: detail}, 429, 'MEDIAKIT_RATE_LIMITED'],
  ]) {
    const {calls, provider} = fixture(() => Response.json(body, {status}));
    assert.deepEqual(await provider.submit(upscale), {state: 'rejected', code});
    assert.equal(calls.length, 1);
  }
});

test('keeps invalid, conflicting, or ambiguous submission responses unknown', async () => {
  for (const answer of [
    () => new Response('<html>provider returned an error page</html>', {status: 403}),
    () => new Response('x'.repeat(64 * 1024 + 1)),
    () => Response.json({success: true}),
    () => Response.json({success: true, task_id: ''}),
    () => Response.json({success: true, task_id: '../other'}),
    () => Response.json({success: false, code: 'InvalidParameter'}, {status: 400}),
    () => Response.json({success: false, task_id: upscaleTask, error: {code: 'InvalidParameter'}}, {status: 400}),
    () => Response.json({code: 'AuthenticationError'}, {status: 500}),
    () => Response.json({success: false, error: {code: 'InternalServiceTimeout'}}, {status: 504}),
    () => Response.json({success: false, error: {code: 'UnclassifiedError'}}, {status: 400}),
  ]) {
    const {calls, provider} = fixture(answer);
    assert.deepEqual(await provider.submit(upscale), invalidResponse);
    assert.equal(calls.length, 1);
  }
});

test('timeout and unreadable response bodies do not trigger a second submission', async () => {
  const transportFailure = {state: 'unknown', code: 'MEDIAKIT_TRANSPORT'};
  for (const answer of [
    () => { throw new DOMException(source, 'TimeoutError'); },
    () => new Response(new ReadableStream({start(controller) { controller.error(Error(source)); }})),
  ]) {
    const {calls, provider} = fixture(answer);
    assert.deepEqual(await provider.submit(upscale), transportFailure);
    assert.equal(calls.length, 1);
  }
});

test('queries the matching task and returns its signed output unchanged', async () => {
  const {calls, provider} = fixture(() => Response.json({
    success: true, task_id: eraseTask, status: 'completed', result: {video_url: resultUrl},
  }));
  assert.deepEqual(await provider.query(eraseTask), {state: 'completed', videoUrl: resultUrl});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, endpoint + '/tasks/' + eraseTask);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ' + apiKey);
  assert.equal(calls[0].init.body, undefined);
});

test('keeps task state separate from the result of the status request', async () => {
  for (const [body, status, disposition] of [
    [{success: true, task_id: upscaleTask, status: 'running'}, 200, {state: 'pending'}],
    [{success: true, task_id: upscaleTask, status: 'failed', error: {message: source}}, 200,
      {state: 'failed', code: 'MEDIAKIT_TASK_FAILED'}],
    [{code: 'TaskCanceled'}, 410, {state: 'failed', code: 'MEDIAKIT_TASK_CANCELED'}],
    [{success: false, task_id: upscaleTask, status: 'failed'}, 200, invalidResponse],
    [{success: true, task_id: eraseTask, status: 'failed'}, 200, invalidResponse],
    [{success: true, task_id: upscaleTask, status: 'scheduled'}, 200, invalidResponse],
    [{success: true, task_id: upscaleTask, status: 'completed'}, 200, invalidResponse],
    [{success: true, task_id: upscaleTask, status: 'completed', result: {video_url: 'http://out.example.com/result.mp4'}},
      200, invalidResponse],
    [{success: true, task_id: upscaleTask, status: 'completed', result: {video_url: 'https://u:p@out.example.com/r.mp4'}},
      200, invalidResponse],
  ]) {
    const {provider} = fixture(() => Response.json(body, {status}));
    assert.deepEqual(await provider.query(upscaleTask), disposition);
  }
});

test('does not send a query using an invalid path segment', async () => {
  const {calls, provider} = fixture(() => assert.fail('unexpected dispatch'));
  assert.deepEqual(await provider.query('../tasks'), {state: 'unknown', code: 'MEDIAKIT_INVALID_ARGUMENT'});
  assert.equal(calls.length, 0);
});

test('rejects malformed server credentials and timeout without printing them', () => {
  const badOptions = [
    {apiKey: apiKey + '\r\nCustom-Header: secret', timeoutMs: 1000},
    {apiKey, timeoutMs: 0},
    {apiKey, timeoutMs: 2_147_483_648},
    {apiKey, timeoutMs: 1000, queueId: ''},
  ];
  for (const options of badOptions) {
    assert.throws(() => createMediaKitProvider(options), {message: 'Invalid MediaKit provider configuration'});
  }
});
