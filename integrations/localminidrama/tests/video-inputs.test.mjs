/** Run pinned video routes and queued work with private SQLite and captured provider requests. */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { compileFunction } from 'node:vm'
import { planModelSelection } from '../compatibility/model-selection.mjs'
import { planReferences } from '../compatibility/references.mjs'
import { planVideoInputs } from '../compatibility/video-inputs.mjs'
import { planModelCapabilities } from '../compatibility/model-capabilities.mjs'

const root = resolve(process.env.LOCALMINIDRAMA_SOURCE || '.local/localminidrama')
const available = existsSync(resolve(root, 'backend-node/node_modules/better-sqlite3'))
const pristineSources = new Map()
const owners = []
const log = { info() {}, warn() {}, error() {} }
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKzUAAAAASUVORK5CYII=', 'base64')
const refs = count => Array.from({ length: count }, (_, index) => `https://references.fixture.invalid/${index}.png`)

test('Seedance 2.5 preserves a twenty-second package and rejects unsupported explicit lengths before supplier dispatch', { skip: !available }, async () => {
  const model = 'doubao-seedance-2.5-260628'
  const f = fixture('volcengine', 'volcengine_omni', model)
  await f.run({ duration: 20 })
  assert.equal(f.posts.length, 1)
  assert.equal(f.posts[0].body.duration, 20)
  assert.equal(f.client.normalizeVolcengineDuration(model, -1), -1)
  for (const duration of [0, 3, 31, 4.5]) assert.throws(() => f.client.normalizeVolcengineDuration(model, duration), /4–30/)
  const invalid = fixture('volcengine', 'volcengine_omni', model)
  await invalid.run({ duration: 31 })
  assert.equal(invalid.posts.length, 0)
})

test('Seedance 2.5 first and last frames follow the source aspect ratio required by Ark', { skip: !available }, async () => {
  const f = fixture('volcengine', 'volcengine', 'doubao-seedance-2.5-260628')
  await f.run({ duration: 20, aspect_ratio: '16:9', first_frame_url: refs(1)[0] })
  assert.equal(f.posts.length, 1)
  assert.equal(f.posts[0].body.ratio, 'adaptive')
  assert.equal(f.posts[0].body.aspect_ratio, undefined)
})

test('video polling passes actual supplier usage to the original resource without another generation request', { skip: !available }, async () => {
  const f = fixture('volcengine', 'volcengine_omni', 'doubao-seedance-2.5-260628')
  const payload = { id: 'original-provider-task', status: 'succeeded', content: { video_url: 'https://result.fixture/finished.mp4' },
    usage: { completion_tokens: 108900, total_tokens: 108900 } }
  f.replyPoll(payload)
  const result = await f.client.pollVideoTask(f.db, log, 41, payload.id, { provider: 'volcengine', api_protocol: 'volcengine_omni',
    base_url: 'https://model.fixture.invalid', api_key: 'fixture-only', model: 'doubao-seedance-2.5-260628' }, 1, 0)
  assert.equal(result.video_url, payload.content.video_url)
  assert.equal(f.posts.length, 0)
  assert.equal(f.observedUsage.length, 1)
  assert.equal(f.observedUsage[0][0], f.db)
  assert.deepEqual(f.observedUsage[0].slice(1), ['video', 41, payload, payload.id])
})

// Native statement owners outlive module compilation, including Windows addon finalizers.
after(() => { for (const { db } of owners) db.close() })

function pristine(path) {
  const name = relative(root, path).split(sep).join('/')
  if (!pristineSources.has(name)) pristineSources.set(name, execFileSync('git', ['-C', root, 'show', `3fbcda9713ca545979dff9e75d21bed53694188f:${name}`], { encoding: 'utf8', maxBuffer: 2e6 }))
  return pristineSources.get(name)
}

function fixture(provider, protocol, model, patched = true, settings) {
  const upstream = createRequire(resolve(root, 'backend-node/package.json'))
  const Database = upstream('better-sqlite3')
  const db = new Database(':memory:')
  const owner = { db, statements: [] }
  owners.push(owner)
  const prepare = db.prepare.bind(db)
  db.prepare = (...args) => { const statement = prepare(...args); owner.statements.push(statement); return statement }
  const sources = new Map()
  for (const planner of [planModelSelection, planReferences, ...(patched ? [planVideoInputs, planModelCapabilities] : [])]) {
    for (const [path, source] of planner(root, path => sources.get(path) ?? pristine(path))) sources.set(path, source)
  }
  const modules = new Map()
  const posts = []
  const observedUsage = []
  let pollReply
  const scheduled = []
  const cfg = { storage: { local_path: 'unused-video-fixture-storage', base_url: '' }, style: {}, image_proxy: { enabled: false } }
  const overrides = new Map([
    [resolve(root, 'backend-node/src/services/museAdmission.js'), { recordResourceUsage: (...args) => { observedUsage.push(args); return true } }],
    [resolve(root, 'backend-node/src/config/index.js'), { loadConfig: () => cfg }],
    [resolve(root, 'backend-node/src/services/uploadService.js'), { uploadLocalImageToProxy: async () => null, uploadToImageProxy: async () => null }],
  ])
  const fakeFetch = async (url, options = {}) => {
    if (!options.method || options.method === 'GET') return pollReply === undefined
      ? new Response(pixel, { headers: { 'content-type': 'image/png' } }) : Response.json(pollReply)
    assert.equal(options.method, 'POST')
    posts.push({ url, body: typeof options.body === 'string' ? JSON.parse(options.body) : options.body })
    return new Response(JSON.stringify({ error: { message: 'Fixture stops after captured submission' } }), { status: 400 })
  }
  function load(path) {
    path = sources.has(path) || overrides.has(path) ? path
      : sources.has(path + '.js') || overrides.has(path + '.js') ? path + '.js' : upstream.resolve(path)
    if (overrides.has(path)) return overrides.get(path)
    if (modules.has(path)) return modules.get(path).exports
    const module = { exports: {} }
    modules.set(path, module)
    const req = createRequire(path)
    compileFunction(sources.get(path) ?? pristine(path), ['require', 'module', 'exports', '__filename', '__dirname', 'fetch', 'setImmediate', 'console'], { filename: path })(
      name => name.startsWith('.') ? load(resolve(dirname(path), name)) : req(name), module, module.exports, path, dirname(path), fakeFetch,
      fn => scheduled.push(fn), { ...console, log() {}, warn() {} },
    )
    return module.exports
  }
  const get = file => load(resolve(root, 'backend-node/src', file))
  get('db/migrate.js').runMigrationsAndEnsure(db)
  get('services/aiConfigService.js').createConfig(db, log, {
    service_type: 'video', name: 'video input fixture', provider, api_protocol: protocol, model: [model], default_model: model,
    base_url: 'https://model.fixture.invalid', api_key: 'fixture-only', is_default: true, settings: settings ? JSON.stringify(settings) : undefined,
  })
  const route = get('routes/videos.js')(db, log)
  const service = get('services/videoService.js')
  return {
    db, posts, scheduled, observedUsage, replyPoll(value) { pollReply = value },
    client: get('services/videoClient.js'),
    create(body) {
      const res = { status(code) { this.statusCode = code; return this }, json(value) { this.body = value } }
      route.create({ body: { provider, model, prompt: 'retain requested images', ...body }, params: {}, query: {} }, res)
      return res
    },
    async run(body) {
      const response = this.create(body)
      assert.equal(response.statusCode, 201, JSON.stringify(response.body))
      await service.processVideoGeneration(db, log, response.body.data.id)
      return service.getById(db, response.body.data.id)
    },
  }
}

test('video input planner rejects fixed and drifted sources', { skip: !available }, () => {
  const sources = new Map(planModelSelection(root, pristine))
  for (const [path, source] of planReferences(root, path => sources.get(path) ?? pristine(path))) sources.set(path, source)
  const edits = planVideoInputs(root, path => sources.get(path) ?? pristine(path))
  assert.equal(edits.length, 3)
  for (const [, source] of edits) compileFunction(source, ['require', 'module', 'exports'])
  const fixed = new Map(edits)
  assert.throws(() => planVideoInputs(root, path => fixed.get(path) ?? sources.get(path) ?? pristine(path)), /pinned source/)
  assert.throws(() => planVideoInputs(root, path => (sources.get(path) ?? pristine(path)).replace('body.reference_image_urls.slice(0, 10)', 'body.reference_image_urls.slice(0, 9)')), /pinned source/)
})

test('raw audio fields cannot be silently dropped or create a paid video task', { skip: !available }, () => {
  const f = fixture('volcengine', 'volcengine_omni', 'doubao-seedance-2.5-260628')
  for (const body of [{ reference_audio_urls: ['https://audio.fixture/reference.wav'] }, { voice_reference_url: 'https://audio.fixture/reference.wav' },
    { formal_voice_references: [] }, { content: [{ type: 'audio_url', audio_url: { url: 'https://audio.fixture/reference.wav' }, role: 'reference_audio' }] }]) {
    assert.equal(f.create(body).statusCode, 400)
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM video_generations').get().n, 0)
  assert.equal(f.scheduled.length, 0); assert.equal(f.posts.length, 0)
})

test('pinned queue drops mixed frames and route truncates requested references', { skip: !available }, async () => {
  const mixed = fixture('minimax_h3', 'minimax_h3', 'MiniMax-H3', false)
  await mixed.run({ first_frame_url: 'https://references.fixture.invalid/first.png', reference_image_urls: refs(2) })
  assert.equal(mixed.posts.length, 1)
  assert.deepEqual(mixed.posts[0].body.content.filter(item => item.type === 'image_url').map(item => item.role), ['reference_image', 'reference_image'])
  const capped = fixture('agnes', 'agnes', 'agnes-video-2.0', false)
  const row = await capped.run({ reference_image_urls: refs(11) })
  assert.equal(JSON.parse(capped.db.prepare('SELECT reference_image_urls FROM video_generations WHERE id = ?').get(row.id).reference_image_urls).length, 10)
  assert.equal(capped.posts[0].body.extra_body.image.length, 10)
})

test('route refuses malformed or duplicate references before creating tasks', { skip: !available }, () => {
  const f = fixture('agnes', 'agnes', 'agnes-video-2.5-flash')
  for (const reference_image_urls of ['https://references.fixture.invalid/0.png', [null], [42], [{}], [''], ['  '], [refs(1)[0], ` ${refs(1)[0]} `]]) {
    assert.equal(f.create({ reference_image_urls }).statusCode, 400)
  }
  assert.equal(f.create({ first_frame_url: 12 }).statusCode, 400)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM async_tasks').get().count, 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM video_generations').get().count, 0)
  assert.equal(f.scheduled.length, 0)
  assert.equal(f.posts.length, 0)
})

test('mixed frame requests reach adapter validation without submitting a reduced request', { skip: !available }, async () => {
  for (const [provider, protocol, model, body] of [
    ['minimax_h3', 'minimax_h3', 'MiniMax-H3', { first_frame_url: 'https://references.fixture.invalid/first.png', reference_image_urls: refs(2) }],
    ['agnes', 'agnes', 'agnes-video-2.5-flash', { last_frame_url: 'https://references.fixture.invalid/last.png', reference_image_urls: refs(2) }],
    ['dashscope', 'dashscope', 'wan2.6-r2v-flash', { image_url: 'https://references.fixture.invalid/main.png', reference_image_urls: refs(2) }],
    ['dashscope', 'dashscope', 'wan2.6-i2v-flash', { image_url: 'https://references.fixture.invalid/main.png', last_frame_url: 'https://references.fixture.invalid/last.png' }],
    ['volcengine', 'volcengine', 'doubao-seedance-2-0-fast-260128', { last_frame_url: 'https://references.fixture.invalid/last.png', reference_image_urls: refs(2) }],
    ['veo3', 'veo3', 'veo3', { reference_image_urls: refs(1) }],
  ]) {
    const f = fixture(provider, protocol, model)
    assert.equal((await f.run(body)).status, 'failed')
    assert.equal(f.posts.length, 0, protocol)
  }
})

test('provider reference counts reject the complete saved list before POST', { skip: !available }, async () => {
  for (const [provider, protocol, model, count, settings] of [
    ['agnes', 'agnes', 'agnes-video-2.5-flash', 6], ['agnes', 'agnes', 'agnes-video-2.5', 10], ['agnes', 'agnes', 'agnes-video-2.0', 11],
    ['xai', 'xai', 'grok-video-3', 11], ['minimax_h3', 'minimax_h3', 'MiniMax-H3', 10],
    ['dashscope', 'dashscope', 'wanx2.1-vace-plus', 4], ['dashscope', 'dashscope', 'wan2.6-r2v-flash', 6],
    ['volcengine', 'volcengine_omni', 'doubao-seedance-2-0-fast-260128', 10],
    ['openai', 'sora', 'sora-2', 10, { supports_universal_omni: true }],
  ]) {
    const f = fixture(provider, protocol, model, true, settings)
    const row = await f.run({ reference_image_urls: refs(count) })
    assert.equal(row.status, 'failed')
    assert.equal(JSON.parse(f.db.prepare('SELECT reference_image_urls FROM video_generations WHERE id = ?').get(row.id).reference_image_urls).length, count)
    assert.equal(f.posts.length, 0, `${protocol}/${model}`)
  }
})

test('supported first and last frames and primary plus references survive queued generation', { skip: !available }, async () => {
  const first = 'https://references.fixture.invalid/first.png'
  const last = 'https://references.fixture.invalid/last.png'
  const frames = fixture('minimax_h3', 'minimax_h3', 'MiniMax-H3')
  await frames.run({ first_frame_url: first, last_frame_url: last })
  assert.deepEqual(frames.posts[0].body.content.filter(item => item.type === 'image_url').map(item => [item.role, item.image_url.url]), [['first_frame', first], ['last_frame', last]])
  const omni = fixture('volcengine', 'volcengine_omni', 'doubao-seedance-2-0-fast-260128')
  await omni.run({ image_url: first, reference_image_urls: refs(2) })
  assert.deepEqual(omni.posts[0].body.content.filter(item => item.type === 'image_url').map(item => item.image_url.url), [first, ...refs(2)])
  const agnes = fixture('agnes', 'agnes', 'agnes-video-2.5-flash')
  await agnes.run({ reference_image_urls: refs(5) })
  assert.deepEqual(agnes.posts[0].body.images, refs(5))
})

test('direct client rejects malformed and unresolved references before POST', { skip: !available }, async () => {
  const f = fixture('xai', 'xai', 'grok-video-3')
  for (const opts of [
    { reference_urls: [false] }, { reference_urls: refs(11) }, { reference_urls: [refs(1)[0], refs(1)[0]] },
    { image_url: '/static/missing.png' }, { reference_urls: ['/static/missing.png'] },
  ]) {
    await assert.rejects(() => f.client.callVideoApi(f.db, log, { provider: 'xai', model: 'grok-video-3', prompt: 'retain references', ...opts }), { code: 'REFERENCE_INPUT_UNAVAILABLE' })
  }
  assert.equal(f.posts.length, 0)
})
