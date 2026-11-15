/** Reviewed subscription artifact over the real Loader, settings and local credentials, without a Subscription CLI. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { boot, initProfile, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import Llm, { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import Web from '@deepseek-ai/dsh-web'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import Subagents from '@deepseek-ai/dsh-subagent'
import Subprocess from '@deepseek-ai/dsh-subprocess'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici'

test('loads subscription settings through real Loader and portless RPC, then streams synthetic account history without external network', async () => {
  const home = mkdtempSync(join(tmpdir(), 'muse-subscriptions-host-'))
  const dir = join(home, 'profiles', 'test')
  const routes = new Map()
  let ctx
  let requests = 0
  let syntheticAccount = false
  const wire = []
  const originalFetch = globalThis.fetch
  const originalDispatcher = getGlobalDispatcher()
  const network = new MockAgent()
  network.disableNetConnect()
  setGlobalDispatcher(network)
  const homeEnvironment = Object.fromEntries(['DSH_HOME', 'MUSE_HOME', 'MUSE_MED_HOME'].map(key => [key, process.env[key]]))
  process.env.DSH_HOME = home
  delete process.env.MUSE_HOME
  delete process.env.MUSE_MED_HOME
  globalThis.fetch = async (input, init) => {
    requests++
    assert.equal(syntheticAccount, true, 'accountless Host must not request external data')
    assert.equal(String(input), 'https://chatgpt.com/backend-api/codex/responses')
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-access')
    wire.push(JSON.parse(init.body))
    return new Response('data: {"type":"response.output_text.delta","delta":"fixture answer"}\n\n'
      + 'data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":2}}}\n\n'
      + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    initProfile(dir, ['test-bundle'])
    const bundle = join(dir, 'node_modules', 'test-bundle')
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(home, 'package.json'), '{"name":"muse-subscription-test"}\n')
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
      { id: 'config-editor', name: 'cordis:editor' },
      { id: 'settings', name: 'cordis:settings' },
      { id: 'credentials', name: 'cordis:credentials', config: { dshHome: home, watch: false } },
      { id: 'attachments', name: 'cordis:attachments', config: { dshHome: home } },
      { id: 'llm', name: 'cordis:llm' },
      { id: 'web', name: 'cordis:web' },
      { id: 'prompt', name: 'cordis:prompt' },
      { id: 'tools', name: 'cordis:tools' },
      { id: 'fs', name: 'cordis:fs' },
      { id: 'session-projections', name: 'cordis:sessionProjections' },
      { id: 'working-directory', name: 'cordis:workingDirectory', config: { defaultDirectory: home } },
      { id: 'subagents', name: 'cordis:subagents' },
      { id: 'subprocess', name: 'cordis:subprocess' },
      { id: 'sandbox-policy', name: 'cordis:sandboxPolicy' },
      { id: 'subscriptions', name: 'dsh-plugin-subscriptions', config: {
        providers: ['codex'], pool: { enabled: false }, codexClientVersion: '0.140.0',
        models: { codex: [{ id: 'fixture-vision', name: 'Fixture vision', inputModalities: ['text', 'image'] }] },
      } },
    ] }]))
    writeFileSync(join(dir, 'cordis.yml'), '[]\n')
    const profile = { name: 'test', startedBundles: ['test-bundle'], dir,
      patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'),
      cwd: home, home, overlays: [], telemetryDisabledEnv: undefined }
    const start = async () => {
      ctx = await boot('muse-codex-host', join(dir, 'cordis.yml'), readProfilePatches('muse-codex-host', profile), host => {
        host.provide('profileContext', profile)
        host.provide('appReady', { onReady(listener) { listener(); return () => {} } })
        host.provide('connection', { fetch: { register(route) {
          assert.equal(routes.has(route.path), false)
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        } } })
        Object.assign(host.loader.builtins, { editor: ConfigEditor, settings: Settings, credentials: Credentials,
          attachments: AttachmentLocal, llm: Llm, web: Web, tools: Tools, prompt: SystemPrompt,
          fs: LocalFileSystem, sessionProjections: SessionProjections, workingDirectory: WorkingDirectory,
          subagents: Subagents, subprocess: Subprocess, sandboxPolicy: SandboxPolicy })
      }, undefined, { 'dsh-plugin-subscriptions': pathToFileURL(join(process.cwd(), 'lib/index.js')).href })
      await ctx.loader.await()
      const entry = [...ctx.loader.entries()].find(row => row.options.id === 'subscriptions')
      assert.ok(entry?.fiber)
    }
    const rpc = async (endpoint, payload = {}) => {
      const method = `subscriptions-auth.${endpoint}`
      const route = routes.get(`/api/${method}`)
      assert.ok(route)
      const response = await route.fetch(new Request(`http://localhost/api/${method}`, { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'fixture-rpc', method, payload }) }))
      return (await response.json()).result
    }
    await start()
    assert.deepEqual(await ctx.llm.listModels('codex'), [])
    assert.deepEqual(await ctx.llm.listModels('openai-codex'), [])
    const status = await rpc('status')
    assert.equal(status.ok, true)
    assert.deepEqual(status.value.providers.codex.accounts, [])
    assert.equal(status.value.providers.codex.busy, false)
    assert.deepEqual(status.value.providers.codex.clientVersion, { version: '0.140.0', source: 'config' })
    assert.equal(ctx.llm.listProviders().find(provider => provider.id === 'openai-codex')?.selectable, false)
    assert.ok(ctx.llm.listProviders().find(provider => provider.id === 'codex'))
    const settings = { displayName: 'Fixture subscription', visibleModels: [], tools: { image_generate: false, web_search: false } }
    assert.equal((await rpc('setProviderSettings', { provider: 'codex', settings })).ok, true)
    const saved = await rpc('providerSettings', { provider: 'codex' })
    assert.equal(saved.ok, true)
    assert.deepEqual(saved.value.settings, settings)
    const malformed = await rpc('providerSettings', { provider: 'not-a-provider' })
    assert.equal(malformed.ok, false)
    const runtime = ctx.llm
    await ctx.fiber.dispose()
    ctx = undefined
    assert.equal(routes.size, 0)
    assert.deepEqual(runtime.listProviders(), [])
    await start()
    const restored = await rpc('providerSettings', { provider: 'codex' })
    assert.equal(restored.ok, true)
    assert.deepEqual(restored.value.settings, settings)
    assert.equal((await rpc('status')).value.providers.codex.displayName, settings.displayName)
    assert.deepEqual(await ctx.llm.listModels('openai-codex'), [])
    assert.equal(requests, 0)

    await ctx.fiber.dispose()
    ctx = undefined
    const authDirectory = join(home, 'plugins', 'subscriptions')
    mkdirSync(authDirectory, { recursive: true })
    writeFileSync(join(authDirectory, 'auth.json'), JSON.stringify({ codex: {
      default: 'synthetic-account', accounts: { 'synthetic-account': {
        accountId: 'synthetic-account', accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh',
        expiresAt: Date.now() + 3_600_000,
      } },
    } }), { mode: 0o600 })
    await start()
    assert.equal((await rpc('setProviderSettings', { provider: 'codex', settings: { displayName: settings.displayName } })).ok, true)
    assert.equal((await ctx.llm.listModels('codex'))[0].id, 'fixture-vision')
    assert.deepEqual(await ctx.llm.listModels('openai-codex'), [])
    const ref = await ctx.attachments.saveImage({ mediaType: 'image/png', name: 'fixture.png', data: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64') })
    const callId = 'call_fixture'
    const messages = [
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the fixture.' }, { type: 'image', attachment: ref }] }),
      createAssistantMessage({ source: { provider: 'openai-codex', model: 'fixture-vision' },
        content: [{ type: 'tool-call', id: callId, name: 'inspect_fixture', arguments: '{"frame":1}' }] }),
      createToolResultMessage({ callId, content: [{ type: 'text', text: 'Frame one is intact.' }], isError: false }),
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue using that result.' }] }),
    ]
    syntheticAccount = true
    for (const provider of ['codex', 'openai-codex']) {
      const prepared = await ctx.llm.prepareCall({ provider, model: 'fixture-vision' })
      assert.equal(prepared.config.provider, provider)
      const chunks = []
      for await (const chunk of prepared.stream({ ...prepared.config, messages, requireImageInput: true,
        tools: [{ name: 'inspect_fixture', description: 'Inspect the fixture.', parameters: { type: 'object', properties: { frame: { type: 'number' } } } }],
      })) chunks.push(chunk)
      assert.deepEqual(chunks.at(-1)?.reason, { kind: 'stop' }, `${provider}: required image input must dispatch`)
      assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'fixture answer'))
      const successfulRequests = requests
      const rejected = []
      for await (const chunk of ctx.llm.stream({ ...prepared.config, requireImageInput: true,
        messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image',
          attachment: { ...ref, attachmentId: `sha256:${'b'.repeat(64)}` },
        }] })],
      })) rejected.push(chunk)
      assert.equal(rejected.at(-1)?.reason.kind, 'error', `${provider}: unreadable input must not be dropped`)
      assert.equal(requests, successfulRequests, 'an unreadable input must fail before any provider request')
    }
    assert.equal(requests, 2)
    assert.equal(wire.length, 2)
    for (const body of wire) {
      assert.equal(body.model, 'fixture-vision')
      assert.deepEqual(body.input.map(item => item.type), ['message', 'function_call', 'function_call_output', 'message'])
      assert.ok(body.input[0].content.some(part => part.type === 'input_image' && part.image_url.startsWith('data:image/png;base64,')))
      assert.equal(body.input[1].call_id, body.input[2].call_id)
      assert.equal(body.input[1].arguments, '{"frame":1}')
      assert.match(body.input[2].output, /Frame one is intact/)
      assert.equal(body.tools[0].name, 'inspect_fixture')
    }
    assert.equal(messages[1].source.provider, 'openai-codex')
  } finally {
    await ctx?.fiber.dispose()
    globalThis.fetch = originalFetch
    setGlobalDispatcher(originalDispatcher)
    await network.close()
    for (const [key, value] of Object.entries(homeEnvironment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(home, { recursive: true, force: true })
  }
})
