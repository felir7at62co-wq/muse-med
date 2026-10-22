/** Local filesystem and mock managed scp tests only; no remote command is executed. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, readFile, writeFile, readdir, symlink, mkdir, stat, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DownloadRequestPort } from '../src/download.ts'
import { projectResult } from '../src/result.ts'
import { authorizeOutput } from '../src/output.ts'
import { Session } from '@deepseek-ai/dsh-session'

const bytes = Buffer.from('owned synthetic media fixture; no real decode claim')
const digest = createHash('sha256').update(bytes).digest('hex')
const params = { srcAppId: 'wx6522458df7ed3af2', dramaId: '121225' }
const config = { remoteHelper: 'C:\\Users\\EDY\\Probe\\run-persistent-host.py', sshHostAlias: 'test-host',
  sshExecutable: 'fixed-ssh-wrapper', helperSha256: 'a'.repeat(64), cwd: process.cwd(), shutdownTimeoutMs: 1000 }
const safeMedia = { relativePath: 'downloads/test-request/media/episode-01.mp4', bytes: bytes.length,
  sha256: digest, durationSeconds: 279.2, width: 720, height: 1280, hasAudio: true, fullDecodePassed: true }
function response(patch = {}) { return { operation: 'download_first_episode', status: 'download-returned', identityMatched: true,
  ...params, serialNo: 1, isFirstMediaFree: true, isStraight: true, receiptReused: true, businessCalls: 0,
  media: { ...safeMedia }, ...patch } }
async function fixture(options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lvpaopao-copy-')))
  let requests = 0, spawns = 0, disposed = 0, lastSpec
  const exit = Promise.withResolvers(), copied = Promise.withResolvers(), rangeGone = Promise.withResolvers()
  const inner = { async request(action, input, signal) {
    signal.throwIfAborted(); requests++; assert.equal(action, 'download_first_episode'); assert.deepEqual(input, params)
    return options.response ?? response()
  }, async dispose() { disposed++ } }
  const subprocess = { spawn(spec) {
    spawns++; lastSpec = spec
    let closed = false
    const terminate = () => { closed = true; exit.resolve({ exitCode: 1, signal: null }) }
    spec.signal.addEventListener('abort', terminate, { once: true })
    const done = (async () => {
      await writeFile(spec.argv.at(-1), options.bytes ?? bytes); copied.resolve()
      if (options.block) await exit.promise
      closed = true; spec.signal.removeEventListener('abort', terminate)
      return { exitCode: options.exitCode ?? (spec.signal.aborted ? 1 : 0), signal: null }
    })()
    return { done, terminate, async waitForExit() {
      if (options.holdRange) return await rangeGone.promise
      return options.rangeUnknown ? false : closed
    } }
  } }
  const settings = { enabled: options.enabled ?? true, outputDir: options.outputDir ?? join(root, 'output'),
    scpExecutable: 'scp-test', copyTimeoutMs: 1000, copyPollIntervalMs: 50, maxMediaBytes: 10000 }
  const port = new DownloadRequestPort(inner, subprocess, options.config ?? config, settings)
  return { port, root, settings, copied, rangeGone,
    get requests() { return requests }, get spawns() { return spawns }, get disposed() { return disposed }, get lastSpec() { return lastSpec },
    async cleanup() { try { await port.dispose() } finally { await rm(root, { recursive: true, force: true }) } } }
}

test('cached media is copied once, locally hashed, and only then becomes a successful download value', async () => {
  const f = await fixture()
  try {
    const raw = await f.port.request('download_first_episode', params, new AbortController().signal)
    const result = projectResult('download_first_episode', raw, { maxResultItems: 50, maxEpisodeCount: 20 })
    assert.equal(result.ok, true); assert.equal(result.data.receiptReused, true); assert.equal(result.data.businessCalls, 0)
    assert.equal(result.data.media.sha256, digest); assert.deepEqual(await readFile(result.data.media.localPath), bytes)
    assert.equal((await stat(result.data.media.localPath)).size, bytes.length)
    const receipt = JSON.parse(await readFile(result.data.media.receiptPath, 'utf8'))
    assert.equal(receipt.srcAppId, params.srcAppId); assert.equal(receipt.dramaId, params.dramaId); assert.equal(receipt.receiptReused, true)
    assert.equal(f.requests, 1); assert.equal(f.spawns, 1)
    assert.ok(f.lastSpec.argv.includes('-O')); assert.ok(f.lastSpec.argv.includes('-S'))
    assert.ok(f.lastSpec.argv.includes('fixed-ssh-wrapper'))
    assert.match(f.lastSpec.argv.at(-2), /^test-host:C:\/Users\/EDY\/Probe\/downloads\/test-request\/media\/episode-01\.mp4$/)
    assert.equal(JSON.stringify(result).includes('relativePath'), false)
  } finally { await f.cleanup() }
})

test('disabled lane and incompatible download IDs cannot acquire another media address', async () => {
  const disabled = await fixture({ enabled: false })
  try {
    await assert.rejects(disabled.port.request('download_first_episode', params, new AbortController().signal), /capability-not-ready/)
    assert.equal(disabled.requests, 0); assert.equal(disabled.spawns, 0)
  } finally { await disabled.cleanup() }
  const f = await fixture()
  try {
    await assert.rejects(f.port.request('download_first_episode', { ...params, dramaId: 'a'.repeat(65) }, new AbortController().signal), /download-source-invalid/)
    assert.equal(f.requests, 0)
  } finally { await f.cleanup() }
})

test('foreign source, traversal, absent decode proof and oversized metadata never start scp', async () => {
  for (const raw of [response({ dramaId: 'another' }), response({ media: { ...safeMedia, relativePath: '../secret' } }),
    response({ media: { ...safeMedia, fullDecodePassed: false } }), response({ media: { ...safeMedia, bytes: 10001 } }),
    response({ receiptReused: true, businessCalls: 2 })]) {
    const f = await fixture({ response: raw })
    try {
      await assert.rejects(f.port.request('download_first_episode', params, new AbortController().signal))
      assert.equal(f.spawns, 0); assert.deepEqual(await readdir(f.settings.outputDir), [])
    } finally { await f.cleanup() }
  }
})

test('copy failure, changed bytes and changed length never publish a final file or receipt', async () => {
  for (const options of [{ exitCode: 1 }, { response: response({ media: { ...safeMedia, sha256: 'b'.repeat(64) } }) },
    { bytes: Buffer.from('short') }]) {
    const f = await fixture(options)
    try {
      await assert.rejects(f.port.request('download_first_episode', params, new AbortController().signal))
      assert.equal(f.spawns, 1); assert.deepEqual(await readdir(f.settings.outputDir), [])
    } finally { await f.cleanup() }
  }
})

test('local output symlinks and unsafe remote prefixes reject before native acquisition', async () => {
  const f = await fixture()
  try {
    const real = join(f.root, 'real'); await mkdir(real); const linked = join(f.root, 'link'); await symlink(real, linked, 'dir')
    const guarded = new DownloadRequestPort({ async request() { throw Error('must-not-request') }, async dispose() {} }, {}, config,
      { ...f.settings, outputDir: linked })
    await assert.rejects(guarded.request('download_first_episode', params, new AbortController().signal), /download-output-unsafe/)
    assert.throws(() => new DownloadRequestPort({}, {}, { ...config, remoteHelper: 'C:\\Program Files\\helper.py' }, f.settings), /remote-path-unsupported/)
  } finally { await f.cleanup() }
})

test('cancel waits for the managed scp range and removes its part only after that range is gone', async () => {
  const f = await fixture({ block: true, holdRange: true })
  const controller = new AbortController(); let settled = false
  const work = f.port.request('download_first_episode', params, controller.signal).finally(() => { settled = true })
  try {
    await f.copied.promise; controller.abort(); await Promise.resolve(); await Promise.resolve()
    assert.equal(settled, false)
    f.rangeGone.resolve(true); await assert.rejects(work, /cancelled/)
    assert.deepEqual(await readdir(f.settings.outputDir), [])
  } finally { f.rangeGone.resolve(true); await f.cleanup() }
})

test('unconfirmed scp cleanup retains only private incomplete output and makes disposal fail', async () => {
  const f = await fixture({ rangeUnknown: true })
  try {
    await assert.rejects(f.port.request('download_first_episode', params, new AbortController().signal), /cleanup-unconfirmed/)
    const folders = await readdir(f.settings.outputDir); assert.equal(folders.length, 1)
    assert.deepEqual(await readdir(join(f.settings.outputDir, folders[0])), ['episode-01.part'])
    await assert.rejects(f.port.dispose(), /cleanup-unconfirmed/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('authorized output replacement during copy cannot publish or remove unrelated files', async () => {
  const f = await fixture()
  try {
    const session = Session.create('session-output-replacement', undefined, { id: 'session-output-replacement', version: 4, createdAt: 0, cwd: f.root, isSeeded: false })
    const output = await authorizeOutput(session, 'guarded', { mode: 'workspace-write' })
    const subprocess = { spawn(spec) {
      const done = (async () => {
        await writeFile(spec.argv.at(-1), bytes)
        await rename(output.path, output.path + '-saved'); await mkdir(output.path)
        await writeFile(join(output.path, 'unrelated.txt'), 'keep')
        return { exitCode: 0, signal: null }
      })()
      return { done, terminate() {}, async waitForExit() { await done; return true } }
    } }
    const port = new DownloadRequestPort({ request: () => response(), async dispose() {} }, subprocess, config,
      { ...f.settings, outputDir: output.path, output })
    await assert.rejects(port.request('download_first_episode', params, new AbortController().signal), /download-output-replaced/)
    assert.deepEqual(await readdir(output.path), ['unrelated.txt'])
    assert.equal(await readFile(join(output.path, 'unrelated.txt'), 'utf8'), 'keep')
    const saved = await readdir(output.path + '-saved'); assert.equal(saved.length, 1)
    assert.deepEqual(await readdir(join(output.path + '-saved', saved[0])), ['episode-01.part'])
    await port.dispose()
  } finally { await f.cleanup() }
})
