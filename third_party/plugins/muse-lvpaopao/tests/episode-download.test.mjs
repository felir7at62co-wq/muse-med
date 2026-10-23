/** Real local episode files and interruption recovery; native discovery and remote subprocesses are mocked. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Config, validateConfig } from '../src/config.ts'
import { localDownload } from '../src/download.ts'
import { EpisodeDownloadRequestPort } from '../src/episode-download.ts'
import { authorizeOutput } from '../src/output.ts'

const signal = () => new AbortController().signal
const params = { srcAppId: 'wx0123456789abcdef', dramaId: 'sample_1', episodeNo: 2, idempotencyKey: 'a'.repeat(64) }
async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lvpaopao-episode-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const native = join(root, 'native'), localHelper = join(native, 'run-persistent-host.py')
  await mkdir(native); await writeFile(localHelper, '# synthetic helper, not executed\n')
  const bytes = Buffer.from('synthetic media bytes; copied and verified only; no actual decode in this unit test')
  const relativePath = `downloads/${params.idempotencyKey}/media/episode-0002.mp4`, source = join(native, relativePath)
  await mkdir(dirname(source), { recursive: true }); await writeFile(source, bytes)
  const raw = { operation: 'download_episode', ...params, status: 'download-returned', identityMatched: true,
    serialNo: 2, isStraight: true, playAuthorization: 'native-straight-playback', receiptReused: true, businessCalls: 0,
    media: { relativePath, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), durationSeconds: 1.5,
      width: 720, height: 1280, hasAudio: true, fullDecodePassed: true } }
  const output = await authorizeOutput({ header: { cwd: root } }, 'downloads', { mode: 'workspace-write' })
  if (options.create !== false) await output.create()
  const directory = join(output.path, 'task', 'episodes', '0002')
  const file = join(directory, 'episode-0002.mp4'), part = file + '.part', transfer = file + '.copy.json'
  const config = validateConfig(Config({ transport: 'local', localPython: process.execPath, localHelper,
    helperSha256: 'b'.repeat(64), cwd: native, downloadEnabled: true }))
  const calls = [], spawns = [], copies = []
  t.after(async () => { for (const copy of copies) await copy.dispose() })
  const inner = { async request(action, parameters, active) {
    calls.push({ action, parameters, active })
    return options.request ? await options.request(action, parameters, active, raw) : raw
  }, async dispose() { throw new Error('copy must never close the borrowed native connection') } }
  function port(custom = {}) {
    const result = new EpisodeDownloadRequestPort(inner, { spawn(spec) { spawns.push(spec); throw new Error('local copies must not spawn') } }, config,
      { output, directory, chunkBytes: 8, maxMediaBytes: 10000, copyTimeoutMs: 1000, ...custom })
    copies.push(result); return result
  }
  async function seedPart(content = bytes.subarray(0, 13), changedBinding = {}) {
    await mkdir(directory, { recursive: true })
    const binding = { schemaVersion: 1, srcAppId: params.srcAppId, dramaId: params.dramaId, episodeNo: params.episodeNo,
      idempotencyKey: params.idempotencyKey, bytes: raw.media.bytes, sha256: raw.media.sha256, ...changedBinding }
    await writeFile(transfer, JSON.stringify(binding), { mode: 0o600 }); await writeFile(part, content, { mode: 0o600 })
  }
  return { root, native, source, bytes, raw, output, directory, file, part, transfer, config, calls, spawns, port, seedPart }
}

test('local episode copy verifies exact bytes and hash without SCP and preserves the original source key', async t => {
  const f = await fixture(t)
  const result = localDownload(await f.port().request('download_episode', params, signal()))
  assert.ok(result); assert.equal(result.episodeNo, 2); assert.equal(result.media.localPath, f.file)
  assert.deepEqual(await readFile(f.file), f.bytes); assert.equal(result.media.sha256, f.raw.media.sha256)
  assert.equal(JSON.parse(await readFile(result.media.receiptPath, 'utf8')).idempotencyKey, params.idempotencyKey)
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].parameters, params); assert.equal(f.spawns.length, 0)
})

test('local copy resumes a bound partial after checking every retained prefix byte', async t => {
  const f = await fixture(t); await f.seedPart()
  const result = localDownload(await f.port().request('download_episode', params, signal()))
  assert.ok(result); assert.deepEqual(await readFile(f.file), f.bytes); assert.equal(f.calls.length, 1)
  await assert.rejects(lstat(f.part), { code: 'ENOENT' }); assert.equal(f.spawns.length, 0)
})

test('a corrupt retained prefix, wrong transfer binding and unowned part cannot become completed files', async t => {
  for (const kind of ['prefix', 'binding', 'unowned']) {
    await t.test(kind, async sub => {
      const f = await fixture(sub)
      await f.seedPart(kind === 'prefix' ? Buffer.from('wrong prefix!') : undefined, kind === 'binding' ? { episodeNo: 3 } : {})
      if (kind === 'unowned') await rm(f.transfer)
      await assert.rejects(f.port().request('download_episode', params, signal()), new RegExp(kind === 'prefix' ? 'download-prefix-mismatch' : kind === 'binding' ? 'download-copy-binding-conflict' : 'download-unowned-partial'))
      await assert.rejects(lstat(f.file), { code: 'ENOENT' }); assert.equal(f.spawns.length, 0)
    })
  }
})

test('cancelled local transfer settles its file handles, retains resumable bytes and continues under the same key', async t => {
  const f = await fixture(t), controller = new AbortController(); let aborted = false
  const controlled = { ...f.output, async check() {
    await f.output.check()
    try {
      if (!aborted && (await lstat(f.part)).size >= 8) { aborted = true; controller.abort() }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  } }
  const first = f.port({ output: controlled })
  await assert.rejects(first.request('download_episode', params, controller.signal))
  await first.dispose()
  const retained = await readFile(f.part)
  assert.ok(retained.length > 0 && retained.length < f.bytes.length); assert.deepEqual(retained, f.bytes.subarray(0, retained.length))
  await f.port().request('download_episode', params, signal())
  assert.deepEqual(await readFile(f.file), f.bytes)
  assert.equal(f.calls.length, 2); assert.equal(new Set(f.calls.map(call => call.parameters.idempotencyKey)).size, 1)
})

test('source symlinks and destination partial symlinks never copy or mutate their referents', async t => {
  for (const source of [true, false]) {
    await t.test(source ? 'source link' : 'partial link', async sub => {
      const f = await fixture(sub), outside = join(f.root, 'outside.txt'); await writeFile(outside, f.bytes)
      if (source) { await rm(f.source); await symlink(outside, f.source) }
      else { await f.seedPart(); await rm(f.part); await symlink(outside, f.part) }
      await assert.rejects(f.port().request('download_episode', params, signal()), /download-source-unconfirmed|download-output-unsafe/)
      assert.deepEqual(await readFile(outside), f.bytes); await assert.rejects(lstat(f.file), { code: 'ENOENT' })
    })
  }
})

test('wrong episode or key in a native response is rejected before local publication', async t => {
  for (const changed of [{ idempotencyKey: 'c'.repeat(64) }, { episodeNo: 3 }, { srcAppId: 'wxabcdef0123456789' }]) {
    await t.test('wrong original identity', async sub => {
      const f = await fixture(sub, { request(_action, _params, _signal, raw) { return { ...raw, ...changed } } })
      await assert.rejects(f.port().request('download_episode', params, signal()), /download-source-unconfirmed/)
      assert.deepEqual(await readdir(f.output.path), []); assert.equal(f.spawns.length, 0)
    })
  }
})

test('invalid input keys are refused before contacting native acquisition', async t => {
  const f = await fixture(t)
  await assert.rejects(f.port().request('download_episode', { ...params, idempotencyKey: 'not-a-durable-key' }, signal()), /invalid-arguments/)
  assert.deepEqual(f.calls, []); assert.deepEqual(await readdir(f.output.path), [])
})

test('original-key status can finish a local copy without requesting native acquisition again', async t => {
  const f = await fixture(t)
  const result = localDownload(await f.port().request('download_status', params, signal()))
  assert.ok(result); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].action, 'download_status')
  assert.deepEqual(await readFile(f.file), f.bytes)
})

test('the first direct episode call can initialize a previously absent authorized default output', async t => {
  const f = await fixture(t, { create: false })
  const result = localDownload(await f.port().request('download_episode', params, signal()))
  assert.ok(result); assert.deepEqual(await readFile(result.media.localPath), f.bytes)
})

test('changing part bytes after their hash check cannot mint successful original-hash media', async t => {
  const f = await fixture(t); let fullChecks = 0, changed = false
  const guarded = { ...f.output, async check() {
    await f.output.check()
    try {
      if ((await lstat(f.part)).size === f.bytes.length && ++fullChecks === 2) {
        changed = true; await writeFile(f.part, Buffer.alloc(f.bytes.length, 120))
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  } }
  await assert.rejects(f.port({ output: guarded }).request('download_episode', params, signal()))
  assert.equal(changed, true)
  await assert.rejects(lstat(f.file + '.receipt.json'), { code: 'ENOENT' })
})

test('status reconciliation cannot accept another source or original key even when no media was returned', async t => {
  const f = await fixture(t, { request(_action, _params, _signal, raw) {
    return { ...raw, status: 'resume-available', idempotencyKey: 'c'.repeat(64), media: undefined }
  } })
  await assert.rejects(f.port().request('download_status', params, signal()), /download-source-unconfirmed/)
  assert.deepEqual(await readdir(f.output.path), [])
})

test('published media changed before the receipt commit cannot be returned as locally verified', async t => {
  const f = await fixture(t); let changed = false
  const guarded = { ...f.output, async check() {
    await f.output.check()
    try {
      const complete = await lstat(f.file)
      if (!changed && complete.isFile()) {
        try { await lstat(f.part); return }
        catch (error) { if (error.code !== 'ENOENT') throw error }
        changed = true; await writeFile(f.file, Buffer.alloc(f.bytes.length, 121))
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  } }
  await assert.rejects(f.port({ output: guarded }).request('download_episode', params, signal()))
  assert.equal(changed, true)
  await assert.rejects(lstat(f.file + '.receipt.json'), { code: 'ENOENT' })
})

test('a reused completed file changed after verification is not returned with its prior success receipt', async t => {
  let rounds = 0, armed = false, checks = 0, changed = false
  const f = await fixture(t, { request(_action, _params, _signal, raw) { if (++rounds === 2) armed = true; return raw } })
  await f.port().request('download_episode', params, signal())
  await rm(f.file + '.receipt.json')
  const guarded = { ...f.output, async check() {
    await f.output.check()
    if (armed && ++checks === 2) { changed = true; await writeFile(f.file, Buffer.alloc(f.bytes.length, 122)) }
  } }
  await assert.rejects(f.port({ output: guarded }).request('download_episode', params, signal()))
  assert.equal(changed, true)
  await assert.rejects(lstat(f.file + '.receipt.json'), { code: 'ENOENT' })
})
