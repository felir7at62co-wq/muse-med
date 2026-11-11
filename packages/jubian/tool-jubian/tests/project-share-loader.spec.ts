/** Real Loader, native project tool and model loop over an isolated sharing provider. */
import { join } from 'node:path'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
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

const SECRET = 'offline-project-share-token'
const key = 'offline-original-share-key'

function previewFrom(options: GenerateOptions): { preview_id: string; preview_fingerprint: string } {
  const message = options.messages.find(item => item.role === 'tool' && item.toolCallId === 'preview')
  if (message === undefined || message.role !== 'tool' || message.isError) throw new Error('Expected real preview in model request')
  const value: unknown = JSON.parse(message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
  if (value === null || typeof value !== 'object' || !('preview_id' in value) || !('preview_fingerprint' in value)
    || typeof value.preview_id !== 'string' || typeof value.preview_fingerprint !== 'string') throw new Error('Preview identity is absent')
  return { preview_id: value.preview_id, preview_fingerprint: value.preview_fingerprint }
}

it('discovers real recipients, previews and confirms an additive share once, then reconciles its original key', async () => {
  const transport = vi.spyOn(globalThis, 'fetch')
  const f = await configurationFixture({ hmr: false, rows: [
    { id: 'tool-executor-native', name: 'cordis:native-executor' },
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: SECRET } },
  ], builtins: { 'native-executor': NativeToolExecutor, prompt: SystemPrompt, tools: Tools,
    credentials: MemoryCredentials, jubian: Jubian } })
  const project = { id: 2708, scriptName: '离线剧变项目', canShare: 1, customField: 'preserve' }
  const existing = { id: 91, scriptId: 2708, shareType: 2, shareTargetType: 1, shareUserId: 13, shareDeptId: null }
  const added = { id: 92, scriptId: 2708, shareType: 2, shareTargetType: 1, shareUserId: 14, shareDeptId: null }
  const requests: { method: string; path: string }[] = []
  let shared = false
  transport.mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    expect(url.origin, 'mock transport rejects external requests').toBe('https://project-share.invalid')
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${SECRET}`)
    const method = init?.method ?? 'GET', path = url.pathname.replace('/prod-api', '')
    requests.push({ method, path })
    let body: object
    if (method === 'GET' && path === '/getInfo') body = { code: 200, data: { user: { userId: 7, userName: '离线编辑' }, permissions: ['aigc:share:add'] } }
    else if (method === 'GET' && path === '/system/user/getSelectUserList') {
      expect(url.searchParams.get('dataType')).toBe('3')
      body = { code: 200, data: [{ userId: 13, nickName: '林工' }, { userId: 14, nickName: '王编导' }] }
    } else if (method === 'GET' && path === '/aigc/script/list') {
      expect(url.searchParams.get('pageNum')).toBe('1')
      body = { code: 200, total: 1, rows: [project] }
    } else if (method === 'GET' && path === '/aigc/share/list') {
      expect(url.searchParams.get('scriptId')).toBe('2708')
      expect(url.searchParams.has('mineOnly')).toBe(false)
      body = { code: 200, total: shared ? 2 : 1, rows: shared ? [existing, added] : [existing] }
    } else if (method === 'POST' && path === '/aigc/share/batchAddShare') {
      expect(shared, 'same-key replay must not make another write').toBe(false)
      if (typeof init?.body !== 'string') throw new Error('Expected checked JSON request')
      expect(JSON.parse(init.body)).toEqual({ ...project, scriptId: 2708, shareDeptId: null,
        userIdList: [13, 14], shareType: 2, shareTargetType: 1 })
      shared = true
      body = { code: 200, data: null }
    } else throw new Error(`Unexpected offline request ${method} ${path}`)
    return new Response(JSON.stringify(body), { status: 200 })
  })
  try {
    await f.ctx.loader.create({ name: 'cordis:jubian', config: { ledgerRoot: join(f.home, 'ledger'),
      workspaceSecrets: false, baseUrl: 'https://project-share.invalid/prod-api' } })
    await f.ctx.loader.await()
    for (const entry of f.ctx.loader.entries()) await entry.fiber?.await()
    await f.ctx.plugin(Llm); await f.ctx.plugin(SessionStore); await f.ctx.plugin(SessionProjections)
    await f.ctx.plugin(AgentRegistry); await f.ctx.plugin(AgentLoop, { agents: [] })
    expect(f.ctx.tools.get('jubian_project')).toBeDefined()
    const apply = (options: GenerateOptions, confirmed: boolean) => ({ method: 'share_apply', script_id: 2708,
      ...previewFrom(options), confirm: confirmed, idempotency_key: key })
    const adapter = new MockAdapter([
      toolCallResponse('targets', 'jubian_project', { method: 'share_targets', share_type: 2 }),
      toolCallResponse('shares', 'jubian_project', { method: 'shares', script_id: 2708 }),
      toolCallResponse('preview', 'jubian_project', { method: 'share_preview', script_id: 2708, share_type: 2, share_target_type: 1, user_ids: [14] }),
      options => toolCallResponse('unconfirmed', 'jubian_project', apply(options, false)),
      options => toolCallResponse('apply', 'jubian_project', apply(options, true)),
      options => toolCallResponse('replay', 'jubian_project', apply(options, true)),
      toolCallResponse('operation', 'jubian_project', { method: 'operation', idempotency_key: key }),
      textResponse('项目已分享给确认的接收人；提供方可见回读已核对原有与新增对象。'),
    ])
    f.ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await f.ctx.agentLoop.create(SessionId('project-share-owner'), { provider: 'mock', model: 'mock' }, { cwd: f.home })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
      text: '在离线模拟提供方中预览项目 2708 给用户 14 的分享，保留原有用户。确认预览后执行；原 key 重放并查询回执。' }] }))
    await agent.whenIdle()
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result').map(event => event.data.message)
    expect(results).toHaveLength(7)
    expect(results.map(result => result.isError)).toEqual([false, false, false, true, false, false, false])
    const value = (index: number): unknown => JSON.parse(results[index]!.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
    expect(value(0)).toMatchObject({ actor_id: 7, users: [{ id: 13, name: '林工' }, { id: 14, name: '王编导' }] })
    expect(value(1)).toMatchObject({ actor_id: 7, script_id: 2708, scope: 'provider_visible', global_access_verified: false })
    expect(value(2)).toMatchObject({ actor_id: 7, additions: [{ id: 14, name: '王编导' }],
      preserved_and_expected: [{ id: 13, name: '林工' }, { id: 14, name: '王编导' }], confirmation_required: true })
    expect(value(4)).toMatchObject({ outcome: 'accepted', status: 'accepted_verified', actor_id: 7,
      original_idempotency_key: key, readback: { status: 'verified', expected_ids: [13, 14], observed_ids: [13, 14] } })
    expect(value(5)).toMatchObject({ outcome: 'accepted', status: 'accepted_verified', replayed: true, original_idempotency_key: key })
    expect(value(6)).toMatchObject({ found: true, status: 'accepted', original_idempotency_key: key })
    expect(requests.filter(request => request.method === 'POST')).toEqual([{ method: 'POST', path: '/aigc/share/batchAddShare' }])
    expect(adapter.requests[0]!.tools?.find(tool => tool.name === 'jubian_project')?.description).toContain('share_preview')
    expect(adapter.requests.at(-1)!.messages.filter(message => message.role === 'tool').map(message => message.content))
      .toEqual(results.map(result => result.content))
    expect(JSON.stringify(agent.session.snapshotEvents())).not.toContain(SECRET)
    expect(JSON.stringify(adapter.requests)).not.toContain(SECRET)
    expect(await new JubianLedger({ root: join(f.home, 'ledger') }).records()).toMatchObject([{ method: 'project_share', outcome: 'accepted' }])
    const row = [...f.ctx.loader.entries()].find(entry => entry.options.name === 'cordis:jubian')
    await row?.fiber?.dispose()
    expect(f.ctx.tools.get('jubian_project')).toBeUndefined()
  } finally { transport.mockRestore(); await f.ctx.fiber.dispose() }
})

it('rejects an invalid sharing page limit when the actual Loader mounts the plugin', async () => {
  const f = await configurationFixture({ hmr: false, rows: [
    { id: 'tool-executor-native', name: 'cordis:native-executor' },
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: SECRET } },
  ], builtins: { 'native-executor': NativeToolExecutor, prompt: SystemPrompt, tools: Tools,
    credentials: MemoryCredentials, jubian: Jubian } })
  try {
    const id = await f.ctx.loader.create({ name: 'cordis:jubian', config: { ledgerRoot: join(f.home, 'ledger'),
      workspaceSecrets: false, baseUrl: 'https://project-share.invalid/prod-api', projectSharePageSize: 0 } })
    await f.ctx.loader.await()
    const entry = f.ctx.loader.resolve(id)
    expect(entry.fiber).toBeDefined()
    await expect(entry.fiber!.await()).rejects.toThrow('projectShare')
    expect(f.ctx.tools.get('jubian_project')).toBeUndefined()
  } finally { await f.ctx.fiber.dispose() }
})
