/** Exact dependency changes and real multipart parsing against the pinned upstream upload module. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire, Module } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { planRuntimeDependencies } from '../compatibility/runtime-dependencies.mjs'

const root = resolve(process.env.LOCALMINIDRAMA_SOURCE || '.local/localminidrama')
const revision = '3fbcda9713ca545979dff9e75d21bed53694188f'
const available = existsSync(resolve(root, 'backend-node/package-lock.json'))
const sources = new Map()
function pristine(path) {
  if (!sources.has(path)) sources.set(path, execFileSync('git', ['-C', root, 'show', `${revision}:${relative(root, path).split(sep).join('/')}`], { encoding: 'utf8', maxBuffer: 3e6 }))
  return sources.get(path)
}
const packagePath = resolve(root, 'backend-node/package.json'), lockPath = resolve(root, 'backend-node/package-lock.json')
const libraryRoot = resolve(process.env.LOCALMINIDRAMA_MULTIPART_ROOT || resolve(root, 'backend-node'))
const library = createRequire(resolve(libraryRoot, 'package.json'))
const installed = existsSync(resolve(libraryRoot, 'node_modules/multer/package.json'))
const realParser = installed && library('multer/package.json').version === '2.5.0'
if (process.env.LOCALMINIDRAMA_MULTIPART_ROOT && !realParser) throw new Error('Multipart regression requires the actual multer 2.5.0 runtime')

test('pins only the multipart dependency and prunes its unreachable old dependency nodes', { skip: !available }, () => {
  const planned = new Map(planRuntimeDependencies(root, pristine))
  assert.equal(planned.size, 2)
  const beforePackage = JSON.parse(pristine(packagePath)), afterPackage = JSON.parse(planned.get(packagePath))
  assert.equal(afterPackage.dependencies.multer, '2.5.0')
  afterPackage.dependencies.multer = beforePackage.dependencies.multer
  assert.deepEqual(afterPackage, beforePackage)
  const before = JSON.parse(pristine(lockPath)), after = JSON.parse(planned.get(lockPath))
  assert.equal(after.packages[''].dependencies.multer, '2.5.0')
  const multer = after.packages['node_modules/multer']
  assert.equal(multer.version, '2.5.0')
  assert.equal(multer.resolved, 'https://registry.npmjs.org/multer/-/multer-2.5.0.tgz')
  assert.equal(multer.integrity, 'sha512-BsqOzYGVq49JcW2IzoSAxeKYRevb+dGGPPWleOR8Lrlk4igwxu1/9pwSXlByhCb7MVZDrNJFC0IBP5/O5nLYRw==')
  const removed = Object.keys(before.packages).filter(key => !(key in after.packages))
  assert.deepEqual(removed, [
    'node_modules/buffer-from', 'node_modules/concat-stream', 'node_modules/concat-stream/node_modules/readable-stream',
    'node_modules/concat-stream/node_modules/safe-buffer', 'node_modules/concat-stream/node_modules/string_decoder',
    'node_modules/core-util-is', 'node_modules/isarray', 'node_modules/mkdirp', 'node_modules/process-nextick-args',
    'node_modules/typedarray', 'node_modules/xtend',
  ])
  for (const [key, value] of Object.entries(before.packages)) {
    if (key && key !== 'node_modules/multer' && !removed.includes(key)) assert.deepEqual(after.packages[key], value, key)
  }
  after.packages[''].dependencies.multer = before.packages[''].dependencies.multer
  assert.deepEqual(after.packages[''], before.packages[''])
  assert.equal(planned.get(packagePath), new Map(planRuntimeDependencies(root, path => pristine(path).replaceAll('\n', '\r\n'))).get(packagePath))
})

test('rejects stale manifest or lock contents before returning any planned writes', { skip: !available }, () => {
  for (const changed of [packagePath, lockPath]) {
    assert.throws(() => planRuntimeDependencies(root, path => pristine(path) + (path === changed ? ' ' : '')), /pinned upstream package and lock hashes/)
  }
  const planned = new Map(planRuntimeDependencies(root, pristine))
  assert.throws(() => planRuntimeDependencies(root, path => planned.get(path)), /pinned upstream package and lock hashes/)
})

async function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'muse-multipart-http-')), upstream = createRequire(packagePath)
  const uploadPath = resolve(root, 'backend-node/src/routes/upload.js'), uploadModule = new Module(uploadPath)
  uploadModule.filename = uploadPath
  uploadModule.paths = Module._nodeModulePaths(dirname(uploadPath))
  uploadModule.require = name => name === 'multer' ? library('multer') : createRequire(uploadPath)(name)
  uploadModule._compile(pristine(uploadPath), uploadPath)
  const upload = uploadModule.exports, log = { info() {}, warn() {}, error() {} }, cfg = { storage: { local_path: home, base_url: '' } }
  const app = upstream('express')(), handlers = upload.routes(cfg, log)
  app.use(upstream('express').json())
  app.post('/upload/image', handlers.multerSingle, handlers.uploadImage)
  const operations = []
  const audioPath = resolve(root, 'backend-node/src/routes/museAudio.js'), audioModule = new Module(audioPath)
  audioModule.require = name => name === './upload' ? upload : name === '../services/museAudioService' ? {
    schema() {}, uploadVoice(_db, _cfg, body, bytes) { return { label: body.label, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } },
    generate(_db, _log, _cfg, body) { operations.push(body); return { operation_id: body.operation_id, state: 'retained' } },
  } : createRequire(uploadPath)(name)
  audioModule._compile(readFileSync(new URL('../extensions/muse-audio-routes.cjs', import.meta.url), 'utf8'), audioPath)
  audioModule.exports({}, log, cfg).register(app)
  app.use((error, req, res, next) => { if (res.headersSent) { res.destroy(); return } res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ code: error.code || 'invalid_multipart' }) })
  const server = createServer(app)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); rmSync(home, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${server.address().port}`
  return { operations, home, call: (path, options) => fetch(base + path, { signal: AbortSignal.timeout(5000), ...options }) }
}
function multipart(bytes, type, filename, field = 'file') {
  const body = new FormData()
  body.append(field, new Blob([bytes], { type }), filename)
  body.append('label', 'retained voice')
  return body
}

test('multer 2.5.0 preserves real image uploads and the audio/TTS route request fields', { skip: !available || !realParser }, async t => {
  assert.equal(library('multer/package.json').version, '2.5.0')
  const f = await fixture(t), bytes = Buffer.from('retained image fixture')
  const image = await f.call('/upload/image', { method: 'POST', body: multipart(bytes, 'image/png', 'fixture.png') })
  assert.equal(image.status, 200)
  const uploaded = (await image.json()).data
  assert.equal(uploaded.filename, 'fixture.png')
  assert.equal(uploaded.size, bytes.length)
  assert.deepEqual(readFileSync(join(f.home, uploaded.local_path)), bytes)
  const wav = Buffer.from('retained audio parser fixture')
  const audio = await f.call('/muse/audio/voices', { method: 'POST', body: multipart(wav, 'audio/wav', 'voice.wav') })
  assert.equal(audio.status, 200)
  assert.deepEqual((await audio.json()).data, { label: 'retained voice', bytes: wav.length, sha256: createHash('sha256').update(wav).digest('hex') })
  const input = { operation_id: 'new-tts-fixture', storyboard_id: 7, config_id: 3, text: 'dialogue' }
  const tts = await f.call('/muse/audio/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  assert.equal(tts.status, 200)
  assert.deepEqual(f.operations, [input])
})

test('malformed multipart, wrong fields, unsupported media and size limits fail without breaking later uploads', { skip: !available || !realParser }, async t => {
  const f = await fixture(t)
  for (const contentType of ['multipart/form-data', 'multipart/form-data; boundary=fixture']) {
    const bad = await f.call('/upload/image', { method: 'POST', headers: { 'content-type': contentType }, body: '--fixture\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\ntruncated' })
    assert.equal(bad.status, 400)
  }
  for (const [path, bytes, type, field, expected] of [
    ['/upload/image', Buffer.from('fixture'), 'image/png', 'unexpected', 400],
    ['/upload/image', Buffer.from('fixture'), 'application/javascript', 'file', 400],
    ['/upload/image', Buffer.alloc(16 * 1024 * 1024 + 1), 'image/png', 'file', 413],
    ['/muse/audio/voices', Buffer.alloc(10 * 1024 * 1024 + 1), 'audio/wav', 'file', 413],
  ]) assert.equal((await f.call(path, { method: 'POST', body: multipart(bytes, type, 'fixture', field) })).status, expected)
  assert.equal((await f.call('/upload/image', { method: 'POST', body: multipart(Buffer.from('after failures'), 'image/png', 'healthy.png') })).status, 200)
})
