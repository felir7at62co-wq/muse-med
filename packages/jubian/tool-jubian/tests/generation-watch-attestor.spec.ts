import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { createMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools'
import { Session, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import { expect, it, vi } from 'vitest'
import { createGenerationWatchOwnerAttestor, createGenerationWatchOwnerResolver, createGenerationWatchSubmissionModelReader, recordedSubmissionBinding, recordedSubmissionModel } from '../src/generation-watch-attestor.ts'
import { generationSessionBindingSchema } from '../src/generation-binding.ts'
import { GenerationWatchStore } from '../src/generation-watch-store.ts'

it.each(['malformed arguments', 'mismatched binding model'] as const)(
  'keeps persisted submission evidence untrusted for %s', async (fault) => {
    const { Context } = await import('@deepseek-ai/cordis')
    const persistencePlugin = await import('@deepseek-ai/dsh-session-persistence-jsonl')
    const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-watch-json-evidence-')))
    const ctx = new Context()
    try {
      await mkdir(join(root, 'video_tasks'))
      await writeFile(join(root, 'project_config.json'), '{"jubian_script_id":1}')
      const previewPath = join(root, 'video_tasks', 'preview.json')
      await writeFile(previewPath, '{}')
      const key = 'b'.repeat(64), runId = 'a'.repeat(64)
      const ledger = new JubianLedger({ root: join(root, 'ledger') })
      await ledger.begin({ idempotencyKey: key, method: 'storyboard_native_submit', scriptId: 1,
        requestSha256: 'original', beforeTaskIds: [], videoPreviewPath: previewPath })
      await ctx.plugin(persistencePlugin, { root: join(root, 'sessions'), compression: 'none' }).await()
      for (const negative of [false, true]) {
        const sessionId = SessionId(negative ? 'rejected-evidence' : 'original-evidence')
        const header = { ...Session.create(sessionId).header, cwd: root }
        const session = Session.create(sessionId, undefined, header), callId = ToolCallId('recorded-call')
        const owner = { key, runId, sessionId, previewPath }
        const args = { method: 'submit_video', idempotency_key: key, preview_path: previewPath }
        const malformed = negative && fault === 'malformed arguments'
        const argumentsText = malformed ? '{"method":' : JSON.stringify(args)
        const binding = generationSessionBindingSchema.parse({ version: 1, authorityId: randomUUID(),
          workspaceId: 'recorded-workspace', workspaceCreatedAt: '2026-11-13T00:00:00.000Z',
          workspacePath: root, membershipEpoch: randomUUID(), sessionId, workingDirectory: root,
          model: { provider: 'fixture', model: negative && fault === 'mismatched binding model' ? 'different-model' : 'fixture' } })
        session.append('model/selection', { provider: 'fixture', model: 'fixture' })
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('request/header', { reason: 'initial', header: { config: { provider: 'fixture', model: 'fixture' } } })
        session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({ role: 'assistant',
          content: [{ type: 'tool-call', id: callId, name: 'jubian_storyboard', arguments: argumentsText }],
          source: { kind: 'model', provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' })
        session.append('tool/call', { turn: 1, step: 1, callId, name: 'jubian_storyboard', arguments: argumentsText })
        session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId,
          content: [{ type: 'text', text: malformed ? 'Invalid JSON arguments' : 'Recorded submission' }], isError: malformed }),
        ...(malformed ? {} : { meta: { [TOOL_BODY_META_KEY]: { generationWatchId: runId, submission: args, binding } } }) },
        { surfaceOp: 'append' })
        session.append('step/end', { turn: 1, step: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        const writer = await ctx.sessionPersistence.create(header)
        try { await writer.append(session.snapshotEvents()); await writer.flush() } finally { await writer.close() }
        const reader = await ctx.sessionPersistence.open(sessionId, 'read')
        try {
          const { events } = await reader.read()
          const call = events.find(event => event.type === 'tool/call')
          expect(call?.type === 'tool/call' && call.data.arguments).toBe(argumentsText)
          expect(recordedSubmissionModel(events, reader.inheritedEventCount, owner))
            .toEqual(malformed ? undefined : { provider: 'fixture', model: 'fixture' })
          expect(recordedSubmissionBinding(events, reader.inheritedEventCount, owner)).toEqual(negative ? undefined : binding)
        } finally { await reader.close() }
        const attest = createGenerationWatchOwnerAttestor(ctx.sessionPersistence, ledger, async () => true)
        expect(await attest(owner, root)).toBe(!malformed)
      }
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
)

it('attests the persisted original submission, project and ledger without opening an Agent', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-watch-attest-')))
  try {
    await mkdir(join(root, 'video_tasks'))
    await writeFile(join(root, 'project_config.json'), '{"jubian_script_id":1}')
    const previewPath = join(root, 'video_tasks', 'preview.json')
    await writeFile(previewPath, '{}')
    const key = 'b'.repeat(64), runId = 'a'.repeat(64), sessionId = SessionId('original')
    const owner = { key, runId, sessionId, previewPath }
    const ledger = new JubianLedger({ root: join(root, 'ledger') })
    await ledger.begin({ idempotencyKey: key, method: 'storyboard_native_submit', scriptId: 1,
      requestSha256: 'original', beforeTaskIds: [], videoPreviewPath: previewPath })
    const header = { ...Session.create(sessionId).header, cwd: root }
    const session = Session.create(sessionId, undefined, header)
    session.append('model/selection', { provider: 'fixture', model: 'fixture' })
    const callId = ToolCallId('original-call')
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'jubian_storyboard',
      arguments: JSON.stringify({ method: 'submit_video', idempotency_key: key, preview_path: previewPath }) })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId,
      content: [{ type: 'text', text: JSON.stringify({ generation_watch_id: runId }) }], isError: false }),
    meta: { [TOOL_BODY_META_KEY]: { generationWatchId: runId,
      submission: { method: 'submit_video', idempotency_key: key, preview_path: previewPath } } } }, { surfaceOp: 'append' })
    const close = vi.fn(async () => {})
    const open = vi.fn(async () => ({ header, inheritedEventCount: 0,
      // Test fixture reads an immutable Session snapshot; production uses persistence.read.
      read: async () => ({ events: session.snapshotEvents() }), close }))
    const attest = createGenerationWatchOwnerAttestor({ open, stat: async () => ({ revision: 'stable' }) }, ledger, async () => true)
    expect(await attest(owner, root)).toBe(true)
    expect(open).toHaveBeenCalledWith(sessionId, 'read')
    expect(close).toHaveBeenCalledOnce()
    expect(await attest({ ...owner, key: 'c'.repeat(64) }, root)).toBe(false)
    expect(await attest({ ...owner, runId: 'd'.repeat(64) }, root)).toBe(false)
    expect(await attest({ ...owner, sessionId: SessionId('other') }, root)).toBe(false)
    let revision = 0
    const changing = createGenerationWatchOwnerAttestor({ open, stat: async () => ({ revision: ++revision }) }, ledger, async () => true)
    expect(await changing(owner, root)).toBe(false)
    const denied = createGenerationWatchOwnerAttestor({ open, stat: async () => ({ revision: 'stable' }) }, ledger, async () => false)
    expect(await denied(owner, root)).toBe(false)
    await writeFile(join(root, 'project_config.json'), '{"jubian_script_id":2}')
    expect(await attest(owner, root)).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('accepts only a completed matching PTC sub-dispatch owned by the original Session', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-watch-ptc-attest-')))
  try {
    await mkdir(join(root, 'video_tasks'))
    await writeFile(join(root, 'project_config.json'), '{"jubian_script_id":1}')
    const previewPath = join(root, 'video_tasks', 'preview.json')
    await writeFile(previewPath, '{}')
    const key = 'b'.repeat(64), runId = 'a'.repeat(64), sessionId = SessionId('original')
    const owner = { key, runId, sessionId, previewPath }
    const ledger = new JubianLedger({ root: join(root, 'ledger') })
    await ledger.begin({ idempotencyKey: key, method: 'storyboard_native_submit', scriptId: 1,
      requestSha256: 'original', beforeTaskIds: [], videoPreviewPath: previewPath })
    const header = { ...Session.create(sessionId).header, cwd: root }
    const session = Session.create(sessionId, undefined, header)
    session.append('model/selection', { provider: 'fixture', model: 'fixture' })
    const callId = ToolCallId('root'), subCallId = ToolCallId('root:ptc:1')
    const args = { method: 'submit_video_batch', video_previews: [{ idempotency_key: key, preview_path: previewPath }] }
    const start = { rootCallId: callId, parentCallId: callId, subCallId, name: 'jubian_storyboard', arguments: args }
    session.append('tool/ptc-dispatch-start', start)
    const open = async () => ({ header, inheritedEventCount: 0,
      read: async () => ({ events: session.snapshotEvents() }), close: async () => {} })
    const attest = createGenerationWatchOwnerAttestor({ open, stat: async () => ({ revision: 'stable' }) }, ledger, async () => true)
    expect(await attest(owner, root)).toBe(false)
    const fake = { ...start, subCallId: ToolCallId('root:ptc:2') }
    session.append('tool/ptc-dispatch-start', fake)
    session.append('tool/ptc-dispatch', { ...fake, isError: false,
      content: [{ type: 'text', text: JSON.stringify({ generation_watch_id: runId }) }] })
    expect(await attest(owner, root)).toBe(false)
    session.append('tool/ptc-dispatch', { ...start, isError: false,
      content: [{ type: 'text', text: JSON.stringify({ generation_watch_id: runId }) }],
      meta: { [TOOL_BODY_META_KEY]: { generationWatchId: runId, submission: args } } })
    expect(await attest(owner, root)).toBe(true)
    session.append('working-directory/change', { cwd: join(root, 'another') })
    expect(await attest(owner, root)).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('reads the original evidence from a real JSONL Session without taking its write lease', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const persistencePlugin = await import('@deepseek-ai/dsh-session-persistence-jsonl')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-watch-persist-attest-')))
  const ctx = new Context()
  try {
    await mkdir(join(root, 'video_tasks'))
    await writeFile(join(root, 'project_config.json'), '{"jubian_script_id":1}')
    const previewPath = join(root, 'video_tasks', 'preview.json')
    await writeFile(previewPath, '{}')
    const key = 'b'.repeat(64), runId = 'a'.repeat(64), sessionId = SessionId('original')
    const ledger = new JubianLedger({ root: join(root, 'ledger') })
    await ledger.begin({ idempotencyKey: key, method: 'storyboard_native_submit', scriptId: 1,
      requestSha256: 'original', beforeTaskIds: [], videoPreviewPath: previewPath })
    const header = { ...Session.create(sessionId).header, cwd: root }
    const session = Session.create(sessionId, undefined, header), callId = ToolCallId('call')
    const args = JSON.stringify({ method: 'submit_video', idempotency_key: key, preview_path: previewPath })
    session.append('model/selection', { provider: 'fixture', model: 'fixture' })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', { reason: 'initial', header: { config: { provider: 'fixture', model: 'fixture' } } })
    session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({ role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'jubian_storyboard', arguments: args }],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'jubian_storyboard', arguments: args })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId,
      content: [{ type: 'text', text: JSON.stringify({ generation_watch_id: runId }) }], isError: false }),
    meta: { [TOOL_BODY_META_KEY]: { generationWatchId: runId,
      submission: { method: 'submit_video', idempotency_key: key, preview_path: previewPath } } } }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.plugin(persistencePlugin, { root: join(root, 'sessions'), compression: 'none' }).await()
    const writer = await ctx.sessionPersistence.create(header)
    try {
      await writer.append(session.snapshotEvents())
      await writer.flush()
      const store = new GenerationWatchStore(join(root, 'watches'))
      const run = { id: runId, sessionId, createdAt: 0, deadlineAt: 100,
        packs: [{ key, previewPath }] }
      await store.claimOwnership(run)
      await store.create(run)
      const modelReader = createGenerationWatchSubmissionModelReader(ctx.sessionPersistence, ledger, async () => true)
      expect(await modelReader({ key, runId, sessionId, previewPath }, root)).toEqual({ provider: 'fixture', model: 'fixture' })
      let changingRevision = 0
      const changingReader = createGenerationWatchSubmissionModelReader({
        stat: async () => ({ revision: ++changingRevision }),
        open: async (id, access) => ctx.sessionPersistence.open(id, access),
      }, ledger, async () => true)
      expect(await changingReader({ key, runId, sessionId, previewPath }, root)).toBeUndefined()
      const deniedReader = createGenerationWatchSubmissionModelReader(ctx.sessionPersistence, ledger, async () => false)
      expect(await deniedReader({ key, runId, sessionId, previewPath }, root)).toBeUndefined()
      const lookup = createGenerationWatchOwnerResolver(store, ctx.sessionPersistence, ledger, async () => true)
      expect(await lookup.resolve(key, previewPath, root)).toEqual({ key, runId, sessionId, previewPath })
      expect(await lookup.resolve(key, join(root, 'wrong'), root)).toBeUndefined()
      await lookup.close()
      await expect(lookup.resolve(key, previewPath, root)).rejects.toThrow('closed')
    } finally { await writer.close() }
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('drains in-flight private lookups and withholds results when the Host scope closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-watch-attestor-close-'))
  try {
    const store = new GenerationWatchStore(root)
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    vi.spyOn(store, 'resolveVerifiedOwner').mockImplementation(async () => {
      entered.resolve(undefined)
      await release.promise
      return { key: 'b'.repeat(64), runId: 'a'.repeat(64), sessionId: SessionId('session'), previewPath: join(root, 'preview') }
    })
    const resolver = createGenerationWatchOwnerResolver(store, {
      stat: async () => undefined, open: async () => { throw new Error('not called') },
    }, new JubianLedger({ root: join(root, 'ledger') }), async () => true)
    const pending = resolver.resolve('b'.repeat(64), join(root, 'preview'), root).catch((error: unknown) => error)
    await entered.promise
    let closed = false
    const closing = resolver.close().then(() => { closed = true })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(closed).toBe(false)
    release.resolve(undefined)
    const result = await pending
    await closing
    expect(result).toBeInstanceOf(Error)
    await expect(resolver.resolve('b'.repeat(64), join(root, 'preview'), root)).rejects.toThrow('closed')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('passes a nested project and original working directory to the Host verifier', async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'muse-watch-subproject-')))
  try {
    const project = join(workspace, 'project')
    await mkdir(join(project, 'video_tasks'), { recursive: true })
    await writeFile(join(project, 'project_config.json'), '{"jubian_script_id":1}')
    const previewPath = join(project, 'video_tasks', 'preview.json')
    await writeFile(previewPath, '{}')
    const key = 'b'.repeat(64), runId = 'a'.repeat(64), sessionId = SessionId('original')
    const ledger = new JubianLedger({ root: join(workspace, 'ledger') })
    await ledger.begin({ idempotencyKey: key, method: 'storyboard_native_submit', scriptId: 1,
      requestSha256: 'original', beforeTaskIds: [], videoPreviewPath: previewPath })
    const header = { ...Session.create(sessionId).header, cwd: workspace }
    const session = Session.create(sessionId, undefined, header), callId = ToolCallId('call')
    session.append('model/selection', { provider: 'fixture', model: 'fixture' })
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'jubian_storyboard',
      arguments: JSON.stringify({ method: 'submit_video', idempotency_key: key, preview_path: previewPath }) })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId,
      content: [{ type: 'text', text: JSON.stringify({ generation_watch_id: runId }) }], isError: false }),
    meta: { [TOOL_BODY_META_KEY]: { generationWatchId: runId,
      submission: { method: 'submit_video', idempotency_key: key, preview_path: previewPath } } } }, { surfaceOp: 'append' })
    const open = async () => ({ header, inheritedEventCount: 0,
      read: async () => ({ events: session.snapshotEvents() }), close: async () => {} })
    const verifyHost = vi.fn(async (id: SessionId, actualHeader: SessionHeader, actualProject: string, actualWorkDir: string) =>
      id === sessionId && actualHeader.cwd === workspace && actualProject === project && actualWorkDir === workspace)
    const attest = createGenerationWatchOwnerAttestor({ open, stat: async () => ({ revision: 'stable' }) }, ledger, verifyHost)
    expect(await attest({ key, runId, sessionId, previewPath }, project)).toBe(true)
    expect(verifyHost).toHaveBeenCalledTimes(2)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

it('does not accept a watch identity appearing only in replaceable tool-result text', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-watch-untrusted-text-')))
  try {
    await mkdir(join(root, 'video_tasks'))
    await writeFile(join(root, 'project_config.json'), '{"jubian_script_id":1}')
    const previewPath = join(root, 'video_tasks', 'preview.json')
    await writeFile(previewPath, '{}')
    const key = 'b'.repeat(64), runId = 'a'.repeat(64), sessionId = SessionId('original')
    const ledger = new JubianLedger({ root: join(root, 'ledger') })
    await ledger.begin({ idempotencyKey: key, method: 'storyboard_native_submit', scriptId: 1,
      requestSha256: 'original', beforeTaskIds: [], videoPreviewPath: previewPath })
    const header = { ...Session.create(sessionId).header, cwd: root }
    const session = Session.create(sessionId, undefined, header), callId = ToolCallId('spoofed-call')
    session.append('model/selection', { provider: 'fixture', model: 'fixture' })
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'jubian_storyboard',
      arguments: JSON.stringify({ method: 'submit_video', idempotency_key: key, preview_path: previewPath }) })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId,
      content: [{ type: 'text', text: JSON.stringify({ generation_watch_id: runId }) }], isError: false }) }, { surfaceOp: 'append' })
    const open = async () => ({ header, inheritedEventCount: 0,
      read: async () => ({ events: session.snapshotEvents() }), close: async () => {} })
    const attest = createGenerationWatchOwnerAttestor({ open, stat: async () => ({ revision: 'stable' }) }, ledger, async () => true)
    expect(await attest({ key, runId, sessionId, previewPath }, root)).toBe(false)
    const replaced = Session.create(sessionId, undefined, header), replacementId = ToolCallId('replaced')
    replaced.append('model/selection', { provider: 'fixture', model: 'fixture' })
    replaced.append('tool/call', { turn: 1, step: 1, callId: replacementId, name: 'jubian_storyboard',
      arguments: JSON.stringify({ method: 'submit_video', idempotency_key: key, preview_path: previewPath }) })
    replaced.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: replacementId,
      content: [{ type: 'text', text: JSON.stringify({ generation_watch_id: runId }) }], isError: false }),
    meta: { [TOOL_BODY_META_KEY]: { generationWatchId: runId,
      submission: { method: 'submit_video', idempotency_key: 'c'.repeat(64), preview_path: previewPath } } } }, { surfaceOp: 'append' })
    const changedOpen = async () => ({ header, inheritedEventCount: 0,
      read: async () => ({ events: replaced.snapshotEvents() }), close: async () => {} })
    const changed = createGenerationWatchOwnerAttestor({ open: changedOpen, stat: async () => ({ revision: 'stable' }) }, ledger, async () => true)
    expect(await changed({ key, runId, sessionId, previewPath }, root)).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})


it('extracts the actual submitting model and effort after later Session selection changes', () => {
  const sessionId = SessionId('original-model-evidence')
  const owner = { sessionId, key: 'b'.repeat(64), runId: 'a'.repeat(64), previewPath: '/workspace/preview.json' }
  const session = Session.create(sessionId)
  const callId = ToolCallId('model-original-call')
  const args = { method: 'submit_video', idempotency_key: owner.key, preview_path: owner.previewPath }
  const original = { provider: 'provider-a', model: 'model-a', reasoningEffort: ReasoningEffortId('high') }
  session.append('model/selection', original)
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { reason: 'initial', header: { config: original } })
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({ role: 'assistant',
    content: [{ type: 'tool-call', id: callId, name: 'jubian_storyboard', arguments: JSON.stringify(args) }],
    source: { kind: 'model', provider: original.provider, model: original.model } }) }, { surfaceOp: 'append' })
  session.append('model/selection', { provider: 'provider-b', model: 'model-b', reasoningEffort: ReasoningEffortId('low') })
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'jubian_storyboard', arguments: JSON.stringify(args) })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'ok' }], isError: false }),
    meta: { [TOOL_BODY_META_KEY]: { generationWatchId: owner.runId, submission: args } } }, { surfaceOp: 'append' })
  session.append('model/selection', { provider: 'provider-c', model: 'model-c' })
  expect(recordedSubmissionModel(session.snapshotEvents(), 0, owner)).toEqual(original)
  expect(recordedSubmissionModel(session.snapshotEvents(), session.seq, owner)).toBeUndefined()
  expect(recordedSubmissionModel(session.snapshotEvents(), 0, { ...owner, key: 'c'.repeat(64) })).toBeUndefined()
})

it('refuses missing, mismatched, or duplicated model evidence for a signed submission', () => {
  const owner = { sessionId: SessionId('ambiguous-model-evidence'), key: 'b'.repeat(64), runId: 'a'.repeat(64), previewPath: '/workspace/preview.json' }
  const session = Session.create(owner.sessionId), callId = ToolCallId('model-call')
  const args = { method: 'submit_video', idempotency_key: owner.key, preview_path: owner.previewPath }
  const appendAssistant = (provider: string) => session.append('assistant/message', { turn: 1, step: 1, stream: [],
    message: createMessage({ role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'jubian_storyboard', arguments: JSON.stringify(args) }],
      source: { kind: 'model', provider, model: 'model-a' } }) }, { surfaceOp: 'append' })
  const appendCall = () => {
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'jubian_storyboard', arguments: JSON.stringify(args) })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'ok' }], isError: false }),
      meta: { [TOOL_BODY_META_KEY]: { generationWatchId: owner.runId, submission: args } } }, { surfaceOp: 'append' })
  }
  session.append('model/selection', { provider: 'provider-a', model: 'model-a' })
  appendAssistant('provider-a')
  appendCall()
  expect(recordedSubmissionModel(session.snapshotEvents(), 0, owner)).toBeUndefined()
  session.append('request/header', { reason: 'initial', header: { config: { provider: 'provider-a', model: 'model-a' } } })
  appendAssistant('wrong-provider')
  appendCall()
  expect(recordedSubmissionModel(session.snapshotEvents(), 0, owner)).toBeUndefined()
  appendAssistant('provider-a')
  appendCall()
  appendCall()
  expect(recordedSubmissionModel(session.snapshotEvents(), 0, owner)).toBeUndefined()
})


it('attributes a completed nested PTC submission to the actual root model', () => {
  const owner = { sessionId: SessionId('nested-model'), key: 'b'.repeat(64), runId: 'a'.repeat(64), previewPath: '/workspace/preview.json' }
  const session = Session.create(owner.sessionId), rootCallId = ToolCallId('ptc-root'), subCallId = ToolCallId('ptc-root:1')
  const args = { method: 'submit_video', idempotency_key: owner.key, preview_path: owner.previewPath }
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { reason: 'initial', header: { config: { provider: 'fixture', model: 'root-model', reasoningEffort: ReasoningEffortId('medium') }, adapterDefaults: { reasoningEffort: true } } })
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({ role: 'assistant',
    content: [{ type: 'tool-call', id: rootCallId, name: 'tools_ptc', arguments: '{}' }],
    source: { kind: 'model', provider: 'fixture', model: 'root-model' } }) }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: rootCallId, name: 'tools_ptc', arguments: '{}' })
  const nested = { rootCallId, parentCallId: rootCallId, subCallId, name: 'jubian_storyboard', arguments: args }
  session.append('tool/ptc-dispatch-start', nested)
  session.append('tool/ptc-dispatch', { ...nested, isError: false, content: [{ type: 'text', text: 'ok' }],
    meta: { [TOOL_BODY_META_KEY]: { generationWatchId: owner.runId, submission: args } } })
  session.append('model/selection', { provider: 'fixture', model: 'later-model' })
  expect(recordedSubmissionModel(session.snapshotEvents(), 0, owner)).toEqual({ provider: 'fixture', model: 'root-model' })
})

it.each(['assistant', 'call', 'result'] as const)('rejects a duplicate direct %s before and after a matching result', (kind) => {
  for (const timing of ['before', 'after'] as const) {
    const owner = { sessionId: SessionId(`direct-${kind}-${timing}`), key: 'b'.repeat(64), runId: 'a'.repeat(64), previewPath: '/workspace/preview.json' }
    const session = Session.create(owner.sessionId), callId = ToolCallId('duplicate-direct')
    const args = { method: 'submit_video', idempotency_key: owner.key, preview_path: owner.previewPath }
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', { reason: 'initial', header: { config: { provider: 'p', model: 'm' } } })
    const assistant = () => session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({ role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'jubian_storyboard', arguments: JSON.stringify(args) }],
      source: { kind: 'model', provider: 'p', model: 'm' } }) }, { surfaceOp: 'append' })
    const call = () => session.append('tool/call', { turn: 1, step: 1, callId, name: 'jubian_storyboard', arguments: JSON.stringify(args) })
    const result = () => session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'ok' }], isError: false }),
      meta: { [TOOL_BODY_META_KEY]: { generationWatchId: owner.runId, submission: args } } }, { surfaceOp: 'append' })
    const duplicate = { assistant, call, result }[kind]
    assistant()
    call()
    if (timing === 'before') duplicate()
    result()
    if (timing === 'after') duplicate()
    expect(recordedSubmissionModel(session.snapshotEvents(), 0, owner), `${kind} ${timing}`).toBeUndefined()
  }
})

it.each(['assistant', 'root', 'sub-start', 'sub-end'] as const)('rejects duplicate PTC %s before and after a matching result', (kind) => {
  for (const timing of ['before', 'after'] as const) {
    const owner = { sessionId: SessionId(`ptc-${kind}-${timing}`), key: 'b'.repeat(64), runId: 'a'.repeat(64), previewPath: '/workspace/preview.json' }
    const session = Session.create(owner.sessionId), rootCallId = ToolCallId('duplicate-ptc'), subCallId = ToolCallId('duplicate-ptc:1')
    const args = { method: 'submit_video', idempotency_key: owner.key, preview_path: owner.previewPath }
    const nested = { rootCallId, parentCallId: rootCallId, subCallId, name: 'jubian_storyboard', arguments: args }
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', { reason: 'initial', header: { config: { provider: 'p', model: 'm' } } })
    const assistant = () => session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({ role: 'assistant',
      content: [{ type: 'tool-call', id: rootCallId, name: 'tools_ptc', arguments: '{}' }], source: { kind: 'model', provider: 'p', model: 'm' } }) }, { surfaceOp: 'append' })
    const root = () => session.append('tool/call', { turn: 1, step: 1, callId: rootCallId, name: 'tools_ptc', arguments: '{}' })
    const subStart = () => session.append('tool/ptc-dispatch-start', nested)
    const subEnd = () => session.append('tool/ptc-dispatch', { ...nested, isError: false, content: [{ type: 'text', text: 'ok' }],
      meta: { [TOOL_BODY_META_KEY]: { generationWatchId: owner.runId, submission: args } } })
    const duplicate = { assistant, root, 'sub-start': subStart, 'sub-end': subEnd }[kind]
    assistant()
    root()
    subStart()
    if (timing === 'before') duplicate()
    subEnd()
    if (timing === 'after') duplicate()
    expect(recordedSubmissionModel(session.snapshotEvents(), 0, owner), `${kind} ${timing}`).toBeUndefined()
  }
})

it('distinguishes reused call IDs in separate, valid Session steps', async () => {
  const owner = { sessionId: SessionId('legal-reused-id'), key: 'b'.repeat(64), runId: 'a'.repeat(64), previewPath: '/workspace/preview.json' }
  const session = Session.create(owner.sessionId), callId = ToolCallId('provider-reused-id')
  const emit = (turn: number, key: string) => {
    const args = { method: 'submit_video', idempotency_key: key, preview_path: owner.previewPath }
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('request/header', { reason: turn === 1 ? 'initial' : 'change', header: { config: { provider: 'p', model: `model-${turn}` } } })
    session.append('assistant/message', { turn, step: 1, stream: [], message: createMessage({ role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'jubian_storyboard', arguments: JSON.stringify(args) }],
      source: { kind: 'model', provider: 'p', model: `model-${turn}` } }) }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step: 1, callId, name: 'jubian_storyboard', arguments: JSON.stringify(args) })
    session.append('tool/result', { turn, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'ok' }], isError: false }),
      meta: { [TOOL_BODY_META_KEY]: { generationWatchId: owner.runId, submission: args } } }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  emit(1, 'c'.repeat(64))
  emit(2, owner.key)
  expect(recordedSubmissionModel(session.snapshotEvents(), 0, owner)).toEqual({ provider: 'p', model: 'model-2' })
  const { Context } = await import('@deepseek-ai/cordis')
  const persistence = await import('@deepseek-ai/dsh-session-persistence-jsonl')
  const root = await mkdtemp(join(tmpdir(), 'muse-watch-valid-reused-id-'))
  const ctx = new Context()
  try {
    await ctx.plugin(persistence, { root, compression: 'none' }).await()
    const writer = await ctx.sessionPersistence.create(session.header)
    try { await writer.append(session.snapshotEvents()); await writer.flush() } finally { await writer.close() }
    const reader = await ctx.sessionPersistence.open(owner.sessionId, 'read')
    try {
      const { events } = await reader.read()
      expect(recordedSubmissionModel(events, reader.inheritedEventCount, owner)).toEqual({ provider: 'p', model: 'model-2' })
    } finally { await reader.close() }
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it.each([false, true])('checks PTC ancestor identity after a matching nested result (duplicate %s)', (duplicate) => {
  const owner = { sessionId: SessionId(`deep-ptc-${String(duplicate)}`), key: 'b'.repeat(64), runId: 'a'.repeat(64), previewPath: '/workspace/preview.json' }
  const session = Session.create(owner.sessionId), rootCallId = ToolCallId('deep-root')
  const middleId = ToolCallId('deep-mid'), leafId = ToolCallId('deep-leaf')
  const args = { method: 'submit_video', idempotency_key: owner.key, preview_path: owner.previewPath }
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { reason: 'initial', header: { config: { provider: 'p', model: 'm' } } })
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({ role: 'assistant',
    content: [{ type: 'tool-call', id: rootCallId, name: 'tools_ptc', arguments: '{}' }],
    source: { kind: 'model', provider: 'p', model: 'm' } }) }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: rootCallId, name: 'tools_ptc', arguments: '{}' })
  const middle = { rootCallId, parentCallId: rootCallId, subCallId: middleId, name: 'tools_ptc', arguments: {} }
  const leaf = { rootCallId, parentCallId: middleId, subCallId: leafId, name: 'jubian_storyboard', arguments: args }
  session.append('tool/ptc-dispatch-start', middle)
  session.append('tool/ptc-dispatch-start', leaf)
  session.append('tool/ptc-dispatch', { ...leaf, isError: false, content: [{ type: 'text', text: 'ok' }],
    meta: { [TOOL_BODY_META_KEY]: { generationWatchId: owner.runId, submission: args } } })
  session.append('tool/ptc-dispatch', { ...middle, isError: false, content: [{ type: 'text', text: 'ok' }] })
  if (duplicate) session.append('tool/ptc-dispatch-start', middle)
  expect(recordedSubmissionModel(session.snapshotEvents(), 0, owner)).toEqual(duplicate ? undefined : { provider: 'p', model: 'm' })
})

it('rejects a later duplicate root with no matching step even after finding a result', () => {
  const owner = { sessionId: SessionId('late-unscoped-root'), key: 'b'.repeat(64), runId: 'a'.repeat(64), previewPath: '/workspace/preview.json' }
  const session = Session.create(owner.sessionId), callId = ToolCallId('late-root')
  const args = { method: 'submit_video', idempotency_key: owner.key, preview_path: owner.previewPath }
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { reason: 'initial', header: { config: { provider: 'p', model: 'm' } } })
  const assistant = (turn: number, step: number) => session.append('assistant/message', { turn, step, stream: [],
    message: createMessage({ role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'jubian_storyboard', arguments: JSON.stringify(args) }],
      source: { kind: 'model', provider: 'p', model: 'm' } }) }, { surfaceOp: 'append' })
  assistant(1, 1)
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'jubian_storyboard', arguments: JSON.stringify(args) })
  session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'ok' }], isError: false }),
    meta: { [TOOL_BODY_META_KEY]: { generationWatchId: owner.runId, submission: args } } }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  assistant(2, 2)
  expect(recordedSubmissionModel(session.snapshotEvents(), 0, owner)).toBeUndefined()
})
