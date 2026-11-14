/** Original-owner evidence remains unambiguous across malformed records and changing readers. */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { createMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createGenerationWatchOwnerAttestor, createGenerationWatchSubmissionModelReader, recordedSubmissionBinding, recordedSubmissionModel } from '../src/generation-watch-attestor.ts'
import { generationSessionBindingSchema } from '../src/generation-binding.ts'

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'generation-attestor-boundaries-')))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  await mkdir(join(root, 'video_tasks'))
  await writeFile(join(root, 'project_config.json'), '{"jubian_script_id":1}')
  const owner = { sessionId: SessionId('original'), key: 'b'.repeat(64), runId: 'a'.repeat(64),
    previewPath: join(root, 'video_tasks', 'preview.json') }
  await writeFile(owner.previewPath, '{}')
  const ledger = new JubianLedger({ root: join(root, 'ledger') })
  await ledger.begin({ idempotencyKey: owner.key, method: 'storyboard_native_submit', scriptId: 1,
    requestSha256: 'original', beforeTaskIds: [], videoPreviewPath: owner.previewPath })
  const session = Session.create(owner.sessionId, undefined, { ...Session.create(owner.sessionId).header, cwd: root })
  const callId = ToolCallId('call')
  const args = { method: 'submit_video', idempotency_key: owner.key, preview_path: owner.previewPath }
  const meta = { [TOOL_BODY_META_KEY]: { generationWatchId: owner.runId, submission: args } }
  const close = vi.fn(async () => {})
  const open = vi.fn(async () => ({ header: session.header, inheritedEventCount: 0,
    read: async () => ({ events: session.snapshotEvents() }), close }))
  const stat = vi.fn(async (): Promise<{ revision: string } | undefined> => ({ revision: 'stable' }))
  const reader = { open, stat }
  const begin = () => {
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', { reason: 'initial', header: { config: { provider: 'p', model: 'm' } } })
  }
  const assistant = (name = 'jubian_storyboard', arguments_ = JSON.stringify(args), provider = 'p') => session.append('assistant/message', {
    turn: 1, step: 1, stream: [], message: createMessage({ role: 'assistant',
      content: [{ type: 'text', text: 'Submit the original preview.' }, { type: 'tool-call', id: callId, name, arguments: arguments_ }],
      source: { kind: 'model', provider, model: 'm' } }) }, { surfaceOp: 'append' })
  const call = (arguments_ = JSON.stringify(args)) => session.append('tool/call', {
    turn: 1, step: 1, callId, name: 'jubian_storyboard', arguments: arguments_ })
  const result = () => session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'ok' }], isError: false }), meta }, { surfaceOp: 'append' })
  return { root, owner, ledger, session, callId, args, meta, close, open, stat, reader, begin, assistant, call, result }
}

it.each(['invalid-json', 'non-object', 'missing-batch', 'unsupported-method'] as const)(
  'rejects malformed original submission arguments: %s', async (kind) => {
    const f = await fixture()
    const args = kind === 'invalid-json' ? '{broken' : kind === 'non-object' ? 'null'
      : JSON.stringify({ ...f.args, method: kind === 'missing-batch' ? 'submit_video_batch' : 'read' })
    f.begin(); f.assistant('jubian_storyboard', args); f.call(args); f.result()
    expect(recordedSubmissionModel(f.session.snapshotEvents(), 0, f.owner)).toBeUndefined()
    expect(await createGenerationWatchOwnerAttestor(f.reader, f.ledger, async () => true)(f.owner, f.root)).toBe(false)
    expect(f.close).toHaveBeenCalledOnce()
  })

it('requires a routed request and one advertised root call with the same arguments', async () => {
  const f = await fixture()
  f.session.append('turn/start', { turn: 1 }); f.session.append('step/start', { turn: 1, step: 1 })
  f.assistant(); f.call(); f.result()
  expect(recordedSubmissionModel(f.session.snapshotEvents(), 0, f.owner)).toBeUndefined()
  f.session.append('request/header', { reason: 'initial', header: { config: { provider: 'p', model: 'm' } } })
  f.assistant(); f.call(JSON.stringify({ ...f.args, idempotency_key: 'c'.repeat(64) })); f.result()
  expect(recordedSubmissionModel(f.session.snapshotEvents(), 0, f.owner)).toBeUndefined()
})

it('rejects an unscoped result and a PTC completion outside an active step', async () => {
  const f = await fixture()
  f.begin(); f.assistant(); f.call(); f.result()
  f.session.append('step/end', { turn: 1, step: 1 })
  f.result()
  const nested = { rootCallId: f.callId, parentCallId: f.callId, subCallId: ToolCallId('child'), name: 'jubian_storyboard', arguments: f.args }
  f.session.append('tool/ptc-dispatch', { ...nested, isError: false, content: [] })
  expect(recordedSubmissionModel(f.session.snapshotEvents(), 0, f.owner)).toBeUndefined()
})

it('rejects an advertised call without an active route and a dispatch without its root', async () => {
  const f = await fixture()
  f.assistant()
  f.begin(); f.assistant('jubian_storyboard', JSON.stringify(f.args), 'other-provider'); f.call(); f.result()
  const child = { rootCallId: ToolCallId('missing-root'), parentCallId: ToolCallId('missing-root'),
    subCallId: ToolCallId('child'), name: 'jubian_storyboard', arguments: f.args }
  f.session.append('tool/ptc-dispatch-start', child)
  expect(recordedSubmissionModel(f.session.snapshotEvents(), 0, f.owner)).toBeUndefined()
})

it('rejects a PTC ancestor with an unmatched completion and permits an unfinished ancestor', async () => {
  const f = await fixture()
  f.begin(); f.assistant('tools_ptc', '{}')
  f.session.append('tool/call', { turn: 1, step: 1, callId: f.callId, name: 'tools_ptc', arguments: '{}' })
  const middle = { rootCallId: f.callId, parentCallId: f.callId, subCallId: ToolCallId('middle'), name: 'tools_ptc', arguments: {} }
  const leaf = { rootCallId: f.callId, parentCallId: middle.subCallId, subCallId: ToolCallId('leaf'), name: 'jubian_storyboard', arguments: f.args }
  f.session.append('tool/ptc-dispatch-start', middle)
  f.session.append('tool/ptc-dispatch-start', leaf)
  f.session.append('tool/ptc-dispatch', { ...leaf, isError: false, content: [], meta: f.meta })
  expect(recordedSubmissionModel(f.session.snapshotEvents(), 0, f.owner)).toEqual({ provider: 'p', model: 'm' })
  f.session.append('tool/ptc-dispatch', { ...middle, arguments: { changed: true }, isError: false, content: [] })
  expect(recordedSubmissionModel(f.session.snapshotEvents(), 0, f.owner)).toBeUndefined()
})

it('rejects an ancestor ID reused outside a step after finding its nested result', async () => {
  const f = await fixture()
  f.begin(); f.assistant('tools_ptc', '{}')
  f.session.append('tool/call', { turn: 1, step: 1, callId: f.callId, name: 'tools_ptc', arguments: '{}' })
  const child = { rootCallId: f.callId, parentCallId: f.callId, subCallId: ToolCallId('child'), name: 'jubian_storyboard', arguments: f.args }
  f.session.append('tool/ptc-dispatch-start', child)
  f.session.append('tool/ptc-dispatch', { ...child, isError: false, content: [], meta: f.meta })
  f.session.append('step/end', { turn: 1, step: 1 })
  f.session.append('tool/ptc-dispatch-start', child)
  expect(recordedSubmissionModel(f.session.snapshotEvents(), 0, f.owner)).toBeUndefined()
})

it.each(['missing-before', 'missing-after', 'wrong-session', 'subagent'] as const)(
  'withholds model evidence when the persisted Session is unavailable or not the owner: %s', async (kind) => {
    const f = await fixture()
    f.begin(); f.assistant(); f.call(); f.result()
    if (kind === 'missing-before') f.stat.mockResolvedValue(undefined)
    if (kind === 'missing-after') f.stat.mockResolvedValueOnce({ revision: 'stable' }).mockResolvedValueOnce({ revision: 'stable' })
      .mockResolvedValueOnce({ revision: 'stable' }).mockResolvedValueOnce(undefined)
    if (kind === 'wrong-session' || kind === 'subagent') f.open.mockImplementation(async () => ({
      header: { ...f.session.header, ...(kind === 'wrong-session' ? { id: SessionId('other') } : { origin: 'subagent' as const }) },
      inheritedEventCount: 0, read: async () => ({ events: f.session.snapshotEvents() }), close: f.close }))
    const model = await createGenerationWatchSubmissionModelReader(f.reader, f.ledger, async () => true)(f.owner, f.root)
    expect(model).toBeUndefined()
    expect(f.close).toHaveBeenCalledTimes(kind === 'missing-before' ? 0 : kind === 'missing-after' ? 2 : 1)
  })

it('requires absolute paths, a present revision and a stable owner for attestation', async () => {
  const f = await fixture()
  f.begin(); f.assistant(); f.call(); f.result()
  const attest = createGenerationWatchOwnerAttestor(f.reader, f.ledger, async () => true)
  expect(await attest({ ...f.owner, previewPath: 'relative' }, f.root)).toBe(false)
  expect(await attest(f.owner, 'relative')).toBe(false)
  f.stat.mockResolvedValue(undefined)
  expect(await attest(f.owner, f.root)).toBe(false)
  expect(f.open).not.toHaveBeenCalled()
})

it('ignores inherited submitter events and rejects an error duplicate of a successful result', async () => {
  const f = await fixture()
  f.begin(); f.assistant(); f.call(); f.result()
  f.open.mockImplementation(async () => ({ header: f.session.header, inheritedEventCount: 1,
    read: async () => ({ events: f.session.snapshotEvents() }), close: f.close }))
  expect(await createGenerationWatchOwnerAttestor(f.reader, f.ledger, async () => true)(f.owner, f.root)).toBe(true)
  f.session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId: f.callId, content: [], isError: true }) }, { surfaceOp: 'append' })
  expect(recordedSubmissionModel(f.session.snapshotEvents(), 0, f.owner)).toBeUndefined()
})

it('rejects a conflicting failed completion for the same PTC dispatch', async () => {
  const f = await fixture()
  f.begin(); f.assistant('tools_ptc', '{}')
  f.session.append('tool/call', { turn: 1, step: 1, callId: f.callId, name: 'tools_ptc', arguments: '{}' })
  const child = { rootCallId: f.callId, parentCallId: f.callId, subCallId: ToolCallId('child'), name: 'jubian_storyboard', arguments: f.args }
  f.session.append('tool/ptc-dispatch-start', child)
  f.session.append('tool/ptc-dispatch', { ...child, isError: false, content: [], meta: f.meta })
  f.session.append('tool/ptc-dispatch', { ...child, isError: true, content: [] })
  expect(recordedSubmissionModel(f.session.snapshotEvents(), 0, f.owner)).toBeUndefined()
})

it.each(['owner', 'model'] as const)('refuses a persisted binding that disagrees with its %s', async (kind) => {
  const f = await fixture()
  f.begin(); f.assistant(); f.call()
  const binding = generationSessionBindingSchema.parse({ version: 1,
    authorityId: 'dca137ae-8fd5-4b06-b6f4-c92f2b054e00', workspaceId: 'workspace', workspaceCreatedAt: 'created',
    workspacePath: f.root, workingDirectory: f.root, membershipEpoch: 'dca137ae-8fd5-4b06-b6f4-c92f2b054e01',
    sessionId: kind === 'owner' ? 'other' : f.owner.sessionId, model: { provider: 'p', model: kind === 'model' ? 'other' : 'm' } })
  f.session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId: f.callId, content: [], isError: false }),
    meta: { [TOOL_BODY_META_KEY]: { ...f.meta[TOOL_BODY_META_KEY],
      binding: { ...binding, model: { provider: binding.model.provider, model: binding.model.model } } } } }, { surfaceOp: 'append' })
  expect(recordedSubmissionBinding(f.session.snapshotEvents(), 0, f.owner)).toBeUndefined()
})
