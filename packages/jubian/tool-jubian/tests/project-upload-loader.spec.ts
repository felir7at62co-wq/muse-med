/** Manuscript upload and manual project creation through the real Loader and model-visible tool loop. */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { expect, it, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as Jubian from '../src/index.ts'

const frontend = '<html><script src="/static/js/app.fixture.js"></script></html>'
const app = 'var modules={{"6c3d":function(e,t,n){var o=(t.default,"AKIDEXAMPLE");'
  + 'var s="SECRETEXAMPLE";var r="cn-beijing";var u="jubian-aigc";'
  + 'var l="tos-cn-beijing.volces.com";return 1}},"6ea0":function(){return 1}}'

async function fixture() {
  const f = await configurationFixture({ hmr: false, rows: [
    { id: 'tool-executor-native', name: 'cordis:native-executor' },
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'offline-project-token' } },
  ], builtins: { 'native-executor': NativeToolExecutor, prompt: SystemPrompt, tools: Tools,
    credentials: MemoryCredentials, jubian: Jubian } })
  await f.ctx.loader.create({ name: 'cordis:jubian', config: { ledgerRoot: join(f.home, 'ledger'),
    workspaceSecrets: false, baseUrl: 'https://project-upload.invalid/prod-api' } })
  await f.ctx.loader.await()
  for (const entry of f.ctx.loader.entries()) await entry.fiber?.await()
  await f.ctx.plugin(Llm); await f.ctx.plugin(SessionStore); await f.ctx.plugin(SessionProjections)
  await f.ctx.plugin(AgentRegistry); await f.ctx.plugin(AgentLoop, { agents: [] })
  return f
}

it('uploads original document bytes once, creates a manual project once, and removes tools on unload', async () => {
  const transport = vi.spyOn(globalThis, 'fetch')
  const f = await fixture()
  const source = join(f.home, 'original.docx')
  const original = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])
  await writeFile(source, original)
  const requests: { method: string; path: string }[] = []
  const uploaded: Uint8Array[] = []
  let created = false
  transport.mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const method = init?.method ?? 'GET'
    requests.push({ method, path: url.pathname })
    if (url.href === 'https://web.jubianai.net/') return new Response(frontend)
    if (url.href === 'https://web.jubianai.net/static/js/app.fixture.js') return new Response(app)
    if (url.hostname === 'jubian-aigc.tos-cn-beijing.volces.com') {
      expect(method).toBe('PUT')
      expect(init?.body).toBeInstanceOf(Uint8Array)
      uploaded.push(new Uint8Array(init?.body as Uint8Array))
      return new Response(null, { status: 200 })
    }
    expect(url.origin, 'the fixture refuses external provider requests').toBe('https://project-upload.invalid')
    if (method === 'POST' && url.pathname === '/prod-api/aigc/script') {
      expect(created, 'original-key replay cannot create a second project').toBe(false)
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body')
      const body: unknown = JSON.parse(init.body)
      expect(body).toMatchObject({ scriptName: '离线素材项目', createType: 1,
        produceType: 2, productionType: 1 })
      created = true
      return new Response(JSON.stringify({ code: 200, data: 2709 }))
    }
    if (method === 'GET' && url.pathname === '/prod-api/aigc/script/2709') {
      expect(created).toBe(true)
      return new Response(JSON.stringify({ code: 200, data: { id: 2709, scriptName: '离线素材项目',
        createType: 1, produceType: 2, productionType: 1 } }))
    }
    throw new Error(`Unexpected offline request ${method} ${url.pathname}`)
  })
  try {
    expect(f.ctx.tools.get('jubian_manuscript')).toBeDefined()
    expect(f.ctx.tools.get('jubian_project')).toBeDefined()
    const upload = { method: 'upload_document', document_path: source, idempotency_key: 'original-document' }
    const create = { method: 'create', script_name: '离线素材项目', production_type: 1,
      produce_type: 2, idempotency_key: 'original-project' }
    const adapter = new MockAdapter([
      toolCallResponse('upload', 'jubian_manuscript', upload),
      toolCallResponse('upload-replay', 'jubian_manuscript', upload),
      toolCallResponse('create', 'jubian_project', create),
      toolCallResponse('create-replay', 'jubian_project', create),
      toolCallResponse('get', 'jubian_project', { method: 'get', script_id: 2709 }),
      textResponse('原文档已上传，素材项目 2709 已读取核对；没有开始解析或生成。'),
    ])
    f.ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await f.ctx.agentLoop.create(SessionId('project-upload-owner'),
      { provider: 'mock', model: 'mock' }, { cwd: f.home })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
      text: 'Upload this original document and create the specified manual material project. Do not parse or generate.' }] }))
    await agent.whenIdle()
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      .map(event => event.data.message)
    expect(results).toHaveLength(5)
    expect(results.every(result => !result.isError), JSON.stringify(results)).toBe(true)
    const values = results.map((result) => {
      const value: unknown = JSON.parse(result.content.filter(block => block.type === 'text')
        .map(block => block.text).join('\n'))
      return value
    })
    expect(values[0]).toMatchObject({ uploaded: true, sha256: 'sha256:' + createHash('sha256').update(original).digest('hex') })
    expect(values[1]).toMatchObject({ replayed: true, source_reread: false })
    expect(values[1]).not.toHaveProperty('settlement_pending')
    expect(values[2]).toMatchObject({ script_id: 2709, outcome: 'accepted', generation_started: false })
    expect(values[3]).toMatchObject({ script_id: 2709, replayed: true })
    expect(values[4]).toMatchObject({ project: { script_id: 2709 } })
    expect(uploaded).toEqual([new Uint8Array(original)])
    expect(await readFile(source)).toEqual(original)
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1)
    expect(adapter.requests.at(-1)!.messages.filter(message => message.role === 'tool').map(message => message.content))
      .toEqual(results.map(result => result.content))
    expect(JSON.stringify(agent.session.snapshotEvents())).not.toMatch(/offline-project-token|AKIDEXAMPLE|SECRETEXAMPLE/u)
    const records = await new JubianLedger({ root: join(f.home, 'ledger') }).records()
    expect(records.map(record => record.method).sort())
      .toEqual(['document_upload', 'project_create'])
    expect(records.every(record => record.outcome === 'accepted')).toBe(true)
    const row = [...f.ctx.loader.entries()].find(entry => entry.options.name === 'cordis:jubian')
    await row?.fiber?.dispose()
    expect(f.ctx.tools.get('jubian_manuscript')).toBeUndefined()
    expect(f.ctx.tools.get('jubian_project')).toBeUndefined()
  } finally { transport.mockRestore(); await f.ctx.fiber.dispose() }
})

it('records an uncertain project creation and reconciles the original key without another POST', async () => {
  const transport = vi.spyOn(globalThis, 'fetch')
  const f = await fixture()
  const calls: string[] = []
  transport.mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    expect(url.origin).toBe('https://project-upload.invalid')
    expect(init?.method).toBe('POST')
    expect(url.pathname).toBe('/prod-api/aigc/script')
    calls.push(url.pathname)
    throw new TypeError('Offline timeout after dispatch')
  })
  try {
    const create = { method: 'create', script_name: '结果待核对的项目', production_type: 1,
      produce_type: 2, idempotency_key: 'uncertain-project' }
    const adapter = new MockAdapter([
      toolCallResponse('uncertain', 'jubian_project', create),
      toolCallResponse('uncertain-replay', 'jubian_project', create),
      toolCallResponse('operation', 'jubian_project', { method: 'operation', idempotency_key: 'uncertain-project' }),
      textResponse('创建结果未知，原 key 已保留，未重复提交。'),
    ])
    f.ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await f.ctx.agentLoop.create(SessionId('uncertain-project-owner'),
      { provider: 'mock', model: 'mock' }, { cwd: f.home })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
      text: 'Create the specified project. If the response is lost, keep its original key and reconcile only.' }] }))
    await agent.whenIdle()
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result').map(event => event.data.message)
    expect(results).toHaveLength(3)
    const values = results.slice(1).map((result) => {
      const value: unknown = JSON.parse(result.content.filter(block => block.type === 'text')
        .map(block => block.text).join('\n'))
      return value
    })
    expect(values[0]).toMatchObject({ outcome: 'unknown', replayed: true, script_id: null })
    expect(values[1]).toMatchObject({ status: 'unknown', original_idempotency_key: 'uncertain-project' })
    expect(calls).toHaveLength(1)
    expect((await new JubianLedger({ root: join(f.home, 'ledger') }).records())).toMatchObject([{ outcome: 'unknown' }])
  } finally { transport.mockRestore(); await f.ctx.fiber.dispose() }
})

it('refuses a second content project when the provider reports an existing manuscript project', async () => {
  const transport = vi.spyOn(globalThis, 'fetch')
  const f = await fixture()
  const calls: string[] = []
  transport.mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    expect(url.origin).toBe('https://project-upload.invalid')
    expect(init?.method).toBe('GET')
    calls.push(url.pathname)
    if (url.pathname === '/prod-api/script/center/pool/detail/7') {
      return new Response(JSON.stringify({ code: 200, data: { manuscript: { id: 7, scriptName: '已有内容项目',
        episodeCount: 4, status: 'in_production' } } }))
    }
    expect(url.pathname).toBe('/prod-api/aigc/script/checkManuscriptProject')
    expect(url.searchParams.get('manuscriptId')).toBe('7')
    expect(url.searchParams.get('productionType')).toBe('0')
    return new Response(JSON.stringify({ code: 200, data: 1 }))
  })
  try {
    const adapter = new MockAdapter([
      toolCallResponse('duplicate', 'jubian_project', { method: 'create', script_name: '已有内容项目',
        production_type: 0, produce_type: 1, manuscript_id: 7, script_style: 0, episode_count: 4,
        storyboard_count_per_episode: 0, idempotency_key: 'duplicate-content-project' }),
      textResponse('提供方报告已有同稿件项目，未创建第二个项目。'),
    ])
    f.ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await f.ctx.agentLoop.create(SessionId('duplicate-project-owner'),
      { provider: 'mock', model: 'mock' }, { cwd: f.home })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
      text: 'Create a content project only if this manuscript has no existing project of the selected type.' }] }))
    await agent.whenIdle()
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      .map(event => event.data.message)
    expect(results).toHaveLength(1)
    expect(results[0]!.isError).toBe(true)
    expect(calls).toEqual(['/prod-api/script/center/pool/detail/7', '/prod-api/aigc/script/checkManuscriptProject'])
    expect(await new JubianLedger({ root: join(f.home, 'ledger') }).records()).toEqual([])
  } finally { transport.mockRestore(); await f.ctx.fiber.dispose() }
})
