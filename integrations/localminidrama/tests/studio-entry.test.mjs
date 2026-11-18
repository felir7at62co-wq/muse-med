/** Project entry and media feedback preserve visible work when a request fails or arrives late. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, relative, sep } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { planMediaAdoption } from '../compatibility/media-adoption.mjs'
import { planMuseBranding } from '../compatibility/muse-branding.mjs'
import { planCloudPrefix } from '../compatibility/cloud-prefix.mjs'
import { planStudioEntry } from '../compatibility/studio-entry.mjs'

const root = resolve(process.env.LOCALMINIDRAMA_SOURCE || '.local/localminidrama')
const available = existsSync(resolve(root, 'frontweb/src/views/FilmList.vue'))
const original = new Map()
let staged
function pristine(path) {
  const file = relative(root, path).split(sep).join('/')
  if (!original.has(file)) original.set(file, execFileSync('git', ['-C', root, 'show', '3fbcda9713ca545979dff9e75d21bed53694188f:' + file], { encoding: 'utf8', maxBuffer: 3e6 }).replaceAll('\r\n', '\n'))
  return original.get(file)
}
function preceding() {
  if (!staged) {
    staged = new Map()
    for (const planner of [planMediaAdoption, planMuseBranding, planCloudPrefix]) {
      for (const [path, source] of planner(root, path => staged.get(path) ?? pristine(path))) staged.set(path, source)
    }
  }
  return staged
}
function planned() { return new Map(planStudioEntry(root, path => preceding().get(path) ?? pristine(path))) }
function mediaFunction(name, next) {
  const source = planned().get(resolve(root, 'frontweb/src/views/MediaLibrary.vue'))
  const start = source.indexOf('async function ' + name + '('), end = source.indexOf('\nfunction ' + next + '(', start)
  assert.ok(start > 0 && end > start)
  return source.slice(start, end)
}
function deferred() {
  let fulfill, reject
  const promise = new Promise((yes, no) => { fulfill = yes; reject = no })
  return { promise, fulfill, reject }
}

test('project entry validates the staged header and Vue compiles all three changed screens', { skip: !available }, () => {
  const changes = planned()
  const require = createRequire(resolve(root, 'frontweb/package.json'))
  const compiler = require('@vue/compiler-sfc')
  for (const [filename, source] of changes) {
    const parsed = compiler.parse(source, { filename })
    assert.deepEqual(parsed.errors, [])
    compiler.compileScript(parsed.descriptor, { id: 'entry-test' })
    const template = compiler.compileTemplate({ source: parsed.descriptor.template.content, filename, id: 'entry-test' })
    assert.deepEqual(template.errors, [])
  }
  const reader = path => preceding().get(path) ?? pristine(path)
  assert.throws(() => planStudioEntry(root, path => changes.get(path) ?? reader(path)), /pinned source/)
  assert.throws(() => planStudioEntry(root, path => reader(path).replace('class="header-actions"', 'class="changed"')), /pinned source/)
})

test('late media queries cannot replace a newer result or its failure report', { skip: !available }, async () => {
  const a = deferred(), b = deferred(), pending = [a, b]
  const context = createContext({ loading: { value: false }, mediaItems: { value: [{ id: 'previous' }] }, total: { value: 1 },
    mediaType: { value: 'all' }, keyword: { value: '' }, page: { value: 1 }, pageSize: { value: 30 }, museMediaError: { value: '' },
    normalizeItem: value => value, request: { get: () => pending.shift().promise } })
  runInContext('let museMediaRequest = 0;\n' + mediaFunction('loadMedia', 'normalizeItem'), context)
  const first = runInContext('loadMedia()', context), second = runInContext('loadMedia()', context)
  b.reject(Error('new query failed')); await second
  assert.match(context.museMediaError.value, /加载失败/)
  assert.equal(context.mediaItems.value[0].id, 'previous')
  assert.equal(context.total.value, 1)
  a.fulfill({ items: [{ id: 'stale' }], total: 5 }); await first
  assert.equal(context.mediaItems.value[0].id, 'previous')
  assert.match(context.museMediaError.value, /加载失败/)
  assert.equal(context.loading.value, false)
})

test('partial uploads report only saved images and count every attempted file', { skip: !available }, async () => {
  const successes = [], warnings = []
  const context = createContext({ uploading: { value: false }, uploadProgress: { value: {} },
    museMediaError: { value: '' }, request: { async post(path, body) { assert.equal(path, '/assets'); assert.equal(body.name, 'saved.png'); assert.equal(body.url, '/static/saved.png'); return { id: 7 } } },
    uploadAPI: { async uploadImage(file) { if (file.name === 'failed.png') throw Error('fixture failure'); return { url: '/static/saved.png', local_path: 'saved.png' } } },
    ElMessage: { success: value => successes.push(value), warning: value => warnings.push(value) }, loadMedia() {} })
  runInContext(mediaFunction('onUpload', 'debouncedLoad'), context)
  context.event = { target: { files: [{ name: 'saved.png' }, { name: 'failed.png' }], value: 'files' } }
  await runInContext('onUpload(event)', context)
  assert.deepEqual(successes, ['1 个图片上传完成'])
  assert.equal(context.uploadProgress.value.current, 2)
  assert.equal(context.uploading.value, false)
  assert.equal(context.event.target.value, '')
  assert.equal(warnings.length, 2)
})

test('a lost asset registration response asks for inspection without claiming success or retrying', { skip: !available }, async () => {
  let posts = 0, refreshed = 0
  const context = createContext({ uploading: { value: false }, uploadProgress: { value: {} }, museMediaError: { value: '' },
    uploadAPI: { async uploadImage() { return { url: '/static/saved.png' } } },
    request: { async post() { posts++; throw Error('response lost') } },
    ElMessage: { success() { assert.fail('unknown registration is not confirmed') }, warning() { assert.fail('must inspect before reupload') } },
    loadMedia() { refreshed++ } })
  runInContext(mediaFunction('onUpload', 'debouncedLoad'), context)
  context.event = { target: { files: [{ name: 'saved.png' }], value: 'files' } }
  await runInContext('onUpload(event)', context)
  assert.equal(posts, 1)
  assert.equal(refreshed, 0)
  assert.match(context.museMediaError.value, /未确认加入素材库.*重新加载核对/)
  assert.equal(context.uploadProgress.value.current, 1)
  assert.equal(context.uploading.value, false)
})
