/** Asset generation runs pinned modules against private SQLite and instance-local media fixtures. */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire, Module } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve, sep } from 'node:path'
import { planModelSelection } from '../compatibility/model-selection.mjs'
import { planStoryboardCompatibility } from '../compatibility/storyboards.mjs'
import { planVerification } from '../compatibility/verification.mjs'
import { planMediaAdoption } from '../compatibility/media-adoption.mjs'
import { planAssetMedia } from '../compatibility/asset-media.mjs'

const root = resolve(process.env.LOCALMINIDRAMA_SOURCE || '.local/localminidrama')
const installed = existsSync(resolve(root, 'backend-node/node_modules/better-sqlite3'))
const revision = '3fbcda9713ca545979dff9e75d21bed53694188f'
const pristineSources = new Map()
const databaseOwners = []
const log = { info() {}, warn() {}, error() {} }

after(() => {
  for (const { db, home } of databaseOwners) {
    db.close()
    rmSync(home, { recursive: true, force: true })
  }
})

function pristine(path) {
  const file = relative(root, path).split(sep).join('/')
  if (!pristineSources.has(file)) pristineSources.set(file,
    execFileSync('git', ['-C', root, 'show', `${revision}:${file}`], { encoding: 'utf8', maxBuffer: 3e6 }))
  return pristineSources.get(file)
}

async function fixture(mode = 'valid', patched = true) {
  const upstream = createRequire(resolve(root, 'backend-node/package.json'))
  const home = mkdtempSync(resolve(tmpdir(), 'muse-lmd-assets-'))
  const Database = upstream('better-sqlite3')
  const db = new Database(resolve(home, 'assets.db'))
  const statements = []
  const prepare = db.prepare.bind(db)
  db.prepare = (...args) => { const statement = prepare(...args); statements.push(statement); return statement }
  databaseOwners.push({ db, home, statements })
  const storage = resolve(home, 'storage')
  const cfg = { storage: { local_path: storage, base_url: '' }, style: {} }
  const sources = new Map()
  const readSource = path => sources.get(path) ?? pristine(path)
  for (const planner of [planModelSelection, planStoryboardCompatibility, planVerification, planMediaAdoption, ...patched ? [planAssetMedia] : []]) {
    for (const [path, source] of planner(root, readSource)) sources.set(path, source)
  }
  const png = await upstream('sharp')({ create: { width: 64, height: 64, channels: 3, background: '#8866aa' } }).png().toBuffer()
  const scheduled = []
  const requests = []
  let downloads = 0
  let duringDownload = () => {}
  const imageUrl = 'https://result.fixture.invalid/generated.png'
  const overrides = new Map([
    [resolve(root, 'backend-node/src/config/index.js'), { loadConfig: () => cfg }],
    [resolve(root, 'backend-node/src/utils/seedance2AssetGuards.js'), { markStaleOnCharacterMainImageDrift() {} }],
    [resolve(root, 'backend-node/src/services/aiClient.js'), {
      postJSONWithTimeout: async (url, headers, body) => {
        requests.push({ url, body })
        return { statusCode: 200, raw: JSON.stringify({ data: [{ url: imageUrl }] }) }
      },
      generateText() { throw new Error('Unexpected text generation') },
    }],
    [resolve(root, 'backend-node/src/services/uploadService.js'), {
      async downloadImageToLocal() {
        duringDownload()
        downloads++
        if (mode === 'missing') return null
        const path = `generated/image-${downloads}.png`
        mkdirSync(resolve(storage, 'generated'), { recursive: true })
        writeFileSync(resolve(storage, path), mode === 'corrupt' ? Buffer.from('provider returned HTML') : mode === 'truncated' ? png.subarray(0, 70) : png)
        return path
      },
    }],
  ])
  const modules = new Map()
  function load(path) {
    if (overrides.has(path)) return overrides.get(path)
    if (modules.has(path)) return modules.get(path).exports
    const module = new Module(path)
    modules.set(path, module)
    module.require = spec => {
      if (!spec.startsWith('.')) return upstream(spec)
      const base = resolve(dirname(path), spec)
      return load(sources.has(`${base}.js`) ? `${base}.js` : upstream.resolve(base))
    }
    module.fixture = { setImmediate: fn => scheduled.push(fn), fetch() { throw new Error('Unexpected supplier request') },
      console: { ...console, log() {}, warn() {} } }
    module._compile('const { setImmediate, fetch, console } = module.fixture;\n' + (sources.get(path) ?? pristine(path)), path)
    return module.exports
  }
  const get = file => load(resolve(root, 'backend-node/src', file))
  get('db/migrate.js').runMigrationsAndEnsure(db)
  const config = get('services/aiConfigService.js').createConfig(db, log, {
    service_type: 'image', name: 'fixture', provider: 'openai', api_protocol: 'openai',
    base_url: 'https://provider.fixture.invalid/v1', api_key: 'fixture-only', model: ['fixture-image'], is_default: true,
  })
  const drama = get('services/dramaService.js').createDrama(db, log, { title: 'asset fixture', style: 'realistic' })
  function asset(kind, chosen = false) {
    const table = { character: 'characters', scene: 'scenes', prop: 'props' }[kind]
    const common = chosen ? { image_url: null, local_path: 'chosen/previous.png' } : { image_url: null, local_path: null }
    let id
    if (kind === 'scene') id = db.prepare('INSERT INTO scenes (drama_id, location, prompt, image_url, local_path) VALUES (?, ?, ?, ?, ?)')
      .run(drama.id, '室内', 'scene prompt', common.image_url, common.local_path).lastInsertRowid
    else id = db.prepare(`INSERT INTO ${table} (drama_id, name, ${kind === 'character' ? 'appearance' : 'prompt'}, image_url, local_path) VALUES (?, ?, ?, ?, ?)`)
      .run(drama.id, '甲', 'asset prompt', common.image_url, common.local_path).lastInsertRowid
    return { id: Number(id), table, ...common }
  }
  async function generate(kind, item) {
    if (kind === 'prop') {
      const service = get('services/propImageGenerationService.js')
      const opts = { model: 'fixture-image', provider: 'openai' }
      const taskId = service.generatePropImage(db, log, item.id, opts)
      scheduled.length = 0
      await service.processPropImageGeneration(db, log, taskId, item.id, opts)
      return { taskId, generation: db.prepare('SELECT * FROM image_generations WHERE task_id = ?').get(taskId) }
    }
    const value = get('services/imageClient.js').createAndGenerateImage(db, log, {
      drama_id: drama.id, [kind === 'character' ? 'character_id' : 'scene_id']: item.id,
      prompt: 'asset prompt', model: 'fixture-image', provider: 'openai', size: '64x64',
    })
    assert.equal(scheduled.length, 1)
    await scheduled.shift()()
    return { taskId: value.task_id, generation: db.prepare('SELECT * FROM image_generations WHERE id = ?').get(value.id) }
  }
  return { db, get, sources, config, asset, generate, requests, imageUrl, storage, onDownload(fn) { duringDownload = fn } }
}

test('asset planner composes after every correction and rejects changed adoption code', { skip: !installed }, async () => {
  const f = await fixture()
  assert.ok(f.sources.has(resolve(root, 'backend-node/src/services/museAssetMedia.js')))
  assert.throws(() => planAssetMedia(root, path => f.sources.get(path) ?? pristine(path)), /pinned source/)
  assert.throws(() => planAssetMedia(root, path => pristine(path).replace('const oldPath = oldChar?.local_path', 'const oldPath = changed?.local_path')), /pinned source/)
})

test('the pinned asset helper reproduces completion despite a missing local image', { skip: !installed }, async () => {
  const f = await fixture('missing', false)
  const { generation } = await f.generate('character', f.asset('character'))
  assert.equal(generation.status, 'completed')
  assert.equal(generation.local_path, null)
})

for (const kind of ['character', 'scene', 'prop']) {
  for (const mode of ['missing', 'corrupt', 'truncated']) test(`${kind} images retain the original result and fail when the saved image is ${mode}`, { skip: !installed }, async () => {
    const f = await fixture(mode)
    const item = f.asset(kind, true)
    const { taskId, generation } = await f.generate(kind, item)
    assert.ok(generation, 'every asset result has a recoverable image generation record')
    assert.equal(generation.status, 'failed', generation.error_msg)
    assert.equal(generation.image_url, f.imageUrl)
    assert.equal(generation.local_path, mode === 'missing' ? null : 'generated/image-1.png')
    const task = f.get('services/taskService.js').getTask(f.db, taskId)
    assert.equal(task.status, 'failed')
    assert.equal(JSON.parse(task.result).image_generation_id, generation.id)
    assert.equal(JSON.parse(task.result).image_url, f.imageUrl)
    assert.equal(f.db.prepare(`SELECT local_path FROM ${item.table} WHERE id = ?`).get(item.id).local_path, item.local_path)
    assert.equal(f.requests.length, 1)
  })

  test(`${kind} completion retains an image chosen while the model request was running`, { skip: !installed }, async () => {
    const f = await fixture()
    const item = f.asset(kind)
    f.onDownload(() => {
      f.db.prepare(`UPDATE ${item.table} SET image_url = ?, local_path = ? WHERE id = ?`).run(null, 'chosen/during-generation.png', item.id)
    })
    const { generation, taskId } = await f.generate(kind, item)
    assert.equal(generation.status, 'completed', generation.error_msg)
    assert.equal(f.get('services/taskService.js').getTask(f.db, taskId).status, 'completed')
    const current = f.db.prepare(`SELECT * FROM ${item.table} WHERE id = ?`).get(item.id)
    assert.equal(current.image_url, null)
    assert.equal(current.local_path, 'chosen/during-generation.png')
    assert.deepEqual(JSON.parse(current.extra_images), [generation.local_path])
    assert.equal(f.requests.length, 1)
  })

  test(`${kind} completion adopts a decoded first image when the asset has no chosen image`, { skip: !installed }, async () => {
    const f = await fixture()
    const item = f.asset(kind)
    const { generation } = await f.generate(kind, item)
    assert.equal(generation.status, 'completed', generation.error_msg)
    const current = f.db.prepare(`SELECT * FROM ${item.table} WHERE id = ?`).get(item.id)
    assert.equal(current.image_url, f.imageUrl)
    assert.equal(current.local_path, generation.local_path)
  })
}
