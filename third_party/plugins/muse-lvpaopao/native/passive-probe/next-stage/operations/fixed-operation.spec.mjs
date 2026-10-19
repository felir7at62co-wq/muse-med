import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const template = readFileSync(new URL('./fixed-operation.js', import.meta.url), 'utf8');
const target = 'wx404dde55fb12df78';
const selection = {srcAppId: 'wx6522458df7ed3af2', dramaId: '121225'};
const secret = 'synthetic-private-value';
const fakeUrl = `https://synthetic.invalid/media?capability=${secret}`;
const detail = () => ({base_resp: {ret: 0}, drama_info: {drama_name: '合成剧名', media_count: 36}, is_first_media_free: true, video_info: {url: fakeUrl}, play_authorize: {token: secret}});

function fixture(params, options = {}) {
  assert.equal(template.split('@@PARAMS@@').length, 2);
  const calls = [];
  const requireCalls = [];
  const timers = new Map();
  let nextTimer = 0;
  const forbidden = () => { throw new Error('extra API must never execute'); };
  const host = {APP_ID: target, AppBaseInfo: {SDKVersion: '3.15.0', version: '4.1.7'}, DeviceInfo: {platform: 'windows', system: 'Windows 11', benchmarkLevel: 8}};
  const context = {
    Error, TypeError, ReferenceError, RangeError,
    wx: {getAccountInfoSync: () => ({miniProgram: {appId: options.identity ?? target, version: '108', envVersion: 'release'}}), getEnterOptionsSync: () => ({scene: 1183}), request: forbidden, login: forbidden, operateWXData: forbidden},
    requirePlugin(name) { assert.equal(name, 'playlet-plugin'); return {getPluginVersion: () => options.pluginVersion ?? '1.15.14'}; },
    require(path) {
      requireCalls.push(path);
      if (path === 'utils/index.js') return host;
      if (path === 'utils/biz-request.js') return {
        getIsLoggedIn: () => true,
        async bizRequest(action, data) {
          calls.push({api: 'host-biz', action, data});
          if (options.searchFailure) throw options.searchFailure;
          if (options.searchError) throw new Error(fakeUrl);
          return options.searchResponse ?? {list: [{drama_name: '合成剧名', src_appid: selection.srcAppId, origin_dramaid: selection.dramaId, play_url: fakeUrl, token: secret}]};
        },
      };
      if (path === 'utils/operate-wx-data.js') return {default(reqData, api) {
        assert.equal(api, 'webapi_wxadramaplayer');
        const query = new URLSearchParams(reqData.query_string);
        const data = reqData.post_data === '{}' ? Object.fromEntries(query) : JSON.parse(reqData.post_data);
        const action = query.get('action');
        calls.push({api, action, data, query: Object.fromEntries(query)});
        if (options.native) return options.native(action, data, context);
        if (action === 'getdramainfo') return Promise.resolve(options.detail ?? detail());
        if (action === 'getdramamedialist') return Promise.resolve(options.episodes ?? {list: Array.from({length: Number(data.end_no) - Number(data.start_no)}, (_, i) => ({media_no: Number(data.start_no) + i, cover_url: fakeUrl}))});
        if (action === 'postcgiforward_directgetplayurl') return Promise.resolve(options.playable ?? {data: JSON.stringify({serial_play_list: [{serial_no: 1, is_straight: true, play_url: fakeUrl}]})});
        throw new Error('unregistered native action');
      }};
      throw new Error('unregistered module');
    },
    setTimeout(callback, delay) { assert.equal(delay, 15000); const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const expression = template.replace('@@PARAMS@@', `JSON.parse(${JSON.stringify(JSON.stringify(params))})`);
  const promise = vm.runInNewContext(expression, context, {timeout: 1000}).then(value => JSON.parse(JSON.stringify(value)));
  return {promise, calls, requireCalls, timers, host, context};
}

test('status reads only exact identity/runtime/module getters without business requests', async () => {
  const f = fixture({operation: 'status'});
  const result = await f.promise;
  assert.equal(result.publicResult.status, 'status-returned');
  assert.equal(result.publicResult.businessCalls, 0);
  assert.equal(result.publicResult.pluginVersion, '1.15.14');
  assert.equal(result.privateResult, null);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.requireCalls, ['utils/index.js', 'utils/biz-request.js', 'utils/operate-wx-data.js']);
  assert.equal(f.timers.size, 0);
});

test('invalid params and unknown operations never load modules or call business APIs', async () => {
  const bad = [null, [], {}, {operation: 'login'}, {operation: 'status', extra: 1}, {operation: 'search', query: ''}, {operation: 'search', query: 'x'.repeat(81)}, {operation: 'search', query: 'x\n'}, {operation: 'detail', ...selection, dramaId: 121225}, {operation: 'detail', ...selection, srcAppId: 'other'}, {operation: 'detail', ...selection, dramaId: 'x'.repeat(129)}, {operation: 'episodes', ...selection, start: 0, count: 20}, {operation: 'episodes', ...selection, start: 1, count: 21}, {operation: 'episodes', ...selection, start: 1, count: true}, JSON.parse('{"operation":"status","__proto__":{}}')];
  for (const params of bad) {
    const f = fixture(params);
    assert.equal((await f.promise).publicResult.status, 'parameters-invalid');
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.requireCalls, []);
  }
});

test('wrong AppID stops before module loading', async () => {
  const f = fixture({operation: 'detail', ...selection}, {identity: 'wx0000000000000000'});
  const result = await f.promise;
  assert.equal(result.publicResult.status, 'identity-unavailable');
  assert.equal(result.publicResult.identityMatched, false);
  assert.deepEqual(f.requireCalls, []);
});

test('search uses one fixed host wrapper and strips URLs, tokens and unsafe identifiers', async () => {
  const f = fixture({operation: 'search', query: '老手'}, {searchResponse: {list: [
    {drama_name: '合成剧名', src_appid: selection.srcAppId, origin_dramaid: '000121225', token: secret, play_url: fakeUrl},
    {drama_name: '安全数值ID', src_appid: selection.srcAppId, origin_dramaid: 123},
    {drama_name: '不安全数值ID', src_appid: selection.srcAppId, origin_dramaid: Number.MAX_SAFE_INTEGER + 1},
    {drama_name: fakeUrl, src_appid: selection.srcAppId, origin_dramaid: '456'},
  ]}});
  const result = await f.promise;
  assert.equal(result.publicResult.status, 'search-returned');
  assert.equal(result.publicResult.resultCount, 4);
  assert.equal(result.publicResult.partial, true);
  assert.deepEqual(result.publicResult.candidates.map(item => item.originDramaId), ['000121225', '123']);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].api, 'host-biz');
  assert.equal(f.calls[0].action, 'search');
  assert.equal(f.calls[0].data.query, '老手');
  assert.equal(f.calls[0].data.source, 6);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(f.timers.size, 0);
});

test('search caps public candidates and does not coerce query content into code', async () => {
  const query = `'); wx.login(); ('`;
  const f = fixture({operation: 'search', query}, {searchResponse: {list: Array.from({length: 51}, (_, i) => ({drama_name: `合成${i}`, src_appid: selection.srcAppId, origin_dramaid: String(i)}))}});
  const result = await f.promise;
  assert.equal(f.calls[0].data.query, query);
  assert.equal(result.publicResult.candidates.length, 50);
  assert.equal(result.publicResult.partial, true);
});

test('search invokes the proven wrapper in the current evaluation stack before a microtask', async () => {
  const f = fixture({operation: 'search', query: '老手'});
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].action, 'search');
  const result = await f.promise;
  assert.equal(result.publicResult.status, 'search-returned');
  assert.equal('failurePhase' in result.publicResult, false);
  assert.equal('failureKind' in result.publicResult, false);
  assert.equal('nativeErrorCode' in result.publicResult, false);
});

test('detail uses current public plugin version/common fields and preserves opaque selected IDs', async () => {
  const f = fixture({operation: 'detail', ...selection, dramaId: '000121225'});
  const result = await f.promise;
  assert.equal(result.publicResult.status, 'detail-returned');
  assert.equal(result.publicResult.episodeCount, 36);
  assert.equal(f.calls.length, 1);
  const data = f.calls[0].data;
  assert.equal(data.drama_id, '000121225');
  assert.equal(data.plugin_version, '1.15.14');
  assert.equal(data.plugin_code_version, '1.15.14');
  assert.equal(data.is_logged_in, 'true');
  assert.equal(data.scene, '1183');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('episodes requests exclusive end=start+count and returns only actual unique in-range numbers', async () => {
  const f = fixture({operation: 'episodes', ...selection, start: 1, count: 20}, {episodes: {list: [{media_no: 0}, {media_no: 1}, {media_no: 3}, {media_no: 3}, {media_no: 20}, {media_no: 21}, {media_no: '4'}]}});
  const result = await f.promise;
  assert.deepEqual(f.calls.map(call => call.action), ['getdramainfo', 'getdramamedialist']);
  assert.equal(f.calls[1].data.start_no, '1');
  assert.equal(f.calls[1].data.end_no, '21');
  assert.deepEqual(result.publicResult.episodeNumbers, [1, 3, 20]);
  assert.equal(result.publicResult.requestedEndExclusive, 21);
  assert.equal(result.publicResult.partial, true);
});

test('complete final episode window clamps to known actual count without inventing entries', async () => {
  const f = fixture({operation: 'episodes', ...selection, start: 35, count: 20});
  const result = await f.promise;
  assert.equal(f.calls[1].data.end_no, '37');
  assert.deepEqual(result.publicResult.episodeNumbers, [35, 36]);
  assert.equal(result.publicResult.partial, true);
  const full = await fixture({operation: 'episodes', ...selection, start: 1, count: 20}).promise;
  assert.equal(full.publicResult.partial, false);
  assert.equal(full.publicResult.episodeNumbers.length, 20);
});

test('range outside fresh detail makes no list request', async () => {
  const f = fixture({operation: 'episodes', ...selection, start: 37, count: 1});
  assert.equal((await f.promise).publicResult.status, 'episode-range-outside-detail');
  assert.equal(f.calls.length, 1);
});

test('identity changed after detail prevents the second business request', async () => {
  const f = fixture({operation: 'download_first_episode', ...selection}, {native(action, data, context) {
    assert.equal(action, 'getdramainfo');
    context.wx.getAccountInfoSync = () => ({miniProgram: {appId: 'wx0000000000000000'}});
    return Promise.resolve(detail());
  }});
  const result = await f.promise;
  assert.equal(result.publicResult.identityMatched, false);
  assert.equal(result.publicResult.status, 'native-call-failed');
  assert.equal(result.publicResult.businessCalls, 1);
  assert.equal(result.publicResult.failurePhase, 'before-call');
  assert.equal(f.calls.length, 1);
  assert.equal(result.privateResult, null);
});

test('missing positive episode count and provider business errors cannot claim detail success', async () => {
  for (const response of [{drama_info: {media_count: 0}}, {drama_info: {media_count: '36'}}, {base_resp: {ret: 5}, drama_info: {media_count: 36}}]) {
    const f = fixture({operation: 'episodes', ...selection, start: 1, count: 1}, {detail: response});
    const result = await f.promise;
    assert.notEqual(result.publicResult.status, 'episodes-returned');
    assert.equal(f.calls.length, 1);
  }
});

test('download address acquisition requires fresh first-free proof before the only playurl request', async () => {
  for (const free of [false, undefined, 'true']) {
    const response = detail(); response.is_first_media_free = free;
    const f = fixture({operation: 'download_first_episode', ...selection}, {detail: response});
    const result = await f.promise;
    assert.equal(result.publicResult.status, 'first-episode-free-unconfirmed');
    assert.equal(result.privateResult, null);
    assert.equal(f.calls.length, 1);
  }
});

test('only episode1 straight URL crosses the private result seam, never the public result', async () => {
  const f = fixture({operation: 'download_first_episode', ...selection});
  const result = await f.promise;
  assert.equal(result.publicResult.status, 'first-episode-address-returned');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls.map(call => call.action), ['getdramainfo', 'postcgiforward_directgetplayurl']);
  assert.equal(f.calls[1].data.start_serial_no, 1);
  assert.equal(f.calls[1].data.end_serial_no, 1);
  assert.equal(f.calls[1].data.need_straight, true);
  assert.equal(f.calls[1].query.direct_result, 'true');
  assert.equal(result.privateResult.mediaUrl, fakeUrl);
  assert.equal(result.privateResult.binding.serialNo, 1);
  assert.equal(result.publicResult.hasPrivateMedia, true);
  assert.equal(JSON.stringify(result.publicResult).includes(secret), false);
});

test('wrong episode, duplicate first episode, non-straight and non-HTTPS addresses never escape privately', async () => {
  const rows = [
    [{serial_no: 2, is_straight: true, play_url: fakeUrl}],
    [{serial_no: 1, is_straight: true, play_url: fakeUrl}, {serial_no: 1, is_straight: true, play_url: fakeUrl}],
    [{serial_no: 1, is_straight: 'true', play_url: fakeUrl}],
    [{serial_no: 1, is_straight: true, play_url: 'http://synthetic.invalid/x'}],
  ];
  for (const list of rows) {
    const f = fixture({operation: 'download_first_episode', ...selection}, {playable: {data: JSON.stringify({serial_play_list: list})}});
    const result = await f.promise;
    assert.equal(result.privateResult, null);
    assert.equal(result.publicResult.hasPrivateMedia, false);
    assert.equal(f.calls.length, 2);
  }
});

test('fifteen-second timer is deterministic and timeout makes no second native request or retry', async () => {
  const f = fixture({operation: 'episodes', ...selection, start: 1, count: 20}, {native: () => new Promise(() => {})});
  assert.equal(f.timers.size, 1);
  for (const callback of f.timers.values()) callback();
  const result = await f.promise;
  assert.equal(result.publicResult.status, 'native-call-timeout');
  assert.equal(result.publicResult.timedOut, true);
  assert.equal(result.publicResult.businessCalls, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.size, 0);
});

test('raw provider errors and raw extra result fields never reach the public response', async () => {
  const f = fixture({operation: 'search', query: '老手'}, {searchError: true});
  const result = await f.promise;
  assert.equal(result.publicResult.status, 'native-call-failed');
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(f.calls.length, 1);
});

test('error diagnostics use fixed class and first own int32 code without reading message/stack/getters', async () => {
  let getterCalls = 0;
  const failure = Object.create({ret: -999});
  Object.defineProperties(failure, {
    ret: {get() { getterCalls += 1; throw new Error(fakeUrl); }},
    err_no: {value: -17},
    errCode: {value: -18},
    message: {get() { getterCalls += 1; throw new Error(fakeUrl); }},
    stack: {get() { getterCalls += 1; throw new Error(fakeUrl); }},
  });
  const f = fixture({operation: 'search', query: '老手'}, {searchFailure: failure});
  const result = await f.promise;
  assert.equal(result.publicResult.status, 'native-call-failed');
  assert.equal(result.publicResult.failurePhase, 'call-pending');
  assert.equal(result.publicResult.failureKind, 'other');
  assert.equal(result.publicResult.nativeErrorCode, -17);
  assert.equal(getterCalls, 0);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('own code priority is ret then err_no then errCode and inherited or non-int32 values are excluded', async () => {
  const cases = [
    [Object.assign(new TypeError(fakeUrl), {ret: -5, err_no: -6, errCode: -7}), 'TypeError', -5],
    [Object.assign(new RangeError(fakeUrl), {ret: 2147483648, err_no: -2147483648}), 'RangeError', -2147483648],
    [Object.assign(new ReferenceError(fakeUrl), {ret: true, err_no: 1.5, errCode: 2147483647}), 'ReferenceError', 2147483647],
    [Object.create({ret: -5}), 'other', null],
    [new Error(fakeUrl), 'Error', null],
    [new Proxy({}, {getOwnPropertyDescriptor() { throw new Error(fakeUrl); }}), 'other', null],
  ];
  for (const [failure, kind, code] of cases) {
    const result = await fixture({operation: 'search', query: '老手'}, {searchFailure: failure}).promise;
    assert.equal(result.publicResult.failureKind, kind);
    assert.equal(result.publicResult.nativeErrorCode, code);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test('response validation and projection failures are distinguished from a pending native call', async () => {
  const beforeProjection = {};
  Object.defineProperty(beforeProjection, 'base_resp', {get() { throw new TypeError(fakeUrl); }});
  const received = await fixture({operation: 'search', query: '老手'}, {searchResponse: beforeProjection}).promise;
  assert.equal(received.publicResult.failurePhase, 'response-received');
  const list = [];
  Object.defineProperty(list, 'slice', {get() { throw new RangeError(fakeUrl); }});
  const projected = await fixture({operation: 'search', query: '老手'}, {searchResponse: {list}}).promise;
  assert.equal(projected.publicResult.failurePhase, 'projection');
  assert.equal(projected.publicResult.failureKind, 'RangeError');
  assert.equal(JSON.stringify([received, projected]).includes(secret), false);
});
