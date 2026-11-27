/** Account gateway fixtures for MediaKit pilot admission and result access. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createAccountServer} from './gateway.mjs';
import {loadMediaKitPilot} from './mediakit-http.mjs';
import {openStore} from './store.mjs';

const origin = 'https://muse.test';
const source = 'https://clips.example.com/shots/test.mp4?signature=synthetic-source';
const resultOrigin = 'https://results.example.com';
const videoUrl = resultOrigin + '/result.mp4?signature=synthetic-download';
const apiKey = 'synthetic-key-for-tests';
const fixturePassword = 'synthetic-password';
const path = '/api/media-postprocess';
const request = {operation: 'upscale', scriptId: 7, taskId: 19, videoUrl: source, resolution: '1080p'};
const eraseRequest = {operation: 'erase_subtitle', scriptId: 7, taskId: 19, videoUrl: source};
const taskId = 'amk-tool-test-02a';
const sourceHeaders = {'x-jubian-token': 'synthetic-jubian-token'};

function defaultConfig(value) {
  value.approvals = [];
  value.defaultRouting = {
    sourceOrigins: ['https://clips.example.com'], maxDailyJobs: 2, maxSourceSeconds: 60,
    centsPerMinute: {upscale720p: 250, upscale1080p: 500, eraseSubtitle: 100},
  };
}

function verifiedSource(url, init) {
  assert.equal(init.headers.get?.('authorization') ?? init.headers.authorization ?? init.headers.Authorization,
    'Bearer ' + sourceHeaders['x-jubian-token']);
  const endpoint = new URL(url);
  const id = Number(endpoint.pathname.split('/').at(-1));
  if (endpoint.pathname.includes('/aigc/script/')) return Response.json({code: 200, data: {id}});
  if (init.method === 'GET') return Response.json({code: 200, data: {id, scriptId: request.scriptId}});
  const {aigcVideoTaskId} = JSON.parse(init.body);
  return Response.json({code: 200, data: {total: 1, rows: [{id: 133, aigcVideoTaskId, taskStatus: 'succeeded',
    duration: 20.06, resultList: [{tosVideoUrl: source}]}]}});
}

/** Build the same private file an enabled test gateway reads in deployment. */
function config(root, accountId) {
  return {
    apiKey,
    receiptDirectory: join(root, 'jobs'),
    timeoutMs: 1000,
    resultOrigins: [resultOrigin],
    approvals: [{
      accountId,
      scriptId: 7,
      taskId: 19,
      sourceOrigin: 'https://clips.example.com',
      sourcePath: '/shots/test.mp4',
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      operations: {
        upscale: {resolution: '1080p', priceCny: '1.50'},
        erase_subtitle: {priceCny: '0.30'},
      },
    }],
  };
}

async function fixture(t, {
  enabled = true,
  configure = () => {},
  submit = () => Response.json({success: true, task_id: taskId}),
  query = () => Response.json({success: true, task_id: taskId, status: 'completed', result: {video_url: videoUrl}}),
  sourceFetch,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'muse-mediakit-http-'));
  let server;
  t.after(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await rm(root, {recursive: true, force: true});
  });
  const store = await openStore(join(root, 'accounts.json'));
  const alice = await store.create('alice', fixturePassword);
  await store.create('bob', fixturePassword);
  const settings = config(root, alice.id);
  configure(settings);
  const configFile = join(root, 'mediakit.json');
  await writeFile(configFile, JSON.stringify(settings), {mode: 0o600});
  const calls = [];
  const reload = async () => await loadMediaKitPilot(enabled ? configFile : undefined, {
    sourceFetch,
    fetchImpl: async (url, init) => {
      calls.push({url, init});
      return init.method === 'POST' ? submit() : query();
    },
  });
  server = createAccountServer({store, mediaKit: await reload(), publicOrigin: origin, devOnlyAdmin: false});
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const tokens = new Map();
  for (const username of ['alice', 'bob']) {
    const response = await fetch(base + '/login', {
      method: 'POST', headers: {origin}, redirect: 'manual',
      body: new URLSearchParams({username, password: fixturePassword}),
    });
    assert.equal(response.status, 303);
    const cookie = response.headers.get('set-cookie').split(';', 1)[0];
    tokens.set(username, cookie.slice(cookie.indexOf('=') + 1));
  }
  return {
    calls, store, alice, server, settings, configFile, reload,
    call(suffix, {username = 'alice', input, method = input === undefined ? 'GET' : 'POST', headers = {}, body} = {}) {
      const token = tokens.get(username);
      return fetch(base + path + suffix, {
        method, redirect: 'manual',
        headers: {
          ...(token ? {authorization: 'Bearer ' + token} : {}),
          ...(input === undefined ? {} : {origin, 'content-type': 'application/json'}),
          ...headers,
        },
        body: body ?? (input === undefined ? undefined : JSON.stringify(input)),
      });
    },
  };
}

test('enabled pilot authenticates API users and isolates jobs and prices by account', async t => {
  const env = await fixture(t);
  const anonymous = await env.call('/preview', {username: null, input: request});
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), {code: 'account_session_expired'});
  const crossOrigin = await env.call('/preview', {input: request, headers: {origin: 'https://external.test'}});
  assert.equal(crossOrigin.status, 403);
  const withoutOrigin = await env.call('/preview', {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(request),
  });
  assert.equal(withoutOrigin.status, 403);
  const unrelated = await env.call('/preview', {username: 'bob', input: request});
  assert.deepEqual(await unrelated.json(), {state: 'ineligible'});
  const preview = await env.call('/preview', {input: request});
  const {jobKey} = await preview.json();
  assert.match(jobKey, /^[a-f0-9]{64}$/u);
  assert.deepEqual(await (await env.call('/preview', {input: request})).json(), {
    state: 'ready', jobKey, amount: '1.50', unit: 'CNY',
  });
  assert.equal(preview.headers.get('cache-control'), 'no-store');
  assert.equal(env.calls.length, 0);
  assert.deepEqual(await (await env.call('/jobs', {username: 'bob', input: {...request, jobKey}})).json(), {
    state: 'conflict', code: 'preview_mismatch',
  });
  assert.deepEqual(await (await env.call('/jobs', {input: {...request, jobKey}})).json(), {state: 'accepted'});
  assert.equal(env.calls.length, 1);
  assert.match(env.calls[0].url, /\/enhance-video-generative$/u);
  assert.equal(env.calls[0].init.headers.Authorization, 'Bearer ' + apiKey);
  assert.deepEqual(await (await env.call('/jobs/' + jobKey, {username: 'bob'})).json(), {state: 'not_found'});
  assert.deepEqual(await (await env.call('/jobs/' + jobKey + '/fallback', {method: 'POST', headers: {origin}})).json(), {claimed: false});
  assert.equal(env.calls.length, 1);
  const finished = await env.call('/jobs/' + jobKey);
  assert.deepEqual(await finished.json(), {state: 'completed', videoUrl, downloadOrigin: resultOrigin});
  assert.equal(finished.headers.get('cache-control'), 'no-store');
  assert.equal(env.calls.length, 2);
});

test('clips must match the approved identity, canonical URL digest, operation and resolution', async t => {
  const env = await fixture(t);
  for (const input of [
    {...request, scriptId: 8},
    {...request, taskId: 18},
    {...request, resolution: '720p'},
    {...request, videoUrl: 'https://other.example.com/shots/test.mp4?signature=synthetic-source'},
    {...request, videoUrl: source + '&changed=yes'},
    {...request, videoUrl: source.replace('/shots/test.mp4', '/shots/alternate.mp4')},
    {...request, videoUrl: source.replace('/shots/test.mp4', '/shots/../shots/test.mp4')},
  ]) {
    const response = await env.call('/preview', {input});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {state: 'ineligible'});
  }
  const first = await (await env.call('/preview', {input: request})).json();
  const second = await (await env.call('/preview', {input: eraseRequest})).json();
  assert.notEqual(first.jobKey, second.jobKey);
  assert.equal(second.amount, '0.30');
  assert.deepEqual(await (await env.call('/jobs', {input: {...request, jobKey: second.jobKey}})).json(), {
    state: 'conflict', code: 'preview_mismatch',
  });
  assert.equal(env.calls.length, 0);
});

test('repeated and concurrent submit requests have one provider attempt per approved operation', async t => {
  const entered = Promise.withResolvers();
  const answer = Promise.withResolvers();
  t.after(() => answer.resolve(Response.json({success: true, task_id: taskId})));
  const env = await fixture(t, {
    submit: () => { entered.resolve(); return answer.promise; },
  });
  const {jobKey} = await (await env.call('/preview', {input: request})).json();
  const input = {...request, jobKey};
  const first = env.call('/jobs', {input});
  await entered.promise;
  try {
    assert.deepEqual(await (await env.call('/jobs', {input: {...input, jobKey: 'c'.repeat(64)}})).json(), {
      state: 'conflict', code: 'preview_mismatch',
    });
    assert.deepEqual(await (await env.call('/jobs', {input})).json(), {state: 'unknown', code: 'submission_unconfirmed'});
    assert.deepEqual(await (await env.call('/jobs/' + jobKey)).json(), {state: 'unknown', code: 'submission_unconfirmed'});
    assert.deepEqual(await (await env.call('/jobs/' + jobKey + '/fallback', {method: 'POST', headers: {origin}})).json(), {claimed: false});
    assert.equal(env.calls.length, 1);
  } finally {
    answer.resolve(Response.json({success: true, task_id: taskId}));
  }
  assert.deepEqual(await (await first).json(), {state: 'accepted'});
  assert.deepEqual(await (await env.call('/jobs', {input})).json(), {state: 'accepted'});
  assert.equal(env.calls.length, 1);
});

test('definitive rejection is replayed without another paid-provider attempt', async t => {
  const env = await fixture(t, {
    submit: () => Response.json({success: false, error: {code: 'InvalidParameter', message: source}}, {status: 400}),
  });
  const {jobKey} = await (await env.call('/preview', {input: eraseRequest})).json();
  const rejected = {state: 'rejected', code: 'MEDIAKIT_INVALID_ARGUMENT'};
  assert.deepEqual(await (await env.call('/jobs', {input: {...eraseRequest, jobKey}})).json(), rejected);
  assert.deepEqual(await (await env.call('/jobs', {input: {...eraseRequest, jobKey}})).json(), rejected);
  assert.deepEqual(await (await env.call('/jobs/' + jobKey)).json(), rejected);
  assert.equal(env.calls.length, 1);
  assert.match(env.calls[0].url, /\/erase-video-subtitle-pro$/u);
});

test('one authenticated caller can claim the legacy fallback after proven rejection', async t => {
  const env = await fixture(t, {
    submit: () => Response.json({success: false, error: {code: 'InvalidParameter', message: source}}, {status: 400}),
  });
  const {jobKey} = await (await env.call('/preview', {input: eraseRequest})).json();
  const route = '/jobs/' + jobKey + '/fallback';
  const post = {method: 'POST', headers: {origin}};
  const absent = await env.call(route, post);
  assert.equal(absent.status, 200);
  assert.deepEqual(await absent.json(), {claimed: false});
  const submit = await env.call('/jobs', {input: {...eraseRequest, jobKey}});
  assert.deepEqual(await submit.json(), {state: 'rejected', code: 'MEDIAKIT_INVALID_ARGUMENT'});
  assert.equal((await env.call(route, {...post, username: null})).status, 401);
  assert.equal((await env.call(route, {...post, headers: {origin: 'https://external.test'}})).status, 403);
  const wrongMethod = await env.call(route);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');
  const otherAccount = await env.call(route, {...post, username: 'bob'});
  assert.equal(otherAccount.status, 200);
  assert.deepEqual(await otherAccount.json(), {claimed: false});
  const requests = await Promise.all([env.call(route, post), env.call(route, post), env.call(route, post)]);
  assert.deepEqual(requests.map(response => response.status), [200, 200, 200]);
  assert.deepEqual(requests.map(response => response.headers.get('cache-control')), ['no-store', 'no-store', 'no-store']);
  const responses = await Promise.all(requests.map(response => response.json()));
  assert.equal(responses.filter(value => value.claimed === true).length, 1);
  assert.equal(responses.filter(value => value.claimed === false).length, 2);
  assert.deepEqual(await (await env.call(route, post)).json(), {claimed: false});
  assert.deepEqual(await (await env.call('/jobs/' + jobKey)).json(), {state: 'rejected', code: 'MEDIAKIT_INVALID_ARGUMENT'});
  assert.equal(env.calls.length, 1);
});

test('changed media and approval withdrawal cannot hide a recorded direct submission from its owner', async t => {
  const env = await fixture(t);
  const {jobKey} = await (await env.call('/preview', {input: request})).json();
  assert.deepEqual(await (await env.call('/jobs', {input: {...request, jobKey}})).json(), {state: 'accepted'});
  const rotated = {...request, videoUrl: source + '&replacement=signature'};
  const changed = await env.call('/preview', {input: rotated});
  assert.equal(changed.status, 409);
  assert.deepEqual(await changed.json(), {code: 'existing_media_processing'});
  assert.deepEqual(await (await env.call('/preview', {input: rotated, username: 'bob'})).json(), {state: 'ineligible'});
  assert.deepEqual(await (await env.call('/jobs', {input: {...rotated, jobKey}})).json(), {
    state: 'conflict', code: 'preview_mismatch',
  });

  env.settings.approvals[0].sourceSha256 = createHash('sha256').update(rotated.videoUrl).digest('hex');
  await writeFile(env.configFile, JSON.stringify(env.settings));
  const rotatedPolicy = await env.reload();
  assert.deepEqual(await rotatedPolicy.preview(env.alice.id, rotated), {state: 'blocked'});
  env.settings.approvals = [];
  await writeFile(env.configFile, JSON.stringify(env.settings));
  const recoveryOnly = await env.reload();
  assert.deepEqual(await recoveryOnly.preview(env.alice.id, request), {state: 'blocked'});
  assert.deepEqual(await recoveryOnly.preview(env.alice.id, {...request, taskId: 20}), {state: 'ineligible'});
  assert.equal(await recoveryOnly.claimFallback(env.alice.id, jobKey), false);
  assert.deepEqual(await recoveryOnly.inspect('b'.repeat(16), jobKey), {state: 'not_found'});
  assert.deepEqual(await recoveryOnly.inspect(env.alice.id, jobKey), {state: 'completed', videoUrl, downloadOrigin: resultOrigin});
  assert.equal(env.calls.length, 2);
  assert.equal(env.calls.filter(call => call.init.method === 'POST').length, 1);
});

test('the gateway withholds an unapproved output origin without returning the signed address', async t => {
  const env = await fixture(t, {
    query: () => Response.json({
      success: true, task_id: taskId, status: 'completed',
      result: {video_url: 'https://results.example.com.external.test/out.mp4?signature=synthetic-download'},
    }),
  });
  const {jobKey} = await (await env.call('/preview', {input: request})).json();
  await env.call('/jobs', {input: {...request, jobKey}});
  assert.deepEqual(await (await env.call('/jobs/' + jobKey)).json(), {
    state: 'unknown', code: 'MEDIAKIT_RESULT_ORIGIN_UNAPPROVED',
  });
});

test('revoking the account during a provider query prevents delivery of the signed result', async t => {
  const entered = Promise.withResolvers();
  const answer = Promise.withResolvers();
  t.after(() => answer.resolve(Response.json({success: true, task_id: taskId, status: 'running'})));
  const env = await fixture(t, {query: () => { entered.resolve(); return answer.promise; }});
  const {jobKey} = await (await env.call('/preview', {input: request})).json();
  await env.call('/jobs', {input: {...request, jobKey}});
  const lookup = env.call('/jobs/' + jobKey);
  await entered.promise;
  try {
    await env.store.setDisabled(env.alice.id, true);
  } finally {
    answer.resolve(Response.json({success: true, task_id: taskId, status: 'completed', result: {video_url: videoUrl}}));
  }
  const response = await lookup;
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {code: 'account_session_expired'});
});

test('disabled, draining, invalid, and rate-limited routes admit no provider calls', async t => {
  const disabled = await fixture(t, {enabled: false});
  assert.equal((await disabled.call('/preview', {input: request})).status, 404);
  assert.equal(disabled.calls.length, 0);
  const drained = await fixture(t);
  const {jobKey} = await (await drained.call('/preview', {input: request})).json();
  drained.server.stopAdmission();
  assert.deepEqual(await (await drained.call('/jobs', {input: {...request, jobKey}})).json(), {code: 'server_draining'});
  assert.deepEqual(await (await drained.call('/jobs/' + jobKey + '/fallback', {method: 'POST', headers: {origin}})).json(),
    {code: 'server_draining'});
  assert.equal((await drained.call('/preview', {input: {...request, unexpected: 'x'.repeat(8193)}})).status, 413);
  assert.equal((await drained.call('/preview', {input: {...request, taskId: '19'}})).status, 400);
  assert.equal(drained.calls.length, 0);
  const limited = await fixture(t, {configure: value => { value.requestRatePerMinute = 1; }});
  assert.equal((await limited.call('/preview', {input: request})).status, 200);
  const denied = await limited.call('/preview', {input: request});
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get('retry-after'), '60');
  assert.equal((await limited.call('/preview', {username: 'bob', input: request})).status, 200);
  assert.equal(limited.calls.length, 0);
});

test('private pilot config needs explicit valid source, result origins and paid allowances', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muse-mediakit-config-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const file = join(root, 'pilot.json');
  for (const mutate of [
    value => { value.approvals[0].sourcePath = '/shots/../shots/test.mp4'; },
    value => { value.approvals[0].sourceOrigin = 'https://127.0.0.1'; },
    value => { value.approvals[0].sourceSha256 = '-'; },
    value => { value.approvals[0].operations.upscale.priceCny = '0.00'; },
    value => { value.resultOrigins = ['https://results.example.com/here']; },
    value => { value.approvals.push({...value.approvals[0]}); },
  ]) {
    const input = config(root, 'a'.repeat(16));
    mutate(input);
    await writeFile(file, JSON.stringify(input), {mode: 0o600});
    await assert.rejects(loadMediaKitPilot(file), {message: 'Invalid MediaKit configuration'});
  }
  if (process.platform !== 'win32') {
    await chmod(file, 0o644);
    await assert.rejects(loadMediaKitPilot(file), {message: 'MediaKit configuration requires a private 0600 regular file'});
  }
});

test('default routing quotes independent account access and source, and rechecks before the billed request', async t => {
  const env = await fixture(t, {configure: defaultConfig, sourceFetch: verifiedSource});
  for (const input of [{...request, videoUrl: 'http://clips.example.com/shots/test.mp4'}, {...request, videoUrl}]) {
    assert.deepEqual(await (await env.call('/preview', {input, headers: sourceHeaders})).json(), {state: 'ineligible'});
  }
  for (const input of [{...request, scriptId: 8}, {...request, videoUrl: source + '&change=1'}]) {
    const response = await env.call('/preview', {input, headers: sourceHeaders});
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {code: 'media_source_unverified'});
  }
  assert.deepEqual(await (await env.call('/preview', {input: request})).json(), {state: 'ineligible'});
  const quote = await (await env.call('/preview', {input: request, headers: sourceHeaders})).json();
  assert.deepEqual(quote, {state: 'ready', jobKey: quote.jobKey, amount: '1.75', unit: 'CNY', defaultRouting: true});
  assert.match(quote.jobKey, /^[a-f0-9]{64}$/u);
  const input = {...request, jobKey: quote.jobKey, quoteAmount: quote.amount};
  for (const [requestBody, headers] of [[input, {}], [{...input, quoteAmount: '0.01'}, sourceHeaders],
    [{...input, quoteAmount: undefined}, sourceHeaders], [{...input, videoUrl: source + '&change=1'}, sourceHeaders]]) {
    assert.deepEqual(await (await env.call('/jobs', {input: requestBody, headers})).json(),
      {state: 'conflict', code: 'preview_mismatch'});
  }
  assert.equal(env.calls.length, 0);
  assert.deepEqual(await (await env.call('/jobs', {input, headers: sourceHeaders})).json(), {state: 'accepted'});
  assert.deepEqual(await (await env.call('/jobs', {input, headers: sourceHeaders})).json(), {state: 'accepted'});
  assert.equal(env.calls.length, 1);
  assert.equal('x-jubian-token' in env.calls[0].init.headers, false);
  assert.equal(env.calls[0].init.body.includes(sourceHeaders['x-jubian-token']), false);
  const recovered = await env.reload();
  assert.equal((await recovered.inspect(env.alice.id, quote.jobKey)).state, 'completed');
});

test('daily default routing limit reserves once per task and only the rejected owner can claim backup', async t => {
  const env = await fixture(t, {
    configure: value => { defaultConfig(value); value.defaultRouting.maxDailyJobs = 1; },
    sourceFetch: verifiedSource,
  });
  const operations = [[request, 'alice'], [eraseRequest, 'bob']];
  const quoted = await Promise.all(operations.map(async ([input, username]) => {
    const {amount, jobKey} = await (await env.call('/preview', {input, username, headers: sourceHeaders})).json();
    assert.match(jobKey, /^[a-f0-9]{64}$/u);
    return {input: {...input, quoteAmount: amount, jobKey}, username, headers: sourceHeaders};
  }));
  assert.equal(quoted[1].input.quoteAmount, '0.35');
  const results = await Promise.all(quoted.map(async options => (await env.call('/jobs', options)).json()));
  assert.deepEqual(results.map(result => result.state).sort(), ['accepted', 'rejected']);
  assert.equal(env.calls.length, 1);
  const rejected = results.findIndex(result => result.state === 'rejected');
  assert.deepEqual(results[rejected], {state: 'rejected', code: 'MEDIAKIT_CAPACITY_LIMIT'});
  const {input, username} = quoted[rejected];
  assert.deepEqual(await (await env.call('/jobs', quoted[rejected])).json(), results[rejected]);
  const fallback = '/jobs/' + input.jobKey + '/fallback';
  const claim = {username, method: 'POST', headers: {origin}};
  assert.deepEqual(await (await env.call(fallback, {...claim, username: quoted[1 - rejected].username})).json(), {claimed: false});
  assert.deepEqual(await (await env.call(fallback, claim)).json(), {claimed: true});
  assert.deepEqual(await (await env.call(fallback, claim)).json(), {claimed: false});
  const reopened = await env.reload();
  const newInput = {...request, taskId: 20};
  const newQuote = await reopened.preview(env.alice.id, newInput, sourceHeaders['x-jubian-token']);
  assert.deepEqual(newQuote, {state: 'ineligible'});
  assert.equal(env.calls.length, 1);
});
