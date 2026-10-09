/** Real account login, selected catalog and recorded HTTP model messages for a shipped profile. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
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
  const excludedProvider = process.env.DSH_SNAPSHOT_EXCLUDED_ACCOUNT_PROVIDER
  assert.ok(excludedProvider === undefined || excludedProvider === 'aa')
  const excludesStandaloneAa = excludedProvider === 'aa'
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
  const selectedModel = preservesNewerDefault
    ? { provider: 'muse-cloud-yunying', model: 'gemini-3.1-pro' }
    : { provider: 'muse-cloud-deepseek-official', model: 'deepseek-flash' }
  assert.deepEqual({ provider: selection?.provider, model: selection?.model }, selectedModel)
  const completionPath = `/api/desktop-models/${selectedModel.provider.slice('muse-cloud-'.length)}/chat/completions`
  const script = recorded.filter(event => event.type === 'assistant/message').map(event => event.data.message)
  assert.equal(script.length, 2)
  const requests = []
  let rejected
  let defaultSelectionConflict
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk.toString('utf8') })
    request.once('end', () => {
      try {
        if (request.url === '/login') {
          response.writeHead(303, { 'set-cookie': '__Host-muse=snapshot-session; Path=/; HttpOnly', location: '/' }); response.end(); return
        }
        if (request.url === '/api/muse.account') {
          response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ username: 'snapshot' })); return
        }
        if (request.url === '/api/desktop-models/providers') {
          assert.equal(request.headers.cookie, '__Host-muse=snapshot-session')
          response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(catalog)); return
        }
        if (request.url === completionPath) {
          const payload = JSON.parse(body)
          assert.equal(request.headers.authorization, 'Bearer snapshot-session')
          assert.equal(payload.model, selectedModel.model)
          if (preservesNewerDefault) {
            assert.equal(payload.max_tokens, 65536)
            assert.equal(payload.reasoning_effort, undefined)
            assert.equal(payload.thinking, undefined)
          } else {
            assert.equal(payload.max_tokens, 393216)
            assert.equal(payload.reasoning_effort, 'low')
            assert.deepEqual(payload.thinking, { type: 'enabled' })
          }
          const message = script[requests.length]
          assert.ok(message)
          requests.push(payload)
          if (requests.length === 2) {
            const result = payload.messages.find(message => message.role === 'tool')
            assert.ok(result?.content.includes('gemini-3.1-pro'))
            assert.ok(result?.content.includes('deepseek-v4-pro'))
            if (excludesStandaloneAa) {
              assert.ok(result?.content.includes('"provider":"personal"'))
              assert.ok(result?.content.includes('gemini-personal'))
              assert.ok(!result?.content.includes('"provider":"muse-cloud-aa"'))
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
    ...(excludesStandaloneAa ? { excludedProviderIds: ['aa'] } : {}) })
  await mounted.await()
  const service = ctx.get('museAccount')
  assert.ok(service instanceof account.MuseAccountService)
  ctx.on('agent/created', async () => {
    const login = await service.login({ username: 'snapshot', password: 'fixture-password', registerIfMissing: false })
    assert.equal(login.outcome, 'signed-in')
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
        const models = await ctx.llm.listModels(`muse-cloud-${provider.id}`)
        available.push({ provider: `muse-cloud-${provider.id}`, models: await Promise.all(models.map(async model => {
          const resolved = await ctx.llm.resolveModelInfo(`muse-cloud-${provider.id}`, model.id)
          const configured = provider.models.find(candidate => candidate.id === model.id)
          assert.equal(resolved.context.contextWindow, configured.contextWindow)
          return { id: model.id, name: model.name, contextWindow: resolved.context.contextWindow, maxTokens: configured.maxTokens }
        })) })
      }
      assert.deepEqual(available.flatMap(provider => provider.models.map(model => model.id)), [
        'deepseek-flash', 'deepseek-v4-pro', 'gpt-6-sol', 'gpt-6-astra', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'gemini-3.1-pro', 'glm-5.3-flash', 'glm-5.3-flashx',
      ])
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
  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (rejected) throw rejected
    assert.equal(requests.length, 2)
    const config = agent.session.requestHeader()?.config
    assert.equal(config.reasoningEffort, preservesNewerDefault ? undefined : 'low')
    assert.deepEqual({ provider: config.provider, model: config.model }, selectedModel)
    assert.ok(!JSON.stringify(agent.session.snapshotEvents()).includes('snapshot-session'))
    assert.ok(!JSON.stringify(agent.session.snapshotEvents()).includes('fixture-password'))
  })
}
