/** Execute pinned provider clients with private files and instance-local request adapters. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve, sep } from 'node:path'
import { compileFunction } from 'node:vm'
import { planModelSelection } from '../compatibility/model-selection.mjs'
import { planReferences } from '../compatibility/references.mjs'

const root = resolve(process.env.LOCALMINIDRAMA_SOURCE || '.local/localminidrama')
const available = existsSync(resolve(root, 'backend-node/node_modules/sharp'))
const pristineSources = new Map()
const log = { info() {}, warn() {}, error() {} }
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKzUAAAAASUVORK5CYII=', 'base64')
const inline = 'data:image/png;base64,' + pixel.toString('base64')
function pristine(path) {
  const name = relative(root, path).split(sep).join('/')
  if (!pristineSources.has(name)) pristineSources.set(name, execFileSync('git', ['-C', root, 'show', `3fbcda9713ca545979dff9e75d21bed53694188f:${name}`], { encoding: 'utf8', maxBuffer: 2e6 }))
  return pristineSources.get(name)
}
function fixture(t, provider, protocol, model, options = {}) {
  const home = mkdtempSync(resolve(tmpdir(), 'muse-lmd-reference-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  writeFileSync(resolve(home, 'reference.png'), pixel)
  const selected = new Map(planModelSelection(root, pristine))
  const sources = new Map([...selected, ...planReferences(root, path => selected.get(path) ?? pristine(path))])
  const upstream = createRequire(resolve(root, 'backend-node/package.json'))
  const config = { provider, api_protocol: protocol, model: [model], default_model: model, is_default: true, is_active: true, base_url: protocol === 'dashscope' ? 'https://dashscope.fixture.invalid' : 'https://model.fixture.invalid', api_key: 'fixture-only', settings: options.settings }
  const modules = new Map()
  const posts = []
  let uploads = 0
  const db = { prepare: () => ({ get() {}, all() { return [] }, run() {} }) }
  const fakeFetch = async (url, request = {}) => {
    if (!request.method || request.method === 'GET') return new Response(url === 'https://references.fixture.invalid/present.png' ? pixel : 'missing', { status: url === 'https://references.fixture.invalid/present.png' ? 200 : 404, headers: { 'content-type': 'image/png' } })
    assert.equal(request.method, 'POST')
    posts.push({ url, body: typeof request.body === 'string' ? JSON.parse(request.body) : request.body })
    return new Response(JSON.stringify({ id: 'fixture-task', output: { task_id: 'fixture-task' }, data: { id: 'fixture-task', task_id: 'fixture-task' } }))
  }
  const overrides = new Map([
    [resolve(root, 'backend-node/src/services/aiConfigService.js'), { listConfigs: () => [config] }],
    [resolve(root, 'backend-node/src/config/index.js'), { loadConfig: () => ({ image_proxy: { enabled: false, use_for_gemini: options.geminiProxy === true }, storage: { local_path: home, base_url: 'http://127.0.0.1:5679/static' } }) }],
    [resolve(root, 'backend-node/src/services/uploadService.js'), { uploadLocalImageToProxy: async () => { uploads++; return null }, uploadToImageProxy: async () => { uploads++; return null } }],
    [resolve(root, 'backend-node/src/services/aiClient.js'), { postJSONWithTimeout: async (url, headers, body) => {
      posts.push({ url, body })
      return { statusCode: 200, raw: JSON.stringify({ data: [{ url: 'https://model.fixture.invalid/result.png' }], candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: pixel.toString('base64') } }] } }] }) }
    } }],
  ])
  function load(path) {
    path = upstream.resolve(path)
    if (overrides.has(path)) return overrides.get(path)
    if (modules.has(path)) return modules.get(path).exports
    const module = { exports: {} }
    modules.set(path, module)
    const req = createRequire(path)
    compileFunction(sources.get(path) ?? pristine(path), ['require', 'module', 'exports', '__filename', '__dirname', 'fetch'], { filename: path })(
      name => name.startsWith('.') ? load(resolve(dirname(path), name)) : req(name), module, module.exports, path, dirname(path), fakeFetch,
    )
    return module.exports
  }
  const video = load(resolve(root, 'backend-node/src/services/videoClient.js'))
  const image = load(resolve(root, 'backend-node/src/services/imageClient.js'))
  const common = { provider, model, prompt: 'retain every reference', storage_local_path: home, files_base_url: 'http://127.0.0.1:5679/static', aspect_ratio: '1:1' }
  return {
    posts, uploads: () => uploads,
    video: opts => video.callVideoApi(db, log, { ...common, ...opts }),
    image: opts => image.callImageApi(db, log, { ...common, ...opts }),
  }
}

test('reference planner composes with model selection and rejects fixed or drifted functions', { skip: !available }, () => {
  const selected = new Map(planModelSelection(root, pristine))
  const edits = planReferences(root, path => selected.get(path) ?? pristine(path))
  assert.equal(edits.length, 2)
  for (const [, source] of edits) compileFunction(source, ['require', 'module', 'exports'])
  const fixed = new Map(edits)
  assert.throws(() => planReferences(root, path => fixed.get(path) ?? pristine(path)), /reference-input function changed/)
  assert.throws(() => planReferences(root, path => pristine(path).replace('if (!resolved) continue;', 'if (!resolved) return null;')), /reference-input function changed/)
})

test('Agnes refuses unresolved first, last and partial omni references before POST', { skip: !available }, async t => {
  for (const reference of [
    { first_frame_url: '/static/missing.png' },
    { last_frame_url: '/static/missing.png' },
    { reference_urls: ['https://references.fixture.invalid/present.png', '/static/missing.png'] },
  ]) {
    const f = fixture(t, 'agnes', 'agnes', 'agnes-video-2.5-flash')
    await assert.rejects(() => f.video(reference), { code: 'REFERENCE_INPUT_UNAVAILABLE' })
    assert.equal(f.posts.length, 0)
  }
  const f = fixture(t, 'agnes', 'agnes', 'agnes-video-2.5-flash')
  await f.video({ first_frame_url: 'https://references.fixture.invalid/present.png' })
  assert.equal(f.posts.length, 1)
  assert.equal(f.posts[0].body.mode, 'keyframe')
  assert.ok(JSON.stringify(f.posts[0].body).includes('https://references.fixture.invalid/present.png'))
})

test('Vidu refuses missing local references and forwards public first frames', { skip: !available }, async t => {
  const f = fixture(t, 'vidu', 'vidu', 'viduq2')
  await assert.rejects(() => f.video({ image_url: 'http://127.0.0.1:5679/static/missing.png' }), { code: 'REFERENCE_INPUT_UNAVAILABLE' })
  assert.equal(f.posts.length, 0)
  await f.video({ first_frame_url: 'https://references.fixture.invalid/present.png' })
  assert.equal(f.posts.length, 1)
  assert.deepEqual(f.posts[0].body.images, ['https://references.fixture.invalid/present.png'])
  await assert.rejects(() => f.video({ last_frame_url: 'https://references.fixture.invalid/present.png' }), { code: 'REFERENCE_INPUT_UNAVAILABLE' })
  assert.equal(f.posts.length, 1)
})

test('Gemini keeps inline references and refuses missing, unreadable, excessive or proxy-skipped inputs', { skip: !available }, async t => {
  for (const [options, refs] of [
    [{}, ['https://references.fixture.invalid/missing.png']],
    [{}, ['/static/missing.png']],
    [{}, ['data:malformed']],
    [{}, Array(5).fill(inline)],
    [{ geminiProxy: true }, [inline]],
  ]) {
    const f = fixture(t, 'gemini', 'gemini', 'gemini-2.5-flash-image', options)
    await assert.rejects(() => f.image({ reference_image_urls: refs }), { code: 'REFERENCE_INPUT_UNAVAILABLE' })
    assert.equal(f.posts.length, 0)
  }
  const f = fixture(t, 'gemini', 'gemini', 'gemini-2.5-flash-image')
  await f.image({ reference_image_urls: [inline, 'http://127.0.0.1:5679/static/reference.png', '/static/reference.png'] })
  assert.equal(f.posts.length, 1)
  const parts = f.posts[0].body.contents[0].parts
  assert.equal(parts.filter(part => part.inlineData).length, 3)
  assert.equal(f.uploads(), 0)
})

test('Sora and Jimeng refuse partial reference resolution before generation', { skip: !available }, async t => {
  const single = fixture(t, 'openai', 'sora', 'sora-2')
  await assert.rejects(() => single.video({ image_url: 'https://references.fixture.invalid/missing.png' }), { code: 'REFERENCE_INPUT_UNAVAILABLE' })
  assert.equal(single.posts.length, 0)
  await single.video({ image_url: '/static/reference.png' })
  assert.equal(single.posts.length, 1)
  assert.ok(single.posts[0].body.includes(Buffer.from('input_reference')))
  const multi = fixture(t, 'openai', 'sora', 'sora-2', { settings: { supports_universal_omni: true } })
  await assert.rejects(() => multi.video({ reference_urls: [inline, 'http://127.0.0.1:5679/static/missing.png'] }), { code: 'REFERENCE_INPUT_UNAVAILABLE' })
  assert.equal(multi.posts.length, 0)
  await multi.video({ image_url: inline, reference_urls: ['https://references.fixture.invalid/present.png'] })
  assert.equal(multi.posts[0].body.images.length, 2)
  const jimeng = fixture(t, 'jimeng_ai_api', 'jimeng_ai_api', 'jimeng-video-3.0')
  await assert.rejects(() => jimeng.video({ reference_urls: [inline, '/static/missing.png'] }), { code: 'REFERENCE_INPUT_UNAVAILABLE' })
  assert.equal(jimeng.posts.length, 0)
})

test('Omni retains supported base64 fallback and rejects unreadable references or limits', { skip: !available }, async t => {
  const f = fixture(t, 'klingai', 'kling_omni', 'kling-video-o1')
  await f.video({ reference_urls: ['http://127.0.0.1:5679/static/reference.png'] })
  assert.equal(f.posts.length, 1)
  assert.equal(f.posts[0].body.image_list[0].image_url, inline)
  await f.video({ reference_urls: ['/static/reference.png'] })
  assert.equal(f.posts.length, 2)
  assert.equal(f.posts[1].body.image_list[0].image_url, inline)
  await assert.rejects(() => f.video({ reference_urls: ['/static/missing.png'] }), { code: 'REFERENCE_INPUT_UNAVAILABLE' })
  assert.equal(f.posts.length, 2)
  const volc = fixture(t, 'volcengine', 'volcengine_omni', 'doubao-seedance-2-0-fast-260128')
  await assert.rejects(() => volc.video({ reference_urls: Array(10).fill(inline) }), { code: 'REFERENCE_INPUT_UNAVAILABLE' })
  assert.equal(volc.posts.length, 0)
})

test('DashScope awaits reference conversion and rejects unsupported reference modes', { skip: !available }, async t => {
  const f = fixture(t, 'dashscope', 'dashscope', 'wan2.6-r2v-flash')
  await f.video({ reference_urls: ['https://references.fixture.invalid/present.png'] })
  assert.equal(f.posts.length, 1)
  assert.deepEqual(f.posts[0].body.input.reference_urls, ['https://references.fixture.invalid/present.png'])
  await f.video({ reference_urls: [inline] })
  assert.deepEqual(f.posts[1].body.input.reference_urls, [inline])
  await assert.rejects(() => f.video({ reference_urls: Array(6).fill(inline) }), { code: 'REFERENCE_INPUT_UNAVAILABLE' })
  assert.equal(f.posts.length, 2)
  const t2v = fixture(t, 'dashscope', 'dashscope', 'wan2.6-t2v')
  await assert.rejects(() => t2v.video({ image_url: inline }), { code: 'REFERENCE_INPUT_UNAVAILABLE' })
  assert.equal(t2v.posts.length, 0)
  const qwen = fixture(t, 'qwen_image', 'dashscope', 'qwen-image-3.0')
  await assert.rejects(() => qwen.image({ reference_image_urls: [inline] }), { code: 'REFERENCE_INPUT_UNAVAILABLE' })
  assert.equal(qwen.posts.length, 0)
  const kling = fixture(t, 'kling', 'kling', 'kling-image')
  await assert.rejects(() => kling.image({ reference_image_urls: [inline, inline] }), { code: 'REFERENCE_INPUT_UNAVAILABLE' })
  assert.equal(kling.posts.length, 0)
})
