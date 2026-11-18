/** Execute the pinned upstream modules with private SQLite and instance-local request adapters. */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire, Module } from 'node:module'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve, sep } from 'node:path'
import { planModelSelection } from '../compatibility/model-selection.mjs'

const revision = '3fbcda9713ca545979dff9e75d21bed53694188f'
const root = resolve(process.env.LOCALMINIDRAMA_SOURCE || '.local/localminidrama')
const installed = existsSync(resolve(root, 'backend-node/node_modules/better-sqlite3'))
const pristineSources = new Map()
const log = { info() {}, warn() {}, error() {} }
// Keep native statements owned until module compilation ends; Windows addon finalizers need Node's active environment.
const databaseOwners = []
after(() => {
  for (const { db, home } of databaseOwners) {
    if (db) db.close()
    rmSync(home, { recursive: true, force: true })
  }
})

function pristine(path) {
  const name = relative(root, path).split(sep).join('/')
  if (!pristineSources.has(name)) {
    pristineSources.set(name, execFileSync('git', ['-C', root, 'show', `${revision}:${name}`], { encoding: 'utf8', maxBuffer: 2e6 }))
  }
  return pristineSources.get(name)
}

function fixture(t, patched = true) {
  const upstreamRequire = createRequire(resolve(root, 'backend-node/package.json'))
  const Database = upstreamRequire('better-sqlite3')
  const home = mkdtempSync(resolve(tmpdir(), 'muse-lmd-model-'))
  const owner = { home, statements: [] }
  databaseOwners.push(owner)
  const db = new Database(resolve(home, 'model.db'))
  owner.db = db
  const statements = owner.statements
  const prepare = db.prepare.bind(db)
  db.prepare = (...args) => { const statement = prepare(...args); statements.push(statement); return statement }
  const modules = new Map()
  const scheduled = []
  const requests = []
  const sources = new Map(patched ? planModelSelection(root, pristine) : [])
  const cfg = { storage: { local_path: 'unused-model-test-storage', base_url: '' }, style: {} }
  const fakeImagePost = async (url, headers, body) => {
    requests.push({ url, body })
    return { statusCode: 200, raw: JSON.stringify({ data: [{ url: 'https://fixture.invalid/result.png' }] }) }
  }
  const fakeFetch = async (url, options) => {
    assert.equal(options.method, 'POST', 'fixture permits only generation submission')
    requests.push({ url, body: JSON.parse(options.body) })
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'fixture-task-id' }) }
  }
  const overrides = new Map([
    [resolve(root, 'backend-node/src/config/index.js'), { loadConfig: () => cfg }],
    [resolve(root, 'backend-node/src/services/aiClient.js'), {
      postJSONWithTimeout: fakeImagePost,
      generateText() { throw new Error('Unexpected text model call in model selection fixture') },
    }],
    [resolve(root, 'backend-node/src/services/uploadService.js'), {}],
  ])
  const fakeHttp = {
    request(options, receive) {
      const req = new EventEmitter()
      let body
      req.write = data => { body = JSON.parse(data) }
      req.destroy = () => req.emit('close')
      req.end = () => queueMicrotask(() => {
        requests.push({ url: `https://${options.hostname}${options.path}`, body })
        const res = new EventEmitter()
        res.statusCode = 200
        receive(res)
        res.emit('data', Buffer.from(body.stream
          ? 'data: {"choices":[{"delta":{"content":"fixture text"}}]}\n\ndata: [DONE]\n\n'
          : '{"choices":[{"message":{"content":"fixture text"}}]}'))
        res.emit('end')
        req.emit('close')
      })
      return req
    },
  }
  function load(path, actual = false) {
    path = upstreamRequire.resolve(path)
    if (!actual && overrides.has(path)) return overrides.get(path)
    if (modules.has(path)) return modules.get(path).exports
    const module = new Module(path)
    modules.set(path, module)
    module.require = spec => spec.startsWith('.') ? load(resolve(dirname(path), spec)) : ['http', 'https'].includes(spec) ? fakeHttp : upstreamRequire(spec)
    const source = sources.get(path) ?? pristine(path)
    module.fixture = { setImmediate: fn => scheduled.push(fn), fetch: fakeFetch, console: { ...console, log() {}, warn() {} } }
    module._compile('const { setImmediate, fetch, console } = module.fixture;\n' + source, path)
    return module.exports
  }
  const get = file => load(resolve(root, 'backend-node/src', file))
  for (const file of ['services/videoClient.js', 'services/imageClient.js', 'routes/videos.js', 'routes/images.js', 'services/characterLibraryService.js', 'services/sceneService.js', 'services/propImageGenerationService.js']) get(file)
  get('db/migrate.js').runMigrationsAndEnsure(db)
  const configService = get('services/aiConfigService.js')
  function config(serviceType, provider, models, isDefault = false) {
    return configService.createConfig(db, log, {
      service_type: serviceType, name: `model fixture ${provider}`, provider,
      base_url: `https://${provider}.fixture.invalid`, api_key: 'fixture-no-real-key',
      model: models, default_model: models.at(-1), is_default: isDefault,
      api_protocol: serviceType === 'video' ? 'volcengine' : 'openai',
    })
  }
  const count = table => db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total
  return { db, get, actual: file => load(resolve(root, 'backend-node/src', file), true), config, configService, requests, scheduled, count }
}

function invoke(handler, body) {
  const res = { status(value) { this.statusCode = value; return this }, json(value) { this.body = value } }
  handler({ body, params: {}, query: {} }, res)
  return res
}

test('model-selection planner validates all targets and composes with staged source', { skip: !installed }, t => {
  const edits = planModelSelection(root, pristine)
  assert.equal(edits.length, 11)
  const marker = '// model fixture staged history\n'
  const staged = planModelSelection(root, path => marker + pristine(path))
  for (const [, source] of staged) assert.ok(source.startsWith(marker))
  const fixed = new Map(edits)
  assert.throws(() => planModelSelection(root, path => fixed.get(path) ?? pristine(path)), /pinned source/)
  assert.throws(() => planModelSelection(root, path => pristine(path).replace('const model = body.model ?? null;', 'const model = body.selected_model;')), /pinned source/)
})

test('pinned unpatched clients reproduce silent provider/model substitution', { skip: !installed }, t => {
  const f = fixture(t, false)
  f.config('video', 'first', ['shared', 'configured-video'], true)
  f.config('video', 'second', ['shared'])
  f.config('image', 'first', ['shared', 'configured-image'], true)
  const video = f.get('services/videoClient.js')
  const image = f.get('services/imageClient.js')
  assert.equal(video.getDefaultVideoConfig(f.db, 'shared', 'second').provider, 'first')
  assert.equal(video.getDefaultVideoConfig(f.db, 'missing').provider, 'first')
  assert.equal(image.getDefaultImageConfig(f.db, 'missing', 'second').provider, 'first')
})

test('actual provider adapters honor explicit pairs and configured default models', { skip: !installed }, async t => {
  const f = fixture(t)
  for (const type of ['video', 'image']) {
    f.config(type, 'first', ['shared', `${type}-default`], true)
    f.config(type, 'second', ['shared', `${type}-second`])
  }
  const video = f.get('services/videoClient.js')
  const image = f.get('services/imageClient.js')
  await video.callVideoApi(f.db, log, { provider: 'second', model: 'shared', prompt: 'motion' })
  await image.callImageApi(f.db, log, { preferred_provider: 'second', model: 'shared', prompt: 'image' })
  await video.callVideoApi(f.db, log, { prompt: 'motion' })
  await image.callImageApi(f.db, log, { prompt: 'image' })
  assert.deepEqual(f.requests.map(({ url, body }) => [new URL(url).hostname, body.model]), [
    ['second.fixture.invalid', 'shared'], ['second.fixture.invalid', 'shared'],
    ['first.fixture.invalid', 'video-default'], ['first.fixture.invalid', 'image-default'],
  ])
  assert.equal(video.resolveVideoSelection(f.db, 'shared', 'second').provider, 'second')
  assert.equal(image.resolveImageSelection(f.db, undefined, 'second').model, 'image-second')
})

test('unknown, inactive and mismatched selections reject before rows, tasks or requests', { skip: !installed }, async t => {
  const f = fixture(t)
  for (const type of ['video', 'image']) {
    f.config(type, 'first', ['shared', `${type}-default`], true)
    f.config(type, 'second', [`${type}-second`])
    const inactive = f.config(type, 'inactive', ['disabled-model'])
    f.configService.updateConfig(f.db, log, inactive.id, { is_active: false })
  }
  const videoRoute = f.get('routes/videos.js')(f.db, log)
  const imageRoute = f.get('routes/images.js')(f.db, {}, log)
  const asset = f.get('services/imageClient.js')
  const invalid = [
    { model: 'missing' }, { provider: 'missing' }, { model: 'disabled-model' },
    { provider: 'second', model: 'shared' }, { provider: 'inactive', model: 'disabled-model' },
    { provider: '' }, { model: [] },
  ]
  for (const body of invalid) {
    assert.equal(invoke(videoRoute.create, body).statusCode, 400)
    assert.equal(invoke(imageRoute.create, body).statusCode, 400)
    assert.throws(() => asset.createAndGenerateImage(f.db, log, body), { code: 'MODEL_SELECTION_INVALID' })
    await assert.rejects(() => f.get('services/videoClient.js').callVideoApi(f.db, log, body), { code: 'MODEL_SELECTION_INVALID' })
    await assert.rejects(() => asset.callImageApi(f.db, log, body), { code: 'MODEL_SELECTION_INVALID' })
  }
  assert.equal(f.count('video_generations'), 0)
  assert.equal(f.count('image_generations'), 0)
  assert.equal(f.count('async_tasks'), 0)
  assert.equal(f.requests.length, 0)
  assert.equal(f.scheduled.length, 0)
})

test('direct and asset creates persist the resolved provider/model before scheduling', { skip: !installed }, t => {
  const f = fixture(t)
  for (const type of ['video', 'image', 'storyboard_image']) {
    f.config(type, 'first', ['shared', `${type}-default`], true)
    f.config(type, 'second', ['shared'])
  }
  const videos = f.get('routes/videos.js')(f.db, log)
  const images = f.get('routes/images.js')(f.db, {}, log)
  for (const body of [{}, { provider: 'second', model: 'shared' }]) {
    const video = invoke(videos.create, body)
    const image = invoke(images.create, body)
    assert.equal(video.statusCode, 201)
    assert.equal(image.statusCode, 201)
    assert.equal(video.body.data.provider, body.provider || 'first')
    assert.equal(video.body.data.model, body.model || 'video-default')
    assert.equal(image.body.data.provider, body.provider || 'first')
    assert.equal(image.body.data.model, body.model || 'image-default')
  }
  const storyboard = invoke(images.create, { storyboard_id: 22 }).body.data
  assert.equal(storyboard.model, 'storyboard_image-default')
  const asset = f.get('services/imageClient.js').createAndGenerateImage(f.db, log, {})
  assert.equal(asset.provider, 'first')
  assert.equal(asset.model, 'image-default')
  assert.equal(f.requests.length, 0)
})

test('queued work and resumed polling reject removed models without using another default', { skip: !installed }, async t => {
  const f = fixture(t)
  const original = f.config('video', 'first', ['old-model'], true)
  f.config('video', 'second', ['new-model'])
  const routes = f.get('routes/videos.js')(f.db, log)
  const row = invoke(routes.create, {}).body.data
  f.db.prepare('UPDATE video_generations SET provider_task_id = ? WHERE id = ?').run('paid-task-retained', row.id)
  f.configService.deleteConfig(f.db, log, original.id)
  const service = f.get('services/videoService.js')
  await service.resumePollForVideoGeneration(f.db, log, row.id)
  const failed = service.getById(f.db, row.id)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.provider, 'first')
  assert.equal(failed.model, 'old-model')
  assert.match(failed.error_msg, /AI 配置/)
  const tasks = f.count('async_tasks')
  const resume = service.resumeFailedVideoPoll(f.db, log, row.id)
  assert.equal(resume.ok, false)
  assert.equal(resume.status, 400)
  assert.equal(f.count('async_tasks'), tasks)
  assert.equal(service.getById(f.db, row.id).status, 'failed')
  await service.processVideoGeneration(f.db, log, row.id)
  const imageConfig = f.config('image', 'first', ['old-image'], true)
  f.config('image', 'second', ['new-image'])
  const image = f.get('services/imageService.js').create(f.db, log, {})
  const asset = f.get('services/imageClient.js').createAndGenerateImage(f.db, log, {})
  f.configService.deleteConfig(f.db, log, imageConfig.id)
  await f.get('services/imageService.js').processImageGeneration(f.db, log, image.id)
  assert.equal(f.get('services/imageService.js').getById(f.db, image.id).status, 'failed')
  await f.scheduled.at(-1)()
  const assetFailed = f.db.prepare('SELECT * FROM image_generations WHERE id = ?').get(asset.id)
  assert.equal(assetFailed.status, 'failed')
  assert.equal(assetFailed.provider, 'first')
  assert.equal(assetFailed.model, 'old-image')
  assert.equal(f.requests.length, 0)
})

test('character, scene and prop preflight rejects missing image model before prompt calls', { skip: !installed }, async t => {
  const f = fixture(t)
  f.config('image', 'configured', ['image-default'], true)
  const characters = f.get('services/characterLibraryService.js')
  const scenes = f.get('services/sceneService.js')
  assert.throws(() => characters.generateCharacterImage(f.db, log, {}, 1, 'missing'), { code: 'MODEL_SELECTION_INVALID' })
  await assert.rejects(() => characters.generateCharacterFourViewImage(f.db, log, {}, 1, 'missing'), { code: 'MODEL_SELECTION_INVALID' })
  await assert.rejects(() => scenes.generateSceneFourViewImage(f.db, log, {}, 1, 'missing'), { code: 'MODEL_SELECTION_INVALID' })
  await assert.rejects(() => scenes.generateSceneSingleImage(f.db, log, {}, 1, 'missing'), { code: 'MODEL_SELECTION_INVALID' })
  f.db.prepare("INSERT INTO props (drama_id, name, prompt) VALUES (0, 'fixture', 'prop prompt')").run()
  const id = f.db.prepare('SELECT last_insert_rowid() AS id').get().id
  assert.throws(() => f.get('services/propImageGenerationService.js').generatePropImage(f.db, log, id, { model: 'missing' }), { code: 'MODEL_SELECTION_INVALID' })
  assert.equal(f.count('async_tasks'), 0)
  assert.equal(f.requests.length, 0)
})

test('text and vision reject unsupported native protocols and missing configured models', { skip: !installed }, async t => {
  const f = fixture(t)
  const compatible = f.config('text', 'compatible', ['first-text', 'default-text'], true)
  const ai = f.actual('services/aiClient.js')
  assert.equal(await ai.generateText(f.db, log, 'text', 'prompt', ''), 'fixture text')
  assert.equal(f.requests.at(-1).body.model, 'default-text')
  assert.equal(await ai.streamGenerateText(f.db, log, 'text', 'prompt', '', {}, () => {}), 'fixture text')
  assert.equal(await ai.generateTextWithVision(f.db, log, 'text', 'prompt', '', { imageUrl: 'https://fixture.invalid/input.png' }), 'fixture text')
  const requestCount = f.requests.length
  await assert.rejects(() => ai.generateText(f.db, log, 'text', 'prompt', '', { model: 'missing', scene_key: 'episode_generation' }), { code: 'MODEL_SELECTION_INVALID' })
  await assert.rejects(() => ai.streamGenerateText(f.db, log, 'text', 'prompt', '', { model: 'missing' }, () => {}), { code: 'MODEL_SELECTION_INVALID' })
  await assert.rejects(() => ai.generateTextWithVision(f.db, log, 'text', 'prompt', '', { imageUrl: 'https://fixture.invalid/input.png' }, { model: 'missing' }), { code: 'MODEL_SELECTION_INVALID' })
  f.configService.updateConfig(f.db, log, compatible.id, { default_model: 'removed-default' })
  await assert.rejects(() => ai.generateText(f.db, log, 'text', 'prompt', ''), { code: 'MODEL_SELECTION_INVALID' })
  for (const settings of [
    { api_protocol: 'gemini', endpoint: '/v1beta/models/{model}:generateContent' },
    { api_protocol: 'openai', endpoint: '/v1/messages' },
    { api_protocol: '', provider: 'gemini', endpoint: '' },
  ]) {
    f.configService.updateConfig(f.db, log, compatible.id, { ...settings, default_model: 'default-text' })
    await assert.rejects(() => ai.generateText(f.db, log, 'text', 'prompt', ''), { code: 'TEXT_PROTOCOL_UNSUPPORTED' })
  }
  assert.equal(f.requests.length, requestCount)
  f.configService.updateConfig(f.db, log, compatible.id, { provider: 'gemini', api_protocol: 'openai', endpoint: '/chat/completions' })
  assert.equal(await ai.generateText(f.db, log, 'text', 'prompt', ''), 'fixture text')
  assert.equal(f.requests.at(-1).body.model, 'default-text')
})
