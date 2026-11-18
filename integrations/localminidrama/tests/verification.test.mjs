/** Pinned connection verification without global fetch replacement or supplier calls. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, relative, resolve, sep } from 'node:path'
import { compileFunction } from 'node:vm'
import { planVerification } from '../compatibility/verification.mjs'
import { planModelSelection } from '../compatibility/model-selection.mjs'

const root = resolve(process.env.LOCALMINIDRAMA_SOURCE || '.local/localminidrama')
const upstream = createRequire(resolve(root, 'backend-node/package.json'))
const cache = new Map()
function pristine(path) {
  const name = relative(root, path).split(sep).join('/')
  if (!cache.has(name)) cache.set(name, execFileSync('git', ['-C', root, 'show', `3fbcda9713ca545979dff9e75d21bed53694188f:${name}`], { encoding: 'utf8', maxBuffer: 3e6 }))
  return cache.get(name)
}
const selected = new Map(planModelSelection(root, pristine))
const sources = new Map([...selected, ...planVerification(root, path => selected.get(path) ?? pristine(path))])
function load(file, fetch, overrides = {}) {
  const path = resolve(root, file)
  const req = createRequire(path)
  const module = { exports: {} }
  compileFunction(sources.get(path) || pristine(path), ['require', 'module', 'exports', '__filename', '__dirname', 'fetch'], { filename: path })(
    name => {
      if (Object.hasOwn(overrides, name)) return overrides[name]
      const resolved = req.resolve(name)
      if (sources.has(resolved)) return load(relative(root, resolved), fetch, overrides)
      return req(name)
    }, module, module.exports, path, dirname(path), fetch,
  )
  return module.exports
}
const log = { info() {}, warn() {}, error() {} }
const settings = { base_url: 'http://owned-model.invalid/v1', api_key: 'fixture-key', model: ['fixture-model'], provider: 'openai' }

test('all planned backend modules parse before a source transaction writes them', () => {
  for (const [path, source] of sources) if (path.endsWith('.js')) compileFunction(source, ['require', 'module', 'exports'], { filename: path })
})

test('media checks report configuration-only and never call a supplier', async () => {
  const service = load('backend-node/src/services/aiConfigService.js', () => { throw new Error('Unexpected supplier request') })
  for (const provider of ['openai', 'volcengine', 'gemini', 'dashscope', 'nano_banana']) {
    for (const service_type of ['image', 'storyboard_image', 'video', 'tts']) {
      const result = await service.testConnection({ ...settings, provider, service_type })
      assert.equal(result.verification, 'configuration_only')
      assert.equal(result.authenticated, false)
      assert.equal(result.generation_verified, false)
    }
  }
})

test('text checks reject false success envelopes and HTTP failures', async () => {
  for (const [status, data] of [[200, {}], [200, { error: { message: 'bad model' } }], [404, {}], [401, {}]]) {
    const service = load('backend-node/src/services/aiConfigService.js', async () => new Response(JSON.stringify(data), { status }))
    await assert.rejects(service.testConnection({ ...settings, service_type: 'text' }))
  }
  const service = load('backend-node/src/services/aiConfigService.js', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })))
  await service.testConnection({ ...settings, service_type: 'text' })
})

test('invalid addresses and empty model selections never reach a supplier', async () => {
  const service = load('backend-node/src/services/aiConfigService.js', () => { throw new Error('Unexpected supplier request') })
  for (const base_url of ['file:///private', 'https://user:pass@example.test', 'https://example.test/?key=secret']) {
    await assert.rejects(service.testConnection({ ...settings, base_url, service_type: 'video' }))
  }
  await assert.rejects(service.testConnection({ ...settings, model: [], service_type: 'video' }))
  await assert.rejects(service.testConnection({ ...settings, service_type: 'text', api_protocol: 'anthropic', endpoint: '/messages' }), { code: 'TEXT_PROTOCOL_UNSUPPORTED' })
})

test('a compatible Gemini gateway uses the same chat endpoint as text generation', async () => {
  const calls = []
  const service = load('backend-node/src/services/aiConfigService.js', async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
  })
  const result = await service.testConnection({ ...settings, provider: 'gemini', api_protocol: 'openai', service_type: 'text', endpoint: '/chat/completions' })
  assert.equal(result.verification, 'request_verified')
  assert.equal(calls[0].url, settings.base_url + '/chat/completions')
  assert.equal(calls[0].body.model, 'fixture-model')
})

test('the route preserves configuration-only evidence instead of asserting connectivity', async () => {
  const service = load('backend-node/src/services/aiConfigService.js', () => { throw new Error('Unexpected supplier request') })
  const routes = load('backend-node/src/routes/aiConfig.js', undefined, { '../services/aiConfigService': service })(null, log, {})
  let status, body
  const res = { status(value) { status = value; return this }, json(value) { body = value } }
  await routes.testConnection({ body: { ...settings, service_type: 'video' } }, res)
  assert.equal(status, 200)
  assert.equal(body.data.verification, 'configuration_only')
  assert.equal(body.data.generation_verified, false)
})

test('the default reference-image proxy is disabled without explicit opt-in', async () => {
  const service = load('backend-node/src/services/uploadService.js', () => { throw new Error('Unexpected supplier request') }, {
    '../config': { loadConfig: () => ({}) },
  })
  assert.equal(await service.uploadToImageProxy(Buffer.from('reference'), 'image/png', log, 'owned-reference'), null)
})
