/** Offline readback fixtures for production MediaKit sources. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {createMediaKitSourceVerifier} from './mediakit-source.mjs';

const endpoint = 'https://web.jubianai.net/prod-api';
const token = 'offline-jubian-fixture';
const originalUrl = 'https://media.example.com/original.mp4?signature=original-fixture';
const currentUrl = 'https://media.example.com/erased.mp4?signature=current-fixture';
const project = {id: 7, scriptId: '7'};
const task = {id: 14, taskId: '14', scriptId: 7};
const row = {id: 24, scriptId: 7, aigcVideoTaskId: '14', taskStatus: ' succeeded ', duration: 13.5,
  resultList: [{resultStatus: 'succeeded', lastResultStatus: 'completed', tosVideoUrl: originalUrl, lastTosVideoUrl: currentUrl}]};
const upscale = {operation: 'upscale', scriptId: 7, taskId: 14, videoUrl: currentUrl};
const erase = {...upscale, operation: 'erase_subtitle', videoUrl: originalUrl};
const result = value => Response.json({code: 200, data: value});

function fixture(replies, options) {
  const calls = [];
  const verify = createMediaKitSourceVerifier({fetcher: async (url, init) => {
    calls.push({url, init});
    return replies[calls.length - 1]();
  }, ...options});
  return {calls, verify};
}

test('reads scoped Jubian metadata and verifies the selected current URL with one deadline', async () => {
  const {calls, verify} = fixture([
    () => Response.json([{code: 200, data: {code: 0, data: project}}]),
    () => result(task),
    () => Response.json({code: 200, total: 2, rows: [{...row, taskStatus: 'pending'}, row]}),
  ]);
  assert.equal(await verify(token, upscale), 13.5);
  assert.deepEqual(calls.map(({url, init}) => [url, init.method]), [
    [endpoint + '/aigc/script/7', 'GET'],
    [endpoint + '/admin/aigc/video/task/14', 'GET'],
    [endpoint + '/admin/aigc/video/task/sub/list?orderByColumn=createTime&orderBy=desc', 'POST'],
  ]);
  for (const {init} of calls) {
    assert.equal(init.headers.authorization, 'Bearer ' + token);
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.signal, calls[0].init.signal);
  }
  assert.deepEqual(JSON.parse(calls[2].init.body), {aigcVideoTaskId: 14});
});

test('verifies the original generation for erasure in provider order', async () => {
  const {calls, verify} = fixture([() => result(project), () => result(task), () => result({rows: [row]})]);
  assert.equal(await verify(token, erase), 13.5);
  assert.equal(calls.at(-1).url, endpoint + '/admin/aigc/video/task/sub/list');
});

test('supports successful legacy child rows with a nested media URL', async () => {
  const {verify} = fixture([() => result(project), () => result(task), () => result({rows: [
    {id: 24, aigcVideoTaskId: 14, duration: 8, taskStatus: 'completed', videoMaterials: [{videoUrl: originalUrl}]},
  ]})]);
  assert.equal(await verify(token, erase), 8);
});

test('rejects conflicting or unreadable project and task identifiers before looking up children', async () => {
  for (const invalidProject of [{id: 8}, {id: 7, scriptId: 8}, {name: 'missing identity'}]) {
    const {calls, verify} = fixture([() => result(invalidProject)]);
    assert.equal(await verify(token, upscale), undefined);
    assert.equal(calls.length, 1);
  }
  for (const invalidTask of [{id: 15, scriptId: 7}, {id: 14, taskId: 15, scriptId: 7}, {id: 14, scriptId: 8}, {id: 14}]) {
    const {calls, verify} = fixture([() => result(project), () => result(invalidTask)]);
    assert.equal(await verify(token, upscale), undefined);
    assert.equal(calls.length, 2);
  }
});

test('requires a selected successful child of this task and exactly the confirmed URL', async () => {
  const cases = [
    [upscale, [{...row, id: undefined}]],
    [upscale, [{...row, subTaskId: 25}]],
    [upscale, [{...row, aigcVideoTaskId: 15}]],
    [upscale, [{...row, aigcVideoTaskId: undefined}]],
    [upscale, [{...row, scriptId: 12}]],
    [upscale, [{...row, duration: 0}]],
    [upscale, [{...row, duration: '13'}]],
    [upscale, [{...row, taskStatus: undefined, resultList: [{tosVideoUrl: currentUrl}]}]],
    [upscale, [{...row, resultList: [{lastTosVideoUrl: currentUrl, lastResultStatus: 'failed'}]}]],
    [{...upscale, videoUrl: currentUrl.replace('current-fixture', 'different-signature')}, [row]],
    [{...upscale, videoUrl: originalUrl}, [row]],
    [{...erase, videoUrl: currentUrl}, [row]],
    [erase, [{...row, taskStatus: 'failed'}]],
    [upscale, [{...row, resultList: [{tosVideoUrl: originalUrl}]}, row]],
  ];
  for (const [input, rows] of cases) {
    const {calls, verify} = fixture([() => result(project), () => result(task), () => result({rows})]);
    assert.equal(await verify(token, input), undefined);
    assert.equal(calls.length, 3);
  }
});

test('validates the token and source protocol before fetching', async () => {
  const {calls, verify} = fixture([]);
  for (const invalid of [undefined, '', 'line\nbreak']) assert.equal(await verify(invalid, upscale), undefined);
  for (const url of ['http://media.example.com/clip.mp4', 'https://127.0.0.1/clip.mp4',
    'https://user:password@media.example.com/clip.mp4', 'https://media.example.com/clip.mp4#hash']) {
    assert.equal(await verify(token, {...upscale, videoUrl: url}), undefined);
  }
  assert.equal(calls.length, 0);
});

test('rejects provider denials, unexpected envelopes and oversized reads without leaking their contents', async () => {
  for (const response of [
    () => new Response('not-json ' + token, {status: 403}),
    () => Response.redirect('https://unexpected.example.com'),
    () => Response.json({code: 403, data: project}),
    () => Response.json({code: 200, data: {code: 403, data: project}}),
    () => new Response('missing envelope ' + token),
    () => result({...project, description: 'x'.repeat(80)}),
    () => { throw Error('mock provider error ' + token); },
  ]) {
    const {calls, verify} = fixture([response], {maximumBytes: 80});
    assert.equal(await verify(token, upscale), undefined);
    assert.equal(calls.length, 1);
  }
});

test('ends source verification at the deadline when Jubian does not respond', async () => {
  const verify = createMediaKitSourceVerifier({timeoutMs: 10, fetcher: async (_url, init) => {
    await delay(1000, undefined, {signal: init.signal});
    assert.fail('verification request did not stop at its deadline');
  }});
  assert.equal(await verify(token, upscale), undefined);
});
