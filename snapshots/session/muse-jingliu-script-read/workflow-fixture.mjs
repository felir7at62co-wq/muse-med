/** Exercise the production workflow tool against an offline Jingliu project. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyLoopbackServerEffect } from '../loopback-fixture-server.mjs'
import { apply as mountPreset } from '../muse-editing-tool-catalog/editing-preset-fixture.mjs'
import { importSnapshotModule, importSnapshotPackage } from '../muse-fixture-import.mjs'

const desktopOwner = new URL('../../../apps/desktop-host/package.json', import.meta.url)
const { composeEntries, loadOverlayPatches } = await importSnapshotPackage('@deepseek-ai/dsh-app-boot', desktopOwner)
const overlay = fileURLToPath(new URL('../../../apps/desktop-host/config/desktop.cordis.patch.yml', import.meta.url))
const project = '31dd6a12a591'
const text = '阿青推开老影院的门。'
const definition = {
  name: 'read_script', description: '读取指定项目的剧本。', role: 'viewer', risk: 'read',
  account_scoped: false, costs: false, needs_confirm: false, long_running: false,
  parameters: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] },
}

const cookie = '__Host-muse=snapshot-private-reader-cookie'
const grant = 'g'.repeat(43)
const challenge = 'C'.repeat(43)
const studioToken = 'snapshot-private-studio-session'

async function loopback(ctx, label, handle) {
  let origin
  let failure
  await applyLoopbackServerEffect(ctx, {
    label,
    onListening: address => { origin = 'http://127.0.0.1:' + address.port },
    onCleanup: () => { if (failure) throw failure },
    async requestListener(req, res) {
      try {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const raw = Buffer.concat(chunks).toString('utf8')
        const result = handle(req, raw ? JSON.parse(raw) : undefined)
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
      } catch (error) {
        failure = error
        res.writeHead(500, { 'content-type': 'application/json' }).end('{"detail":"Unexpected fixture request"}')
      }
    },
  })
  return origin
}

/** Cordis fixture name. */
export const name = 'jingliu-script-read'
/** Host services exercised by this Headless scenario. */
export const inject = ['agentPresets', 'agents', 'llm', 'systemPrompt', 'tools', 'workingDirectory']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless services. */
export async function apply(ctx) {
  const patches = loadOverlayPatches('jingliu-script-read', overlay)
  const rows = composeEntries([patches])
  const registry = patches.find(row => row.id === 'agent-preset-registry')?.config
  const jingliuConnection = rows.find(row => row.id === 'jingliu-connection')
  const jingliuTool = rows.find(row => row.id === 'tool-jingliu')
  // Recorded on short-drama, which Sessions started before short-drama-v2 became the default keep running on;
  // v2 refuses jingliu_* until muse-jingliu-production is loaded, which this recording never does.
  const preset = 'short-drama'
  assert.ok(registry?.selectablePresets.includes(preset), 'Existing Sessions can keep the short-drama preset')
  assert.equal(jingliuConnection?.name, '@deepseek-ai/dsh-jingliu-connection')
  assert.equal(jingliuTool?.name, '@deepseek-ai/dsh-tool-jingliu')
  assert.ok(!jingliuConnection.disabled && !jingliuTool.disabled, 'Jingliu stays mounted without a configured origin')
  const plugin = await importSnapshotModule(
    new URL('../../../packages/drama/tool-jingliu/src/index.ts', import.meta.url),
    new URL('../../../packages/drama/tool-jingliu/lib/index.js', import.meta.url),
  )
  const { default: Connection } = await importSnapshotModule(
    new URL('../../../packages/drama/jingliu-connection/src/index.ts', import.meta.url),
    new URL('../../../packages/drama/jingliu-connection/lib/index.js', import.meta.url),
  )
  const { MuseWorkbenchLogin } = await importSnapshotModule(
    new URL('../../../packages/host/muse-account/src/workbench-login.ts', import.meta.url),
    new URL('../../../packages/host/muse-account/lib/types/workbench-login.js', import.meta.url),
  )
  const { writeMuseSession } = await importSnapshotModule(
    new URL('../../../packages/host/muse-account/src/session.ts', import.meta.url),
    new URL('../../../packages/host/muse-account/lib/types/session.js', import.meta.url),
  )
  let modelSawScript = false
  const calls = []
  const gateway = await loopback(ctx, 'Muse reader grant', (req, body) => {
    assert.equal(req.url, '/api/workbench-login/grant')
    assert.equal(req.method, 'POST')
    assert.equal(req.headers.cookie, cookie)
    assert.equal(req.headers.origin, gateway)
    assert.deepEqual(body, { audience: 'jingliu', challenge })
    calls.push('grant')
    return { code: grant, expiresIn: 60 }
  })
  const user = { id: 74111 }
  const account = { unlimited: false, available_yuan: '12.50', used_fen: 250, held_fen: 100, enforced: false }
  const studio = await loopback(ctx, 'Jingliu reader project', (req, body) => {
    assert.equal(req.headers.cookie, undefined)
    const prefix = '/fwp/v2'
    if (req.url === prefix + '/auth/muse/challenge') {
      assert.equal(req.method, 'POST')
      assert.equal(req.headers.authorization, undefined)
      calls.push('challenge')
      return { requestId: 'snapshot-request', challenge }
    }
    if (req.url === prefix + '/auth/muse/exchange') {
      assert.equal(req.method, 'POST')
      assert.equal(req.headers.authorization, undefined)
      assert.deepEqual(body, { requestId: 'snapshot-request', code: grant })
      calls.push('exchange')
      return { token: studioToken, user }
    }
    assert.equal(req.headers.authorization, 'Bearer ' + studioToken)
    if (req.url === prefix + '/desktop-agent/tools') {
      assert.equal(req.method, 'GET')
      calls.push('tools')
      return { count: 1, tools: [definition] }
    }
    if (req.url === prefix + '/auth/me') {
      assert.equal(req.method, 'GET')
      calls.push('me')
      return { user }
    }
    if (req.url === prefix + '/budget/me') {
      assert.equal(req.method, 'GET')
      calls.push('balance')
      return account
    }
    if (req.url === prefix + '/budget/users/' + user.id) {
      assert.equal(req.method, 'GET')
      calls.push('ledger')
      return { user_id: user.id, ledger: [{ ts: '2026-11-22T08:36:00+00:00', entry: 'spend', amount_fen: -250, note: 'Private invoice reference' }] }
    }
    assert.equal(req.url, prefix + '/desktop-agent/tool')
    assert.equal(req.method, 'POST')
    assert.deepEqual(body.args, { project_id: project })
    assert.equal(body.project_id, project)
    assert.equal(body.name, 'read_script')
    assert.equal(body.confirmed, false)
    calls.push('read')
    return { ok: true, text }
  })
  const home = await mkdtemp(join(tmpdir(), 'jingliu-reader-snapshot-'))
  ctx.effect(() => () => rm(home, { recursive: true, force: true }))
  const sessionFile = join(home, 'session.json')
  await writeMuseSession(sessionFile, { baseUrl: gateway, username: 'snapshot-reader', cookie })
  const login = new MuseWorkbenchLogin({ baseUrl: gateway, sessionFile, requestTimeoutMs: 10000 })
  ctx.effect(() => ctx.provide('museAccount', {
    workbenchIdentity: () => login.identity(),
    workbenchGrant: (audience, proof) => login.issue(audience, proof),
  }))
  await ctx.plugin(Connection, { studioOrigin: studio })
  await ctx.plugin(plugin, jingliuTool.config)
  await mountPreset(ctx.isolate('museAccount'), { presetId: preset, hidePlatformShellTools: true })
  ctx.on('llm/stream', async function* (options, next) {
    const messages = JSON.stringify(options.messages)
    for (const secret of [cookie, grant, studioToken]) assert.ok(!messages.includes(secret), 'Private login data in model input')
    const names = options.tools.map(tool => tool.name)
    for (const name of ['jingliu_projects', 'jingliu_workflows', 'jingliu_run', 'jingliu_narration', 'jingliu_studio', 'jingliu_image', 'muse_billing']) {
      assert.ok(names.includes(name), `Missing Desktop tool ${name}`)
    }
    assert.deepEqual(names.filter(name => /^(?:jubian_|muse_production$)/u.test(name)), [],
      'No legacy production tools in the active preset')
    const system = options.messages.filter(message => message.role === 'system')
      .flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')
    assert.match(system, /jingliu_workflows/u)
    assert.doesNotMatch(system, /\bjubian_\w+|\bmuse_production\b/u)
    const result = options.messages.find(message => message.role === 'tool' && message.toolCallId === 'read-jingliu-script')
    if (result) {
      assert.equal(result.isError, false, JSON.stringify(result.content))
      const block = result.content.find(item => item.type === 'text')
      assert.deepEqual(JSON.parse(block.text), { workflow: 'read_script', project_id: project, result: { ok: true, text } })
      modelSawScript = true
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', async () => {
    const reader = await ctx.get('jingliuConnection').connection()
    assert.deepEqual(await reader.request('/auth/me'), { user })
    const billing = ctx.tools.get('muse_billing')
    assert.ok(billing)
    assert.deepEqual(await billing.execute({ include_ledger: true }, { signal: new AbortController().signal }), {
      account: 'jingliu', available_yuan: '12.50', used_fen: 250, held_fen: 100, unlimited: false, enforced: false,
      ledger: [{ time: '2026-11-22T08:36:00+00:00', kind: 'spend', amountFen: -250 }],
    })
    assert.deepEqual(calls, ['challenge', 'grant', 'exchange', 'tools', 'read', 'me', 'me', 'balance', 'ledger'])
    assert.ok(modelSawScript, 'The model receives the read result from the selected Jingliu project')
  })
}
