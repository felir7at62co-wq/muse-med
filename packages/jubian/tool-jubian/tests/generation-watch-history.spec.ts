/** Recover submitter identity from real persisted histories, including incomplete older records. */
import { Context } from '@deepseek-ai/cordis'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { createMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import Sessions, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { generationLogPath } from '../../../session/session-persistence-jsonl/src/format.ts'
import { createGenerationWatchOwnerAttestor, recordedSubmissionModel } from '../src/generation-watch-attestor.ts'

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-submission-history-'))), ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  })
  const sessionsRoot = join(root, 'sessions')
  await ctx.plugin(Sessions)
  await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot, compression: 'none' }).await()
  return { root, ctx, sessionsRoot }
}

const directCases = ['mixed-content', 'missing-header', 'provider-mismatch', 'model-mismatch', 'unadvertised-call',
  'name-mismatch', 'arguments-mismatch', 'replaced-result', 'unscoped-assistant'] as const
const nestedCases = ['ptc-mixed-content', 'ptc-unadvertised-root', 'ptc-unscoped-start', 'ptc-unscoped-end',
  'ptc-duplicate-failed-result'] as const

it.each([...directCases, ...nestedCases])('checks static %s history through the real Session reader', async (kind) => {
  const f = await fixture(), id = SessionId(`history-${kind}`)
  const owner = { sessionId: id, key: 'b'.repeat(64), runId: 'a'.repeat(64), previewPath: join(f.root, 'preview.json') }
  const callId = ToolCallId('original-call'), subCallId = ToolCallId('original-call:child')
  const submission = { method: 'submit_video', idempotency_key: owner.key, preview_path: owner.previewPath }
  const argumentsText = JSON.stringify(submission), isNested = kind.startsWith('ptc-')
  const metadata = { [TOOL_BODY_META_KEY]: { generationWatchId: owner.runId, submission } }
  // These are external JSON records. Only the real JSONL reader admits them as Session events.
  const records: object[] = []
  const add = (type: string, data: unknown, surface: boolean | number = false) => {
    const placement = typeof surface === 'number'
      ? { surfaceOp: { op: 'replace', startSeq: surface, endSeq: surface }, sourceEventSeqs: [surface] }
      : surface ? { surfaceOp: 'append' } : {}
    records.push({ type, seq: records.length, time: records.length + 1, data, ...placement })
  }
  const assistant = () => {
    add('assistant/message', {
      turn: 1, step: 1, stream: [], message: createMessage({ role: 'assistant', content: [
        { type: 'text', text: 'The original submission follows.' },
        ...(kind === 'unadvertised-call' || kind === 'ptc-unadvertised-root' ? [] : [{ type: 'tool-call' as const,
          id: callId, name: isNested ? 'tools_ptc' : 'jubian_storyboard', arguments: isNested ? '{}' : argumentsText }]),
      ], source: { kind: 'model', provider: kind === 'provider-mismatch' ? 'other-provider' : 'fixture',
        model: kind === 'model-mismatch' ? 'other-model' : 'recorded-model' } }),
    }, true)
  }
  const directResult = (failed = false, surface: boolean | number = true) => {
    add('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: failed ? 'Rejected duplicate result' : 'Submitted' }], isError: failed }),
      ...(failed ? {} : { meta: metadata }),
    }, surface)
  }
  const nested = { rootCallId: callId, parentCallId: callId, subCallId, name: 'jubian_storyboard', arguments: submission }
  const nestedResult = (failed = false) => {
    add('tool/ptc-dispatch', { ...nested, isError: failed,
      content: [{ type: 'text', text: failed ? 'Rejected duplicate result' : 'Submitted' }], ...(failed ? {} : { meta: metadata }) })
  }
  add('model/selection', { provider: 'fixture', model: 'recorded-model' })
  add('turn/start', { turn: 1 })
  add('step/start', { turn: 1, step: 1 })
  if (kind !== 'missing-header') add('request/header', { reason: 'initial', header: { config: { provider: 'fixture', model: 'recorded-model' } } })
  assistant()
  if (kind !== 'ptc-unadvertised-root') add('tool/call', { turn: 1, step: 1, callId,
    name: isNested ? 'tools_ptc' : kind === 'name-mismatch' ? 'different_tool' : 'jubian_storyboard',
    arguments: isNested ? '{}' : kind === 'arguments-mismatch' ? JSON.stringify({ ...submission, extra: true }) : argumentsText })
  if (isNested) {
    if (kind !== 'ptc-unscoped-start') add('tool/ptc-dispatch-start', nested)
    if (kind !== 'ptc-unscoped-start' && kind !== 'ptc-unscoped-end') nestedResult()
    if (kind === 'ptc-duplicate-failed-result') nestedResult(true)
  }
  const originalResult = records.length
  if (kind !== 'ptc-unadvertised-root') directResult()
  if (kind === 'replaced-result') directResult(true, originalResult)
  add('step/end', { turn: 1, step: 1 })
  if (kind === 'unscoped-assistant') assistant()
  if (kind === 'ptc-unscoped-start') { add('tool/ptc-dispatch-start', nested); nestedResult() }
  if (kind === 'ptc-unscoped-end') nestedResult()
  add('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const header = { type: 'session', version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false,
    delegationDepth: 0, cwd: f.root }
  const bytes = Buffer.from([header, ...records].map(record => JSON.stringify(record)).join('\n') + '\n')
  const path = generationLogPath(f.sessionsRoot, f.root, id, SESSION_FORMAT_VERSION, 'none')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
  const rejected: Partial<Record<typeof kind, string>> = {
    'unadvertised-call': 'has no advertised tool lifecycle',
    'name-mismatch': 'does not match one advertised tool call',
    'arguments-mismatch': 'does not match one advertised tool call',
    'unscoped-assistant': 'does not match an open turn and step',
    'ptc-duplicate-failed-result': 'PTC dispatch has no unique start',
  }
  const rejection = rejected[kind]
  if (rejection !== undefined) {
    await expect(f.ctx.sessionPersistence.open(id, 'read')).rejects.toThrow(rejection)
    expect(await readFile(path)).toEqual(bytes)
    return
  }
  const reader = await f.ctx.sessionPersistence.open(id, 'read')
  try {
    const { events } = await reader.read()
    expect(events).toHaveLength(records.length)
    expect(events.filter(event => event.type === 'tool/call')).toHaveLength(kind === 'ptc-unadvertised-root' ? 0 : 1)
    expect(recordedSubmissionModel(events, reader.inheritedEventCount, owner))
      .toEqual(kind === 'mixed-content' || kind === 'ptc-mixed-content' ? { provider: 'fixture', model: 'recorded-model' } : undefined)
  } finally { await reader.close() }
  expect(await readFile(path)).toEqual(bytes)
})

it('does not attribute a fork-inherited submission to the ordinary child Session', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'project_config.json'), '{"jubian_script_id":1}')
  await mkdir(join(f.root, 'video_tasks'))
  const previewPath = join(f.root, 'video_tasks', 'preview.json')
  await writeFile(previewPath, '{}')
  const key = 'b'.repeat(64), runId = 'a'.repeat(64), callId = ToolCallId('parent-submission')
  const ledger = new JubianLedger({ root: join(f.root, 'ledger') })
  await ledger.begin({ idempotencyKey: key, method: 'storyboard_native_submit', scriptId: 1,
    requestSha256: 'original', beforeTaskIds: [], videoPreviewPath: previewPath })
  const parent = f.ctx.sessions.create(SessionId('original-parent'), { meta: { cwd: f.root } })
  const submission = { method: 'submit_video', idempotency_key: key, preview_path: previewPath }
  parent.append('model/selection', { provider: 'fixture', model: 'recorded-model' })
  parent.append('turn/start', { turn: 1 })
  parent.append('step/start', { turn: 1, step: 1 })
  parent.append('request/header', { reason: 'initial', header: { config: { provider: 'fixture', model: 'recorded-model' } } })
  parent.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({ role: 'assistant',
    content: [{ type: 'tool-call', id: callId, name: 'jubian_storyboard', arguments: JSON.stringify(submission) }],
    source: { kind: 'model', provider: 'fixture', model: 'recorded-model' } }) }, { surfaceOp: 'append' })
  parent.append('tool/call', { turn: 1, step: 1, callId, name: 'jubian_storyboard', arguments: JSON.stringify(submission) })
  parent.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'Submitted' }], isError: false }),
    meta: { [TOOL_BODY_META_KEY]: { generationWatchId: runId, submission } } }, { surfaceOp: 'append' })
  parent.append('step/end', { turn: 1, step: 1 })
  parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const child = f.ctx.sessions.fork(parent, undefined, SessionId('ordinary-child'))
  const writer = await f.ctx.sessionPersistence.create(child.header, { inheritedEventCount: child.inheritedEventCount })
  try { await writer.append(child.snapshotEvents()); await writer.flush() } finally { await writer.close() }
  const owner = { sessionId: child.id, key, runId, previewPath }, verifyHost = vi.fn(async () => true)
  const reader = await f.ctx.sessionPersistence.open(child.id, 'read')
  try {
    const { events } = await reader.read()
    expect(reader.header.origin).toBeUndefined()
    expect(reader.inheritedEventCount).toBe(parent.snapshotEvents().length)
    expect(events.some(event => event.type === 'tool/call')).toBe(true)
    expect(recordedSubmissionModel(events, reader.inheritedEventCount, owner)).toBeUndefined()
  } finally { await reader.close() }
  expect(await createGenerationWatchOwnerAttestor(f.ctx.sessionPersistence, ledger, verifyHost)(owner, f.root)).toBe(false)
  expect(verifyHost).not.toHaveBeenCalled()
})
