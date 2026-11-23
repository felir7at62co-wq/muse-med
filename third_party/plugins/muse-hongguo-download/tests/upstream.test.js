/** Package integrity and offline engine load; no platform requests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cp, mkdtemp, rm, appendFile, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('retained source and runtime match the reviewed pin and load without external packages', async () => {
  await import('../scripts/verify-upstream.mjs');
  const engine = createRequire(import.meta.url)('../upstream/engine.cjs');
  for (const name of ['fetchEpisodeList', 'fetchPlayUrlSingle', 'deriveKey']) assert.equal(typeof engine[name], 'function');
});

test('loads Electron net only in an Electron browser process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hongguo-electron-'));
  const engine = join(directory, 'engine.cjs');
  try {
    const source = await readFile(fileURLToPath(new URL('../upstream/engine.cjs', import.meta.url)), 'utf8');
    await writeFile(engine, source + '\nmodule.exports.testCatalog = require_catalog;\n');
    for (const [kind, expected] of [['node', 0], ['renderer', 0], ['browser', 1]]) {
      const code = `
      const Module = require('node:module');
      const load = Module._load;
      let electronCalls = 0;
      Module._load = function (name, ...args) {
        if (name === 'electron') { electronCalls++; return { net: {} }; }
        return load.call(this, name, ...args);
      };
      if (process.env.CASE !== 'node') {
        Object.defineProperty(process.versions, 'electron', { value: 'test' });
        process.type = process.env.CASE;
      }
      require(process.argv[1]).testCatalog();
      if (electronCalls !== Number(process.env.EXPECTED)) process.exit(1);
      `;
      const child = spawnSync(process.execPath, ['-e', code, engine], {
        env: { ...process.env, CASE: kind, EXPECTED: String(expected) }, encoding: 'utf8',
      });
      assert.equal(child.status, 0, `${kind}: ${child.stderr}`);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function box(type, ...parts) {
  const payload = Buffer.concat(parts), result = Buffer.alloc(8 + payload.length);
  result.writeUInt32BE(result.length); result.write(type, 4, 4, 'latin1'); payload.copy(result, 8);
  return result;
}

function encryptedEntry(codec, configurations) {
  const entry = box('encv', Buffer.alloc(78), ...configurations.map(type => box(type, Buffer.alloc(4))),
    box('sinf', box('frma', Buffer.from(codec))));
  const count = Buffer.alloc(8); count.writeUInt32BE(1, 4);
  return box('moov', box('trak', box('mdia', box('minf', box('stbl', box('stsd', count, entry))))));
}

test('rebuilds declared ByteVC2 CENC metadata and retains compatible codec configurations', () => {
  const engine = createRequire(import.meta.url)('../upstream/engine.cjs');
  for (const [codec, configuration] of [['bvc2', 'bv2C'], ['avc1', 'avcC'], ['hvc1', 'hvcC']]) {
    const value = engine.decryptMp4Buffer(encryptedEntry(codec, [configuration]), Buffer.alloc(16));
    assert.equal(value.includes(Buffer.from('encv')), false);
    assert.equal(value.includes(Buffer.from('sinf')), false);
    assert.equal(value.includes(Buffer.from(codec)), true);
    assert.equal(value.includes(Buffer.from(configuration)), true);
  }
});

test('refuses missing or conflicting codec configuration when decrypting CENC', () => {
  const engine = createRequire(import.meta.url)('../upstream/engine.cjs');
  for (const [codec, configurations] of [['bvc2', ['hvcC']], ['bvc2', ['bv2C', 'avcC']],
    ['avc1', ['avcC', 'bv2C']], ['xxxx', ['bv2C']], ['bvc2', []]]) {
    assert.throws(() => engine.decryptMp4Buffer(encryptedEntry(codec, configurations), Buffer.alloc(16)), /codec/);
  }
});

test('refuses packaging when the retained local codec patch changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hongguo-patch-integrity-'));
  try {
    const root = new URL('../', import.meta.url);
    for (const file of ['SOURCE.json', 'upstream', 'patches', 'scripts/verify-upstream.mjs']) {
      await cp(new URL(file, root), join(directory, file), { recursive: true });
    }
    await appendFile(join(directory, 'patches/0001-bytevc2-cenc.patch'), '\nchanged');
    const result = spawnSync(process.execPath, [join(directory, 'scripts/verify-upstream.mjs')], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /local patch checksum mismatch/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('refuses subsample or wide-IV CENC instead of altering clear sample bytes', () => {
  const engine = createRequire(import.meta.url)('../upstream/engine.cjs');
  const encryptions = [[2, 8], [0, 16], [0x01000000, 8]].map(([flags, ivBytes]) => {
    const encryption = Buffer.alloc(8 + ivBytes); encryption.writeUInt32BE(flags); encryption.writeUInt32BE(1, 4);
    return encryption;
  });
  for (const encryption of [...encryptions, Buffer.alloc(0), Buffer.alloc(4), Buffer.alloc(8)]) {
    const sizes = Buffer.alloc(12); sizes.writeUInt32BE(1, 4); sizes.writeUInt32BE(1, 8);
    const value = box('moov', box('trak', box('mdia', box('minf', box('stbl',
      box('stsz', sizes), box('stco', Buffer.alloc(8)), box('stsc', Buffer.alloc(8)), box('senc', encryption))))));
    assert.throws(() => engine.decryptMp4Buffer(value, Buffer.alloc(16)), /Unsupported CENC/);
  }
});
