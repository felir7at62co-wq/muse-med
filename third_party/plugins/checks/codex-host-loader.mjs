/** Reviewed subscription artifact over the real Loader, settings and local credentials, without a Codex CLI. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { boot, initProfile, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import Llm from '@deepseek-ai/dsh-llm'
import Web from '@deepseek-ai/dsh-web'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'

test('loads the subscription account settings and authenticated RPC through the real Host without requiring a CLI', async () => {
  const home = mkdtempSync(join(tmpdir(), 'muse-codex-host-'))
  const dir = join(home, 'profiles', 'test')
  const routes = new Map()
  let ctx
  let requests = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { requests++; throw new Error('Unexpected external request') }
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
      { id: 'codex-subscription', name: 'dsh-codex-subscription' },
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
          attachments: AttachmentLocal, llm: Llm, web: Web, tools: Tools, prompt: SystemPrompt })
      }, undefined, { 'dsh-codex-subscription': pathToFileURL(join(process.cwd(), 'lib/index.js')).href })
      await ctx.loader.await()
      const entry = [...ctx.loader.entries()].find(row => row.options.id === 'codex-subscription')
      assert.ok(entry?.fiber)
      assert.ok(ctx.settings.describe().find(row => row.ns === 'codex-subscription'))
    }
    const rpc = async (endpoint, payload = {}) => {
      const method = `codex-subscription/${endpoint}`
      const route = routes.get(`/api/${method}`)
      assert.ok(route)
      const response = await route.fetch(new Request(`http://localhost/api/${method}`, { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'fixture-rpc', method, payload }) }))
      return (await response.json()).result
    }
    await start()
    assert.deepEqual(await ctx.llm.listModels('openai-codex'), [])
    assert.equal((await rpc('status')).value.authenticated, false)
    const preferences = await rpc('preferences/status')
    assert.equal(preferences.ok, true)
    await ctx.settings.update('codex-subscription', { speedMode: 'fast', quickQuotaMode: 'percent' })
    assert.match(readFileSync(profile.patchPath, 'utf8'), /speedMode: fast/)
    await ctx.fiber.dispose()
    ctx = undefined
    assert.equal(routes.size, 0)
    await start()
    const restored = await rpc('preferences/status')
    assert.equal(restored.value.speedMode, 'fast')
    assert.equal(restored.value.quickQuotaMode, 'percent')
    assert.equal(restored.value.subagentRuntimeInstalled, false)
    assert.equal(requests, 0)
  } finally {
    await ctx?.fiber.dispose()
    globalThis.fetch = originalFetch
    rmSync(home, { recursive: true, force: true })
  }
})
