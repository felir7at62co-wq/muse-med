import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { parseV2DeviceIdentity, readV2DeviceIdentity } from '../src/v2-device.js';

const value = '01234567-89AB-CDEF-0123-456789ABCDEF';
const stdout = platform => platform === 'darwin' ? `+-o Root\n  {\n    "IOPlatformUUID" = "${value}"\n  }\n`
  : `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    ${value}\r\n`;
const config = { v2RequestTimeoutMs: 1000, v2MaxLineBytes: 4096, mediaProcessGraceMs: 10 };
const supported = ['darwin', 'win32'].includes(process.platform);
const deferred = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };
function fixture({ text = stdout(process.platform), stderr = '', exitCode = 0, signal = null, lossy = false, truncated = false, wait } = {}) {
  const calls = [];
  let terminated = 0, waits = 0;
  const handle = { collected: {
    stdout: { readFrom: () => ({ text, lossy, truncated }) }, stderr: { readFrom: () => ({ text: stderr, lossy: false, truncated: false }) },
  }, done: Promise.resolve({ exitCode, signal }), terminate() { terminated++; }, async waitForExit() { waits++; return wait ? wait : true; } };
  return { subprocess: { spawn(spec) { calls.push(spec); return handle; } }, calls, handle,
    get terminated() { return terminated; }, get waits() { return waits; } };
}

test('parsing derives the same Mac identity for UUID case changes and preserves Windows case', () => {
  const hash = text => 'd1:' + createHash('sha256').update(text).digest('hex').slice(0, 32);
  assert.equal(parseV2DeviceIdentity('darwin', stdout('darwin')), hash('muse-mac-physical-v1:' + value.toLowerCase()));
  assert.equal(parseV2DeviceIdentity('darwin', stdout('darwin').replace(value, value.toLowerCase())), parseV2DeviceIdentity('darwin', stdout('darwin')));
  assert.equal(parseV2DeviceIdentity('win32', stdout('win32')), hash('mg:' + value));
  assert.notEqual(parseV2DeviceIdentity('win32', stdout('win32').replace(value, value.toLowerCase())), parseV2DeviceIdentity('win32', stdout('win32')));
});

test('missing, malformed, duplicate or wrong-type identity fields are refused without their values in errors', () => {
  for (const [platform, text] of [['darwin', ''], ['darwin', stdout('darwin') + stdout('darwin')], ['darwin', stdout('darwin').replace(value, 'bad')],
    ['win32', stdout('win32') + stdout('win32')], ['win32', stdout('win32').replace('REG_SZ', 'REG_EXPAND_SZ')], ['linux', stdout('darwin')]]) {
    assert.throws(() => parseV2DeviceIdentity(platform, text), error => error.code === 'v2_device_invalid' && !error.message.includes(value));
  }
});

test('the managed read is bounded, uses the OS command and waits for exit before returning', { skip: !supported }, async () => {
  const joined = deferred(), f = fixture({ wait: joined.promise });
  let settled = false;
  const work = readV2DeviceIdentity(f.subprocess, config).then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(f.waits, 1);
  joined.resolve(true);
  assert.equal(await work, parseV2DeviceIdentity(process.platform, stdout(process.platform)));
  const request = f.calls[0];
  assert.equal(request.stdio.stdout.maxBytes, config.v2MaxLineBytes);
  assert.equal(request.stdio.stderr.maxBytes, config.v2MaxLineBytes);
  assert.equal(request.graceMs, config.mediaProcessGraceMs);
  assert.equal(Object.hasOwn(request.env, 'HOME'), false);
  if (process.platform === 'darwin') assert.deepEqual(request.argv, ['/usr/sbin/ioreg', '-rd1', '-c', 'IOPlatformExpertDevice']);
  else assert.deepEqual(request.argv.slice(1), ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64']);
  assert.equal(f.terminated, 0);
});

for (const invalid of [{ text: '' }, { text: stdout('darwin'), exitCode: 1 }, { signal: 'SIGTERM' }, { lossy: true }, { truncated: true }, { text: 'x'.repeat(4097) }, { stderr: 'private raw diagnostic ' + value }]) {
  test('an unsuccessful or incomplete read is terminated and joined with a fixed failure', { skip: !supported }, async () => {
    const f = fixture(invalid);
    await assert.rejects(readV2DeviceIdentity(f.subprocess, config), error => error.code === 'v2_device_invalid' && !error.message.includes(value));
    assert.equal(f.terminated, 1);
    assert.ok(f.waits >= 1);
  });
}

test('an already canceled request does not spawn any process', async () => {
  const controller = new AbortController(); controller.abort();
  const f = fixture();
  await assert.rejects(readV2DeviceIdentity(f.subprocess, config, controller.signal), { code: 'v2_cancelled' });
  assert.equal(f.calls.length, 0);
});

test('cancellation terminates a hung read and waits for its owned cleanup', { skip: !supported }, async () => {
  const controller = new AbortController(), done = deferred(), joined = deferred(), f = fixture();
  f.handle.done = done.promise;
  f.handle.terminate = () => { done.resolve({ exitCode: null, signal: 'SIGTERM' }); };
  f.handle.waitForExit = () => joined.promise;
  const work = readV2DeviceIdentity(f.subprocess, config, controller.signal);
  controller.abort();
  let settled = false; void work.catch(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  joined.resolve(true);
  await assert.rejects(work, { code: 'v2_cancelled' });
});

test('the request deadline terminates and joins a hung process without logging its output', { skip: !supported }, async () => {
  const done = deferred(), f = fixture();
  f.handle.done = done.promise;
  f.handle.terminate = () => done.resolve({ exitCode: null, signal: 'SIGTERM' });
  await assert.rejects(readV2DeviceIdentity(f.subprocess, { ...config, v2RequestTimeoutMs: 10 }), { code: 'v2_request_timeout' });
  assert.ok(f.waits >= 1);
});
