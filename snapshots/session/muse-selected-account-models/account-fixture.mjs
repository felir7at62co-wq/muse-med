/** Real account login, selected catalog and recorded HTTP model messages for a shipped profile. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importSnapshotModule, importSnapshotPackage } from '../muse-fixture-import.mjs'
import { selectedModelProviders } from '../../../services/muse-accounts/selected-models.mjs'
import { desktopModelCatalog } from '../../../services/muse-accounts/desktop-models.mjs'

const owner = new URL('../../../packages/host/muse-account/package.json', import.meta.url)
const account = await importSnapshotModule(new URL('../../../packages/host/muse-account/src/index.ts', import.meta.url),
  new URL('../../../packages/host/muse-account/lib/types/index.js', import.meta.url))
const { defineContentToolFixture } = await importSnapshotPackage('@deepseek-ai/dsh-tools', owner)
const { LlmAdapter } = await importSnapshotPackage('@deepseek-ai/dsh-llm', owner)
const { SettingsConflictError } = await importSnapshotPackage('@deepseek-ai/dsh-settings', owner)

class PersonalAdapter extends LlmAdapter {
  listModels() {
    return Promise.resolve([{ provider: 'personal', id: 'gemini-personal', name: 'Personal Gemini' }])
  }

  stream() {
    throw new Error('The personal catalog fixture must not receive model requests')
  }
}

/** Loader name for the account-backed model recording. */
export const name = 'snapshot-selected-account-models'
/** Account, tool and default-model services provided by the shipped headless composition. */
export const inject = ['tools', 'llm', 'sessionProjections', 'agentDefaultModel']

function completion(message) {
  const chunks = message.content.map((block, index) => ({ choices: [{ index: 0, finish_reason: null,
    delta: block.type === 'text' ? { content: block.text } : block.type === 'reasoning' ? { reasoning_content: block.text }
      : { tool_calls: [{ index, id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } }] },
  }] }))
  chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: message.content.some(block => block.type === 'tool-call') ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 30, completion_tokens: 4 } })
  return [...chunks.map(chunk => JSON.stringify(chunk)), '[DONE]'].map(chunk => `data: ${chunk}\n\n`).join('')
}

/** Boot the normal account plugin and admit login before the first recorded model request.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Isolated snapshot process context.
 * @returns {Promise<void>} Completion after account, tool and stream fixture registration.
 */
export async function apply(ctx) {
  const direct = process.env.DSH_SNAPSHOT_DIRECT_ACCOUNT_ACCESS === 'true'
  const refusal = process.env.DSH_SNAPSHOT_SUPPLIER_REFUSAL === 'true'
  const officialGlm = process.env.DSH_SNAPSHOT_GLM_TOOL_STREAM === 'true'
  const pooledZhipu = process.env.DSH_SNAPSHOT_ZHIPU_POOL_RELAY === 'true'
  const leasedZhipu = process.env.DSH_SNAPSHOT_ZHIPU_POOL_DIRECT === 'true'
  const admissionFailure = process.env.DSH_SNAPSHOT_ADMISSION_FAILURE
  assert.ok(admissionFailure === undefined || admissionFailure === 'disconnect')
  assert.ok(!admissionFailure || leasedZhipu && !refusal)
  assert.ok(!leasedZhipu || pooledZhipu)
  assert.ok(!officialGlm || direct)
  assert.ok(!pooledZhipu || direct && officialGlm)
  assert.ok(!refusal || direct)
  const excludedProvider = process.env.DSH_SNAPSHOT_EXCLUDED_ACCOUNT_PROVIDER
  assert.ok(excludedProvider === undefined || excludedProvider === 'aa')
  const excludesStandaloneAa = excludedProvider === 'aa'
  const excludedYunying = process.env.DSH_SNAPSHOT_EXCLUDED_YUNYING_MODELS
  assert.ok(excludedYunying === undefined || excludedYunying === 'true')
  const excludesYunyingModels = excludedYunying === 'true'
  const visibleGemini = process.env.DSH_SNAPSHOT_YUNYING_GEMINI_VISIBLE
  assert.ok(visibleGemini === undefined || visibleGemini === 'true')
  const onlyYunyingGemini = visibleGemini === 'true'
  const hiddenYunyingModelIds = ['claude-opus-5-5', 'claude-fable-5-1', 'gpt-6-astra', 'glm-5.3-flash']
  const defaultRace = process.env.DSH_SNAPSHOT_DEFAULT_SELECTION_RACE
  assert.ok(defaultRace === undefined || defaultRace === 'preserve-newer')
  const preservesNewerDefault = defaultRace === 'preserve-newer'
  assert.ok(!excludesStandaloneAa || !preservesNewerDefault)
  const home = await mkdtemp(join(tmpdir(), 'muse-selected-snapshot-'))
  ctx.effect(() => () => rm(home, { recursive: true, force: true }))
  const catalog = desktopModelCatalog({ metadata: () => ({ providers: selectedModelProviders('https://wy6688.token6688.com/v1') }) })
  if (excludesStandaloneAa) catalog.providers.unshift({ id: 'aa', name: 'Gemini', models: [{
    id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', contextWindow: 128000, maxTokens: 8192,
    input: ['text', 'image'], reasoningEfforts: false,
  }] })
  const recorded = (await readFile(process.env.DSH_SNAPSHOT_FILE, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const selection = recorded.find(event => event.type === 'request/header')?.data.header.config
  const selectedModel = officialGlm ? { provider: 'muse-cloud-zhipu-official', model: 'glm-5.3-flash' } : preservesNewerDefault
    ? { provider: 'muse-cloud-yunying', model: 'gemini-3.1-pro' }
    : { provider: 'muse-cloud-deepseek-official', model: 'deepseek-flash' }
  assert.deepEqual({ provider: selection?.provider, model: selection?.model }, selectedModel)
  const directCompletion = direct && (!pooledZhipu || leasedZhipu)
  const completionPath = `${directCompletion ? '/supplier' : '/api/desktop-models'}/${selectedModel.provider.slice('muse-cloud-'.length)}/chat/completions`
  const script = recorded.filter(event => event.type === 'assistant/message').map(event => event.data.message)
  assert.equal(script.length, refusal || admissionFailure ? 0 : 2)
  const requests = []
  let admissionSubmissions = 0
  let supplierSubmissions = 0
  let baseUrl
  let rejected
  let defaultSelectionConflict
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk.toString('utf8') })
    request.once('end', () => {
      try {
        if (request.url === '/api/desktop-login/start') {
          response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({
            id: 'a'.repeat(43), secret: 's'.repeat(43), code: 'A1B2C3D4', expiresAt: Date.now() + 600000,
            pollIntervalMs: 2000, authorizeUrl: baseUrl + '/desktop-login?attempt=' + 'a'.repeat(43),
          })); return
        }
        if (request.url === '/api/desktop-login/check') {
          assert.equal(new URLSearchParams(body).get('secret'), 's'.repeat(43))
          response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': '__Host-muse=snapshot-session; Path=/; HttpOnly' })
          response.end(JSON.stringify({ state: 'signed-in' })); return
        }
        if (request.url === '/login') {
          response.writeHead(303, { 'set-cookie': '__Host-muse=snapshot-session; Path=/; HttpOnly', location: '/' }); response.end(); return
        }
        if (request.url === '/api/muse.account') {
          response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ username: 'snapshot' })); return
        }
        if (request.url === '/api/desktop-models/providers') {
          assert.equal(request.headers.cookie, '__Host-muse=snapshot-session')
          response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ...catalog,
            ...(direct ? { transport: 'direct' } : {}) })); return
        }
        if (request.url === '/api/desktop-models/access' && direct) {
          assert.equal(request.headers.cookie, '__Host-muse=snapshot-session')
          assert.equal(request.headers['x-muse-model-access'], 'direct-v1')
          assert.equal(request.headers['x-muse-provider-routing'], 'mixed-v1')
          response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ transport: 'direct',
            providers: catalog.providers.map(provider => pooledZhipu && provider.id === 'zhipu-official'
              ? { ...provider, transport: leasedZhipu ? 'leased' : 'relay' } : ({ ...provider, access: {
              baseURL: `${baseUrl}/supplier/${provider.id}`, apiKey: `supplier-fixture-${provider.id}`,
            } })) })); return
        }
        const leasePath = '/api/desktop-models/zhipu-official/leases'
        if (leasedZhipu && request.url === leasePath && request.method === 'POST') {
          assert.equal(request.headers.cookie, '__Host-muse=snapshot-session')
          assert.equal(request.headers['x-muse-zhipu-direct'], 'leased-v1')
          assert.deepEqual(JSON.parse(body), { model: selectedModel.model })
          admissionSubmissions++
          if (admissionFailure === 'disconnect') { request.socket.destroy(); return }
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ id: 'c0b928a2-9bea-416b-80f0-cbd051fba1c9',
            baseURL: `${baseUrl}/supplier/zhipu-official`, apiKey: 'supplier-fixture-zhipu-official',
            deadline: Date.now() + 60000, requestMs: 60000, checkMs: 1000 })); return
        }
        if (leasedZhipu && request.url === leasePath + '/c0b928a2-9bea-416b-80f0-cbd051fba1c9' && request.method === 'DELETE') {
          assert.equal(request.headers.cookie, '__Host-muse=snapshot-session')
          response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"released":true}'); return
        }
        if (request.url === completionPath) {
          supplierSubmissions++
          const payload = JSON.parse(body)
          assert.equal(request.headers.authorization, directCompletion ? `Bearer supplier-fixture-${selectedModel.provider.slice('muse-cloud-'.length)}` : 'Bearer snapshot-session')
          if (directCompletion) { assert.equal(request.headers.cookie, undefined); assert.equal(request.headers.origin, undefined) }
          else assert.equal(request.headers.origin, baseUrl)
          assert.equal(payload.model, selectedModel.model)
          if (officialGlm) {
            assert.equal(payload.max_tokens, 128000)
            assert.equal(payload.reasoning_effort, 'max')
            assert.deepEqual(payload.thinking, { type: 'enabled', clear_thinking: false })
            assert.equal(payload.tool_stream, true)
          } else if (preservesNewerDefault) {
            assert.equal(payload.max_tokens, 65536)
            assert.equal(payload.reasoning_effort, undefined)
            assert.equal(payload.thinking, undefined)
          } else {
            assert.equal(payload.max_tokens, 393216)
            assert.equal(payload.reasoning_effort, 'low')
            assert.deepEqual(payload.thinking, { type: 'enabled' })
          }
          const message = script[requests.length]
          if (!refusal) assert.ok(message)
          requests.push(payload)
          if (refusal) {
            response.writeHead(429, {
              'content-type': 'application/json',
              'retry-after': '0.001',
              'x-request-id': 'snapshot-upstream-request',
            })
            response.end(JSON.stringify({ error: { message: 'Opaque supplier refusal' } }))
            return
          }
          if (requests.length === 2) {
            const result = payload.messages.find(message => message.role === 'tool')
            assert.ok(result?.content.includes('gemini-3.1-pro'))
            assert.ok(result?.content.includes('deepseek-v4-pro'))
            if (excludesStandaloneAa) {
              assert.ok(result?.content.includes('"provider":"personal"'))
              assert.ok(result?.content.includes('gemini-personal'))
              assert.ok(!result?.content.includes('"provider":"muse-cloud-aa"'))
            }
            if (excludesYunyingModels) {
              const available = JSON.parse(result.content).available
              assert.deepEqual(available.find(row => row.provider === 'muse-cloud-yunying')?.models.map(model => model.id),
                onlyYunyingGemini ? ['gemini-3.1-pro'] : ['gpt-6-sol', 'claude-sonnet-5-5', 'gemini-3.1-pro'])
              assert.deepEqual(available.find(row => row.provider === 'muse-cloud-zhipu-official')?.models.map(model => model.id), [
                'glm-5.3-flashx', 'glm-5.3-flash',
              ])
            }
            if (preservesNewerDefault) {
              const catalogResult = JSON.parse(result.content)
              assert.deepEqual(catalogResult.default, selectedModel)
              assert.deepEqual(catalogResult.defaultSelectionConflict, defaultSelectionConflict)
            }
          }
          response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(completion(message)); return
        }
        response.writeHead(404); response.end()
      } catch (error) {
        rejected = error
        response.writeHead(500, { 'content-type': 'application/json' }); response.end('{"error":{"message":"Snapshot request mismatch"}}')
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  ctx.effect(() => async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => { if (error) reject(error); else resolve() }))
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  baseUrl = `http://127.0.0.1:${address.port}`
  const profile = ctx.get('profileContext')
  assert.ok(profile)
  // Account repair reads the owned profile's persisted selection.
  const initialDefault = preservesNewerDefault
    ? { provider: 'muse-cloud-aa', model: 'gemini-3.8-flash' } : selectedModel
  await writeFile(profile.patchPath, JSON.stringify([{ id: 'agent-default-model', config: initialDefault }]) + '\n')
  if (preservesNewerDefault) {
    // The CAS scenario saves through the real editable profile.
    const replayModelOverlay = profile.overlays.find(row => row.id === 'agent-default-model')
    assert.ok(replayModelOverlay && Object.hasOwn(replayModelOverlay, 'config'))
    ctx.effect(() => {
      const config = replayModelOverlay.config
      Reflect.deleteProperty(replayModelOverlay, 'config')
      return () => { replayModelOverlay.config = config }
    })
    const settings = ctx.get('settings')
    assert.ok(settings)
    const replace = settings.replace
    let submitted = false
    settings.replace = async (ns, section, expectedRevision) => {
      if (ns !== 'agent-default-model' || expectedRevision === undefined) return await replace.call(settings, ns, section, expectedRevision)
      assert.equal(submitted, false)
      submitted = true
      assert.deepEqual(settings.describe().find(row => row.ns === ns)?.user, initialDefault)
      await ctx.agentDefaultModel.saveSelection(selectedModel)
      const saved = settings.describe().find(row => row.ns === ns)
      assert.deepEqual(saved?.user, selectedModel)
      assert.ok(saved.revision > expectedRevision)
      try {
        await replace.call(settings, ns, section, expectedRevision)
      } catch (error) {
        assert.ok(error instanceof SettingsConflictError)
        assert.equal(error.expected, expectedRevision)
        assert.equal(error.actual, saved.revision)
        defaultSelectionConflict = { code: error.code, expected: error.expected, actual: error.actual,
          initial: initialDefault, preserved: saved.user }
        throw error
      }
      assert.fail('The stale initial-default write must fail its real revision check')
    }
    ctx.effect(() => () => { settings.replace = replace })
  }
  if (excludesStandaloneAa) ctx.effect(() => ctx.llm.registerAdapter(['personal'], new PersonalAdapter()))
  const mounted = ctx.plugin(account, { baseUrl: `http://127.0.0.1:${address.port}`, accountHome: home, remoteAccess: false,
    ...(excludesStandaloneAa ? { excludedProviderIds: ['aa'] } : {}),
    ...(excludesYunyingModels ? { excludedModels: hiddenYunyingModelIds.map(modelId => ({ providerId: 'yunying', modelId })) } : {}),
    ...(onlyYunyingGemini ? { hiddenProviderIds: ['yunying'], visibleModels: [{ providerId: 'yunying', modelId: 'gemini-3.1-pro' }] } : {}) })
  await mounted.await()
  const service = ctx.get('museAccount')
  assert.ok(service instanceof account.MuseAccountService)
  ctx.on('agent/created', async () => {
    const attempt = await service.startBrowserLogin()
    assert.ok(!JSON.stringify(attempt).includes('s'.repeat(43)))
    const login = await service.checkBrowserLogin(attempt.id)
    assert.equal(login.state, 'signed-in')
  })
  ctx.effect(() => ctx.tools.register(defineContentToolFixture({
    name: 'muse_selected_models', description: 'Read the signed-in Muse account model catalog.', parameters: {},
    async execute() {
      const available = []
      const providerIds = ctx.llm.listProviders().map(provider => provider.id)
      assert.deepEqual(providerIds.filter(provider => provider.startsWith('muse-cloud-')), [
        'muse-cloud-deepseek-official', 'muse-cloud-yunying', 'muse-cloud-zhipu-official',
      ])
      for (const provider of catalog.providers) {
        if (!providerIds.includes(`muse-cloud-${provider.id}`)) continue
        const models = (await ctx.llm.listModels(`muse-cloud-${provider.id}`)).filter(model => model.selectable !== false)
        available.push({ provider: `muse-cloud-${provider.id}`, models: await Promise.all(models.map(async model => {
          const resolved = await ctx.llm.resolveModelInfo(`muse-cloud-${provider.id}`, model.id)
          const configured = provider.models.find(candidate => candidate.id === model.id)
          assert.equal(resolved.context.contextWindow, configured.contextWindow)
          return { id: model.id, name: model.name, contextWindow: resolved.context.contextWindow, maxTokens: configured.maxTokens }
        })) })
      }
      assert.deepEqual(available.flatMap(provider => provider.models.map(model => model.id)), onlyYunyingGemini
        ? ['deepseek-flash', 'deepseek-v4-pro', 'gemini-3.1-pro', 'glm-5.3-flashx', 'glm-5.3-flash'] : excludesYunyingModels
        ? ['deepseek-flash', 'deepseek-v4-pro', 'gpt-6-sol', 'claude-sonnet-5-5', 'gemini-3.1-pro', 'glm-5.3-flashx', 'glm-5.3-flash']
        : ['deepseek-flash', 'deepseek-v4-pro', 'gpt-6-sol', 'gpt-6-astra', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'gemini-3.1-pro', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.3-flash'])
      if (excludesStandaloneAa) {
        assert.equal(catalog.providers[0].id, 'aa')
        assert.ok(!providerIds.includes('muse-cloud-aa'))
        const personal = (await ctx.llm.listModels('personal')).map(model => ({ id: model.id, name: model.name }))
        assert.deepEqual(personal, [{ id: 'gemini-personal', name: 'Personal Gemini' }])
        available.push({ provider: 'personal', models: personal })
      }
      const currentDefault = ctx.agentDefaultModel.currentSelection()
      if (preservesNewerDefault) {
        assert.ok(defaultSelectionConflict)
        assert.deepEqual(currentDefault, selectedModel)
        assert.deepEqual(ctx.get('settings').describe().find(row => row.ns === 'agent-default-model')?.user, selectedModel)
      }
      return [{ type: 'text', text: JSON.stringify({ default: currentDefault, available,
        ...(preservesNewerDefault ? { defaultSelectionConflict } : {}) }) }]
    },
  })))
  if (admissionFailure) {
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      if (rejected) throw rejected
      assert.equal(requests.length, 0)
      assert.equal(admissionSubmissions, 1)
      assert.equal(supplierSubmissions, 0)
      const events = session.snapshotEvents()
      const retryEvents = events.filter(event => event.type === 'llm/retry').length
      assert.equal(retryEvents, 0)
      const attempts = events.filter(event => event.type === 'assistant/attempt')
      assert.equal(attempts.length, 1)
      const finish = attempts[0].data.stream.find(entry => entry.type === 'chunk' && entry.chunk.type === 'finish')
      assert.deepEqual(finish?.chunk.reason, { kind: 'error', failure: {
        code: 'MODEL_ACCESS_UNCERTAIN',
        message: 'Muse model access could not be confirmed. Please retry later or contact the Muse administrator.',
      } })
      assert.deepEqual(event.data.reason, { kind: 'error', error: finish.chunk.reason.failure })
      const serialized = JSON.stringify(events)
      for (const secret of ['snapshot-session', 's'.repeat(43), 'fixture-password', 'supplier-fixture-']) {
        assert.ok(!serialized.includes(secret))
      }
      writeFileSync(join(process.cwd(), 'admission-observation.json'), JSON.stringify({
        admissionSubmissions, supplierSubmissions, retryEvents,
        failureCode: finish.chunk.reason.failure.code,
      }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    })
  }
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (admissionFailure) return
    if (rejected) throw rejected
    assert.equal(requests.length, refusal ? 6 : 2)
    const config = agent.session.requestHeader()?.config
    assert.equal(config.reasoningEffort, officialGlm ? 'max' : preservesNewerDefault ? undefined : 'low')
    assert.deepEqual({ provider: config.provider, model: config.model }, selectedModel)
    assert.ok(!JSON.stringify(agent.session.snapshotEvents()).includes('snapshot-session'))
    assert.ok(!JSON.stringify(agent.session.snapshotEvents()).includes('s'.repeat(43)))
    assert.ok(!JSON.stringify(agent.session.snapshotEvents()).includes('fixture-password'))
    assert.ok(!JSON.stringify(agent.session.snapshotEvents()).includes('supplier-fixture-'))
    if (direct) {
      const access = JSON.parse(await readFile(join(home, 'model-access.json'), 'utf8'))
      assert.equal(access.providers.length, pooledZhipu ? 2 : 3)
      if (pooledZhipu) assert.ok(!access.providers.some(provider => provider.id === 'zhipu-official'))
    }
  })
}
