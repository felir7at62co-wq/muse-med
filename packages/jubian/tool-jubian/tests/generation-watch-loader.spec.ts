/** Keyless Loader coverage for automatic continuation after an original video receipt. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import Llm, { createUserMessage, freezeMessage, LlmError, MessageId, ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import JsonlSessionPersistence from '../../../session/session-persistence-jsonl/src/index.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import { GenerationWatchStore } from '../src/generation-watch-store.ts'
import { createGenerationWatchNotice, deliverGenerationWatchNotice } from '../src/generation-watch-delivery.ts'
import * as Jubian from '../src/index.ts'
import { bodyHash } from '../src/write.ts'

const selection = { provider: 'mock', model: 'mock' }
const model = { platformId: 'YU_DIAN', modelId: 'doubao-seedance-2-0-260128', standardId: 11, genType: 3,
  modelGenerationTypeId: 7, videoStandardId: 91, duration: 8, ratio: '9:16', resolution: '720p', genNum: 1,
  materialList: [], backupModelList: [], prompt: '@[Lead](lead) crosses a quiet street.' }
const image = 'https://cdn.invalid/lead.png'
const video = 'https://cdn.invalid/episode-43-pack-1.mp4'
const board = { id: 1, scriptId: 2708, isGenerate: 1, storyboardName: 'EP43-P1',
  modelConfig: JSON.stringify(model), storyboardMaterialList: [{ assetId: 'asset-lead', materialAssetId: 81285,
    fileName: 'Lead', materialKey: 'lead', materialType: 'image', materialUrl: image, sortOrder: 1 }] }

it('preserves an actual generation notice and its model history with the producer absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'generation-notice-attribution-'))
  const id = SessionId('generation-notice-attribution')
  const contexts: Context[] = []
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('Attribution readback must not call a provider')
  })
  try {
    const host = await watchHost(root)
    contexts.push(host)
    host.llm.registerAdapter(['mock'], new MockAdapter([textResponse('Use the recorded result.')]))
    const agent = await host.agentLoop.create(id, selection, { cwd: root })
    const notice = createGenerationWatchNotice('The existing provider task finished; continue local verification.')
    const groupOrigin = { roomId: 'saved-room', workerBotId: 'worker', requesterBotId: 'requester',
      requesterSessionId: 'saved-requester', exchangeId: 'fe7826ac-de22-4d82-99e1-d97b7859dbb4' }
    const prepareGenerationWatchDelivery = vi.fn(async () => {})
    host.provide('museTeam', { prepareGenerationWatchDelivery })
    await deliverGenerationWatchNotice(host, id, notice, undefined, groupOrigin)
    expect(prepareGenerationWatchDelivery).toHaveBeenCalledExactlyOnceWith({ workerSessionId: id,
      origin: groupOrigin, receiptId: notice.id, noticeId: notice.id, text: notice.text })
    await agent.whenIdle()
    expect(await host.sessions.flush(agent.session)).toBe(true)
    const before = agent.session.deriveMessages()
    const original = agent.session.snapshotEvents().find(event => event.type === 'user/message')
    expect(original?.data).toMatchObject({ id: notice.id,
      source: { kind: 'jubian-generation-watch', form: 'notice', summary: '剧变视频生成结果已核对',
        groupOrigin, groupReceiptId: notice.id },
      content: [{ type: 'text', text: notice.text }] })
    await host.fiber.dispose()
    contexts.pop()

    const reader = new Context()
    contexts.push(reader)
    await reader.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
    expect(reader.get('jubian')).toBeUndefined()
    const handle = await reader.sessionPersistence.open(id, 'read')
    try {
      const { events } = await handle.read()
      const restored = Session.create(id, events, handle.header)
      expect(events.find(event => event.type === 'user/message')).toEqual(original)
      expect(restored.deriveMessages()).toEqual(before)
    } finally { await handle.close() }
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    for (const context of contexts.reverse()) await context.fiber.dispose()
    fetch.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

async function watchHost(root: string, generationWatch = true): Promise<Context> {
  const { ctx } = await configurationFixture({ hmr: false, rows: [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'credentials', name: 'cordis:credentials', config: { JUBIANAI_ADMIN_TOKEN: 'offline-token' } },
    { id: 'llm', name: 'cordis:llm' }, { id: 'sessions', name: 'cordis:sessions' },
    { id: 'projections', name: 'cordis:projections' }, { id: 'agents', name: 'cordis:agents' },
    { id: 'persistence', name: 'cordis:persistence', config: { root: join(root, 'sessions'), compression: 'none' } },
    { id: 'loop', name: 'cordis:loop', config: { agents: [] } },
    { id: 'controller', name: 'cordis:controller' },
    { id: 'jubian', name: 'cordis:jubian', config: { baseUrl: 'https://watch.invalid', workspaceSecrets: false,
      ledgerRoot: join(root, 'ledger'), generationWatch, generationWatchRoot: join(root, 'watches'),
      watchPollIntervalMs: 10, watchTimeoutMs: 60_000 } },
  ], builtins: {
    prompt: SystemPrompt, tools: Tools, credentials: MemoryCredentials, llm: Llm, sessions: SessionStore,
    projections: SessionProjections, agents: AgentRegistry, loop: AgentLoop, persistence: JsonlSessionPersistence,
    controller: { inject: ['llm', 'sessions', 'sessionProjections', 'agents'], apply: (scope: Context) => {
      createSessionTestController(scope, { cwd: root, defaultModelSelection: () => selection })
    } },
    jubian: Jubian,
  } })
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

it('wakes an idle owner after provider completion from the normal video submission tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-generation-loader-'))
  const ledgerRoot = join(root, 'ledger')
  const watchRoot = join(root, 'watches')
  let ctx: Context | undefined
  let finished = false
  let child: Record<string, unknown> | undefined
  const calls: { method: string; path: string }[] = []
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const request = new URL(url instanceof Request ? url.url : url)
    if (request.hostname !== 'watch.invalid') throw new Error('Unexpected provider host')
    const path = request.pathname.replace(/^\/prod-api(?=\/)/u, '')
    const method = String(init?.method)
    calls.push({ method, path })
    if (method === 'PUT') throw new Error('An original intent must never send another PUT')
    const answer = (data: unknown) => new Response(JSON.stringify({ code: 200, data }))
    const taskStatus = finished ? 'succeeded' : 'submit'
    const task = { id: 42, scriptId: 2708, storyboardId: 1, taskType: 1, taskStatus }
    if (path === '/aigc/storyboard/1') return answer(board)
    if (path === '/aigc/asset/81285') return answer({ id: 81285, scriptId: 2708, assetUrl: image, name: 'Lead' })
    if (path === '/aigc/material/list') return answer({ total: 1, rows: [{ id: 1, scriptId: 2708,
      assetId: 81285, hsAssetId: 'asset-lead', assetUrl: image, assetName: 'Lead', hsAssetStatus: 'Active', isUsed: 1 }] })
    if (path === '/model/charge/getSelectList') return answer([{ id: 11, standardId: 11, modelId: model.modelId,
      platformId: model.platformId, duration: 8, genNum: 1, genTypes: [{ id: 7, type: 3 }],
      videoStandards: [{ id: 91, ratio: '9:16', resolution: '720p', genNum: 1 }] }])
    if (path === '/admin/aigc/video/task/list') return answer(child ? { total: 1, rows: [task] } : { total: 0, rows: [] })
    if (path === '/admin/aigc/video/task/42') return answer(task)
    if (path === '/admin/aigc/video/task/sub/list' && child) {
      return answer({ total: 1, rows: [{ ...child, taskStatus,
        resultList: finished ? [{ tosVideoUrl: video, firstResultId: 61 }] : [] }] })
    }
    throw new Error(`Unexpected provider route: ${method} ${path}`)
  })
  try {
    await mkdir(ledgerRoot)
    await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
    const host = await watchHost(root)
    ctx = host
    const prepared = await host.tools.execute({ callId: ToolCallId('prepare-ep43'), name: 'jubian_storyboard',
      arguments: { method: 'prepare_video', storyboard_id: 1, project_dir: root },
      signal: new AbortController().signal })
    expect(prepared.isError, JSON.stringify(prepared.content)).toBe(false)
    const text = prepared.content.find(block => block.type === 'text')
    if (text?.type !== 'text') throw new Error('Expected native preview')
    const { preview_path, idempotencyKey } = JSON.parse(text.text) as { preview_path: string; idempotencyKey: string }
    const { payload } = JSON.parse(await readFile(preview_path, 'utf8')) as { payload: Record<string, unknown> }
    child = { id: 51, aigcVideoTaskId: 42, storyboardId: 1, resolution: '720p',
      modelConfig: payload.modelConfig, imageMaterials: payload.storyboardMaterialList }
    const ledger = new JubianLedger({ root: ledgerRoot })
    await ledger.begin({ idempotencyKey, scriptId: 2708, method: 'storyboard_native_submit',
      requestSha256: bodyHash(payload) })
    await ledger.settle(idempotencyKey, { outcome: 'accepted', httpStatus: 200,
      applicationCode: 200, responseSha256: null })

    const adapter = new MockAdapter([
      toolCallResponse('original-submit', 'jubian_storyboard',
        { method: 'submit_video', preview_path, idempotency_key: idempotencyKey }),
      textResponse('Provider is generating the pack.'),
      textResponse('Continue with the verified pack.'),
    ])
    host.llm.registerAdapter(['mock'], adapter)
    const agent = await host.agentLoop.create(SessionId('generation-watch-owner'), selection, { cwd: root })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue EP43.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agent.status).toBe('idle')
    expect(adapter.requests).toHaveLength(2)
    const store = new GenerationWatchStore(watchRoot)
    const [run] = await store.listActive()
    if (!run) throw new Error('The normal video entry did not persist a watch')
    expect(run.packs).toMatchObject([{ key: idempotencyKey, taskId: 42 }])

    finished = true
    await vi.waitFor(async () => {
      expect(adapter.requests).toHaveLength(3)
      expect((await store.load(run.id))?.notice?.deliveredAt).toEqual(expect.any(Number))
    }, { timeout: 5000 })
    await agent.whenIdle()
    const watch = await store.load(run.id)
    expect(watch?.packs).toMatchObject([{ taskId: 42, outcome: { status: 'succeeded',
      outputs: [{ subtask_id: 51, video_url: video }] } }])
    const handle = await host.sessionPersistence.open(agent.session.id, 'read')
    try {
      const { events } = await handle.read()
      const notices = events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'jubian-generation-watch'
        ? [event.data] : [])
      expect(notices).toHaveLength(1)
      expect(notices[0]?.id).toBe(watch?.notice?.id)
    } finally { await handle.close() }
    expect(calls.filter(call => call.method === 'PUT')).toHaveLength(0)
    expect(await ledger.records()).toHaveLength(1)
  } finally {
    await ctx?.fiber.dispose()
    fetch.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

it('records a failed continuation for review without scheduling another turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-generation-continuation-review-'))
  const sessionId = SessionId('failed-notice-owner')
  const notice = createGenerationWatchNotice('Verified package; continue to local rendering.')
  const id = 'e'.repeat(64)
  let ctx: Context | undefined
  try {
    const host = await watchHost(root)
    ctx = host
    const adapter = new MockAdapter([() => { throw new LlmError('Offline account quota exhausted', 'ACCOUNT_QUOTA') }])
    host.llm.registerAdapter(['mock'], adapter)
    const agent = await host.agentLoop.create(sessionId, selection, { cwd: root })
    const store = new GenerationWatchStore(join(root, 'watches'))
    await store.create({ id, sessionId, createdAt: 0, deadlineAt: 1,
      packs: [{ key: 'f'.repeat(64), previewPath: join(root, 'preview.json'),
        outcome: { status: 'unverified', detail: 'No provider requests are necessary.' } }], notice })
    await vi.waitFor(async () => {
      expect(await store.load(id)).toMatchObject({ reviewRequired: true,
        notice: { id: notice.id, deliveredAt: expect.any(Number) as number } })
    }, { timeout: 3000 })
    expect((await store.load(id))?.recoveryNotice).toBeUndefined()
    expect(await store.listActive()).toEqual([])
    expect(adapter.requests).toHaveLength(1)
    const ends = agent.session.snapshotEvents().filter(event => event.type === 'turn/end')
    expect(ends.map(event => event.data.reason)).toMatchObject([{ kind: 'error', error: { code: 'ACCOUNT_QUOTA' } }])
  } finally {
    await ctx?.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

it('wakes recovery after a persisted download when the continuation turn was interrupted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-generation-interrupted-download-'))
  const sessionId = SessionId('download-recovery-owner')
  const url = 'https://jubian-aigc.tos-cn-beijing.volces.com/test/episode-43-pack-1.mp4'
  const output = join(root, 'pack-1.mp4')
  const notice = createGenerationWatchNotice('Verified package; continue with the local episode workflow.')
  const download = { method: 'download', media_url: url, media_kind: 'video', output_path: output, resume: true }
  const id = 'c'.repeat(64)
  let ctx: Context | undefined
  let requests = 0
  const bytes = Buffer.from('000000106674797069736f6d00000000', 'hex')
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    requests += 1
    const requestedUrl = input instanceof Request ? input.url : input.toString()
    if (requestedUrl !== url || init?.method !== 'GET') throw new Error('Unexpected request while recovering a verified download')
    return new Response(Uint8Array.from(bytes))
  })
  try {
    const first = await watchHost(root, false)
    ctx = first
    const before = new MockAdapter([toolCallResponse('download-pack', 'jubian_media', download), 'hang'])
    first.llm.registerAdapter(['mock'], before)
    const agent = await first.agentLoop.create(sessionId, selection, { cwd: root })
    agent.followup(freezeMessage<UserMessage>({ id: MessageId(notice.id), role: 'user',
      content: [{ type: 'text', text: notice.text }], source: { kind: 'jubian-generation-watch', form: 'notice', summary: 'Verified' } }))
    await vi.waitFor(() => { expect(before.requests).toHaveLength(2) })
    expect((await readFile(output)).equals(bytes)).toBe(true)
    expect(requests).toBe(1)
    expect(await first.sessions.flush(agent.session)).toBe(true)
    const disk = await first.sessionPersistence.open(sessionId, 'read')
    const { header, events } = await (async () => {
      try { return { header: disk.header, events: (await disk.read()).events } }
      finally { await disk.close() }
    })()
    expect(events.filter(event => event.type === 'turn/end')).toHaveLength(0)
    await first.fiber.dispose()
    ctx = undefined

    const restoredRoot = join(root, 'after-crash')
    await mkdir(restoredRoot)
    const host = await watchHost(restoredRoot)
    ctx = host
    const resumed = new MockAdapter([(options) => {
      const prior = JSON.stringify(options.messages)
      expect(prior.includes('download-pack')).toBe(true)
      expect(prior.includes('sha256')).toBe(true)
      expect(prior.includes('上次处理本集时宿主中断')).toBe(true)
      return toolCallResponse('recover-pack', 'jubian_media', download)
    }, textResponse('Use the verified downloaded pack, then continue to local rendering.')])
    host.llm.registerAdapter(['mock'], resumed)
    const restored = await host.sessionPersistence.create(header)
    try { await restored.append(events) } finally { await restored.close() }
    const store = new GenerationWatchStore(join(restoredRoot, 'watches'))
    await store.create({ id, sessionId, createdAt: 0, deadlineAt: 1,
      packs: [{ key: 'd'.repeat(64), previewPath: join(root, 'preview.json'), taskId: 42, outcome: { status: 'succeeded',
        detail: 'Verified', outputs: [{ subtask_id: 51, video_url: url, first_result_id: null, parent_result_id: null, resolution: null }] } }],
      notice })
    await vi.waitFor(async () => {
      expect(resumed.requests).toHaveLength(2)
      expect((await store.load(id))?.notice?.deliveredAt).toEqual(expect.any(Number))
    }, { timeout: 3000 })
    const final = await store.load(id)
    expect(typeof final?.recoveryNotice?.id).toBe('string')
    expect(final?.recoveryNotice?.id === notice.id).toBe(false)
    expect(requests).toBe(1)
    expect((await readFile(output)).equals(bytes)).toBe(true)
    const handle = await host.sessionPersistence.open(sessionId, 'read')
    try {
      const { events: replayed } = await handle.read()
      const results = replayed.filter(event => event.type === 'tool/result')
      expect(results).toHaveLength(2)
      const reused = results[1]?.data.message.content.find(block => block.type === 'text')
      expect(reused?.type === 'text' && (JSON.parse(reused.text) as { reused?: unknown }).reused).toBe(true)
      expect(replayed.filter(event => event.type === 'turn/end' && event.data.reason.kind === 'interrupted')).toHaveLength(1)
      expect(replayed.filter(event => event.type === 'turn/end' && event.data.reason.kind === 'completed')).toHaveLength(1)
    } finally { await handle.close() }
  } finally {
    await ctx?.fiber.dispose()
    fetch.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

it('wakes the same persisted notice when the Host stopped before the Bot claimed it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-generation-pending-inbox-'))
  const sessionId = SessionId('queued-notice-owner')
  const notice = createGenerationWatchNotice('Verified package; resume its local work.')
  const id = 'a'.repeat(64)
  let ctx: Context | undefined
  try {
    const first = await watchHost(root, false)
    ctx = first
    const agent = await first.agentLoop.create(sessionId, selection, { cwd: root })
    agent.inbox.append('next-turn', freezeMessage<UserMessage>({ id: MessageId(notice.id), role: 'user',
      content: [{ type: 'text', text: notice.text }], source: { kind: 'jubian-generation-watch', form: 'notice', summary: 'Verified' } }))
    expect(await first.sessions.flush(agent.session)).toBe(true)
    expect(agent.status).toBe('idle')
    // Take the on-disk image at the crash point, before graceful shutdown can cancel pending input.
    const disk = await first.sessionPersistence.open(sessionId, 'read')
    const { header, events } = await (async () => {
      try { return { header: disk.header, events: (await disk.read()).events } }
      finally { await disk.close() }
    })()
    await first.fiber.dispose()
    ctx = undefined

    const restoredRoot = join(root, 'after-crash')
    await mkdir(restoredRoot)
    const host = await watchHost(restoredRoot)
    ctx = host
    const adapter = new MockAdapter([textResponse('Resume from the existing package checkpoint.')])
    host.llm.registerAdapter(['mock'], adapter)
    const restored = await host.sessionPersistence.create(header)
    try { await restored.append(events) } finally { await restored.close() }
    const store = new GenerationWatchStore(join(restoredRoot, 'watches'))
    await store.create({ id, sessionId, createdAt: 0, deadlineAt: 1,
      packs: [{ key: 'b'.repeat(64), previewPath: join(root, 'preview.json'),
        outcome: { status: 'unverified', detail: 'No further provider reads are needed for this fixture.' } }], notice })
    await vi.waitFor(async () => {
      expect(adapter.requests).toHaveLength(1)
      expect((await store.load(id))?.notice?.deliveredAt).toEqual(expect.any(Number))
    }, { timeout: 3000 })
    const handle = await host.sessionPersistence.open(sessionId, 'read')
    try {
      const { events: replayed } = await handle.read()
      const added = replayed.flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : [])
      const claimed = replayed.flatMap(event => event.type === 'user/message' ? [event.data] : [])
      expect(added.filter(message => message.id === notice.id)).toHaveLength(1)
      expect(claimed.filter(message => message.id === notice.id)).toHaveLength(1)
    } finally { await handle.close() }
  } finally {
    await ctx?.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
