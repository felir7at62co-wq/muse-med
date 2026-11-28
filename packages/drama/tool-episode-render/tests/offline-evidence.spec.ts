import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools/pipeline'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { createLocalDialogueSourceVerifier } from '../src/local-dialogue-patch-origin.ts'
import {
  createOfflinePronunciationVerifier, measuredPronunciationCovers, type OfflinePronunciationEvidence, type OfflinePronunciationVerifier,
} from '../src/offline-pronunciation-evidence.ts'
import { installOfflineWordEvidence, offlineWordReceipt } from '../src/offline-word-evidence.ts'
import type { LocalDialoguePatchSourceBinding } from '../src/source-qa.ts'

const project = resolve('fixture-project')
const source = { path: resolve(project, 'source.mp4'), sha256: 'a'.repeat(64) }
const pcm = { sha256: 'b'.repeat(64), sampleRate: 16000, samples: 16000 } as const
const signal = new AbortController().signal

async function evidenceContext() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await mountAgentLoopTestDependencies(ctx)
  return ctx
}

function issue(session: Session, key: string, args: string, body: unknown, isError = false, tool = 'audio_transcribe') {
  const callId = ToolCallId(key)
  session.append('tool/call', { turn: 1, step: 1, callId, name: tool, arguments: args })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, isError, content: [] }),
    meta: { [TOOL_BODY_META_KEY]: z.json().parse(body) } }, { surfaceOp: 'append' })
}

function useAlternatePathRules<T>(action: () => T): T {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  if (platform === undefined) throw new Error('Missing Node platform descriptor')
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: process.platform === 'win32' ? 'linux' : 'win32' })
    return action()
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
}

it('only accepts the binding actually issued by offline transcription in this session', async () => {
  const ctx = await evidenceContext()
  const read = await installOfflineWordEvidence(ctx)
  const session = ctx.sessions.create(SessionId('offline-word-session'))
  const receipt = offlineWordReceipt.parse({
    kind: 'muse_offline_word_timing', version: 1, project, source, pcm, listening_verified: false,
    receipt: resolve(project, 'transcript', 'offline', 'local-a1b2c3', 'receipt.json'),
    transcript: { path: resolve(project, 'transcript', 'offline', 'local-a1b2c3', 'words.json'), sha256: 'c'.repeat(64) },
    model: { name: 'Systran/faster-whisper-small', revision: '536b0662742c02347bc0e980a01041f333bce120',
      sha256: '3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671' },
  })
  const verify = read(session, signal)
  const body = { offline_transcript: receipt }
  const offline = JSON.stringify({ method: 'offline' })
  issue(session, 'ordinary', JSON.stringify({ method: 'diagnostics' }), body)
  issue(session, 'malformed', '{', body)
  issue(session, 'unavailable', offline, body, true)
  issue(session, 'missing-body', offline, {})
  expect(() => { verify(receipt) }).toThrow('缺少此声音')

  issue(session, 'committed', offline, body)
  expect(() => { verify(receipt) }).not.toThrow()
  expect(() => { verify({ ...receipt, source: { ...source, sha256: 'd'.repeat(64) } }) }).toThrow('缺少此声音')
  expect(() => useAlternatePathRules(() => {
    verify({ ...receipt, receipt: resolve(project, 'unissued.json') })
  })).toThrow('缺少此声音')
  expect(() => { read(undefined, signal)(receipt) }).toThrow('缺少此声音')
  const child = ctx.sessions.fork(session, undefined, SessionId('offline-word-child'))
  expect(() => { read(child, signal)(receipt) }).toThrow('缺少此声音')
  const restored = Session.create(session.id, session.snapshotEvents(), session.header)
  expect(() => { read(restored, signal)(receipt) }).not.toThrow()
})

const pronunciation: OfflinePronunciationEvidence = {
  version: 1, evidence_id: '11111111-1111-4111-8111-111111111111', project, source,
  model: { name: 'robinsonphan/sensevoice-small-zh-pinyin-dual-ctc', revision: '884e70660b97f9c242f1d77c8516aea62a8fdf29',
    sha256: 'ed3c7db2468b99fd3811578fff6000c990875c22b1e93abcd08f9c05bc61a93a' },
  status: 'matching_in_windows', expected: 'li3', alternative: 'li4', target_index: 1,
  windows: [
    { start: 0, end: 0.8, observed: 'li3', target_seconds: 0.3, alternative_minus_expected: -12, pcm },
    { start: 0.1, end: 0.9, observed: 'li3', target_seconds: 0.31, alternative_minus_expected: -10, pcm },
  ],
  minimum_margin: 8, listening_verified: false, note: 'fixture', tokens: ['ni3', 'li3', 'hao3'],
}

it('recovers actual pronunciation with the committed phrase and excludes inherited or mismatched results', async () => {
  const ctx = await evidenceContext()
  const verify = await createOfflinePronunciationVerifier(ctx)
  const session = ctx.sessions.create(SessionId('offline-pronunciation-session'))
  const { tokens, ...result } = pronunciation
  const request = { method: 'pronunciation', project, input: source.path,
    pronunciation: { tokens, target_index: result.target_index, alternative: result.alternative,
      windows: result.windows.map(({ start, end }) => ({ start, end })) } }
  const args = JSON.stringify(request)
  issue(session, 'malformed', '{', { offline_pronunciation: result })
  issue(session, 'other-operation', JSON.stringify({ method: 'offline' }), { offline_pronunciation: result })
  issue(session, 'wrong-phrase', args, { offline_pronunciation: { ...result, expected: 'hao3' } })
  issue(session, 'wrong-window', args, { offline_pronunciation: { ...result,
    windows: result.windows.map(window => ({ ...window, end: 1 })) } })
  issue(session, 'error', args, { offline_pronunciation: result }, true)
  issue(session, 'no-native-proof', args, {})
  expect(() => verify(session, result.evidence_id, signal)).toThrow('OFFLINE_PRONUNCIATION_SESSION')

  issue(session, 'actual', args, { offline_pronunciation: result })
  const measured = verify(session, result.evidence_id, signal)
  expect(measured).toEqual(pronunciation)
  issue(session, 'repeated-evidence-id', args, { offline_pronunciation: { ...result, note: 'later output' } })
  measured.tokens.reverse()
  expect(verify(session, result.evidence_id, signal)).toEqual(pronunciation)
  const child = ctx.sessions.fork(session, undefined, SessionId('offline-pronunciation-child'))
  expect(() => verify(child, result.evidence_id, signal)).toThrow('OFFLINE_PRONUNCIATION_SESSION')
  expect(() => verify(session, 'invalid', signal)).toThrow('OFFLINE_PRONUNCIATION_SESSION')
  expect(() => verify(undefined, result.evidence_id, signal)).toThrow('OFFLINE_PRONUNCIATION_SESSION')
})

it('checks both the evidence window and score before counting a pronunciation sample', () => {
  expect(measuredPronunciationCovers(pronunciation, 'li3', 200, 200)).toBe(true)
  const inherited = pronunciation.windows
  const alternatives = inherited.map(window => ({ ...window, observed: 'li4', alternative_minus_expected: 10 }))
  expect(measuredPronunciationCovers({ ...pronunciation, windows: alternatives }, 'li4', 200, 200)).toBe(true)
  for (const changes of [{ start: 0.21 }, { end: 0.39 }, { observed: 'li4' }, { target_seconds: undefined },
    { target_seconds: 0.2 }, { target_seconds: 0.4 }, { alternative_minus_expected: undefined },
    { alternative_minus_expected: -6 }]) {
    expect(measuredPronunciationCovers({ ...pronunciation, windows: inherited.map(window => ({ ...window, ...changes })) },
      'li3', 200, 200)).toBe(false)
  }
})

it('adopts only the exact local repair and its two independently verified original downloads', async () => {
  const ctx = await evidenceContext()
  const session = ctx.sessions.create(SessionId('dialogue-source-session'))
  const output = resolve(project, 'editing', 'dialogue-patch-21-a1b2c3', 'clip.mov')
  const digest = 'c'.repeat(64)
  const original = (id: number, path: string, sha256: string) => ({
    task_id: id, subtask_id: id + 100, first_result_id: id + 200, path, sha256,
    receiptPath: resolve(project, `receipt-${String(id)}.json`), urlSha256: (id === 1 ? 'd' : 'e').repeat(64),
  })
  const target = original(1, source.path, source.sha256)
  const donor = original(2, resolve(project, 'donor.mp4'), 'f'.repeat(64))
  const recheckEvidenceId = '22222222-2222-4222-8222-222222222222'
  const binding: LocalDialoguePatchSourceBinding = {
    project, output, sha256: digest, episode: '21', recheckEvidenceId, originals: { target, donor },
    scriptId: 31, episodeId: 32, storyboardId: 33,
  }
  const after = { ...pronunciation, evidence_id: recheckEvidenceId, source: { path: output, sha256: digest } }
  const read = vi.fn<OfflinePronunciationVerifier>().mockImplementation((_session, id) =>
    id === recheckEvidenceId ? after : pronunciation)
  const verify = await createLocalDialogueSourceVerifier(ctx, read)
  const proof = { version: 1, project, episode: '21',
    target: { ...source, startMs: 200 }, donor: { path: donor.path, sha256: donor.sha256, startMs: 400 },
    output: { path: output, sha256: digest }, durationMs: 200, fadeMs: 8,
    video: { packetsSha256: digest, frames: 24, timeBase: '1/24' },
    audio: { sampleRate: 16000, channels: 1, samples: 16000, targetStartSample: 3200, donorStartSample: 6400,
      patchSamples: 3200, fadeSamples: 128, beforeSha256: digest, afterSha256: digest, originalPatchSha256: digest,
      replacementSha256: digest, outsidePatchSha256: digest },
    reviewStatus: 'pending_review', listeningVerified: false, sourceApproved: false,
    pronunciation_evidence: { target: pronunciation.evidence_id, donor: '33333333-3333-4333-8333-333333333333' },
  }
  const args = JSON.stringify({ project, episode: 21, target_evidence_id: proof.pronunciation_evidence.target,
    donor_evidence_id: proof.pronunciation_evidence.donor, target_start_ms: 200, donor_start_ms: 400, duration_ms: 200 })
  const nativeTool = 'drama_patch_dialogue'
  issue(session, 'broken-call', '{', proof, false, nativeTool)
  issue(session, 'invalid-call', '{}', proof, false, nativeTool)
  issue(session, 'mismatch', args, { ...proof, durationMs: 300 }, false, nativeTool)
  issue(session, 'different-project', args, { ...proof, project: resolve('another-project') }, false, nativeTool)
  issue(session, 'failed-call', args, proof, true, nativeTool)
  issue(session, 'missing-proof', args, {}, false, nativeTool)
  const duplicate = ToolCallId('duplicate-call')
  const call = { turn: 1, step: 1, callId: duplicate, name: nativeTool, arguments: args }
  session.append('tool/call', call)
  session.append('tool/call', call)
  session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId: duplicate, isError: false, content: [] }),
    meta: { [TOOL_BODY_META_KEY]: proof } }, { surfaceOp: 'append' })
  await expect(verify(session, binding, signal)).rejects.toThrow('修音回执不符')
  expect(read).not.toHaveBeenCalled()
  const relativeArgs = JSON.stringify({ project: '.', episode: 21, target_evidence_id: proof.pronunciation_evidence.target,
    donor_evidence_id: proof.pronunciation_evidence.donor, target_start_ms: 200, donor_start_ms: 400, duration_ms: 200 })
  issue(session, 'actual', relativeArgs, proof, false, nativeTool)
  await expect(verify(session, { ...binding, sha256: '9'.repeat(64) }, signal)).rejects.toThrow('修音回执不符')
  await expect(useAlternatePathRules(() => verify(session, { ...binding, sha256: '9'.repeat(64) }, signal)))
    .rejects.toThrow('修音回执不符')
  await expect(verify(session, { ...binding, recheckEvidenceId: pronunciation.evidence_id }, signal)).rejects.toThrow('复测读音')
  const child = ctx.sessions.fork(session, undefined, SessionId('dialogue-source-child'))
  await expect(verify(child, binding, signal)).rejects.toThrow('修音回执不符')
  await expect(verify(undefined, binding, signal)).rejects.toThrow('普通 Muse 会话')
  await expect(verify(session, binding, signal)).rejects.toThrow('缺少剧变原片下载核验')

  const lookup = vi.fn(async (_session: Session, request: { taskId: number }) => {
    const result = request.taskId === target.task_id ? target : donor
    return { path: result.path, sha256: result.sha256, receiptPath: result.receiptPath,
      urlSha256: result.urlSha256 }
  })
  ctx.provide('jubianHistoricalVideoSource', lookup)
  await expect(verify(session, binding, signal)).resolves.toBeUndefined()
  expect(lookup).toHaveBeenCalledWith(session, {
    projectDir: project, sourcePath: donor.path, scriptId: 31, episodeId: 32, storyboardId: 33,
    taskId: donor.task_id, subtaskId: donor.subtask_id, firstResultId: donor.first_result_id,
  }, signal)
  lookup.mockResolvedValueOnce({ ...target, urlSha256: donor.urlSha256 })
  await expect(verify(session, binding, signal)).rejects.toThrow('下载回执与实际修音来源不符')
  lookup.mockImplementationOnce(async () => {
    issue(session, 'second-issuance', args, proof, false, nativeTool)
    return target
  })
  await expect(verify(session, binding, signal)).rejects.toThrow('核验期间修音回执变化')
  await expect(verify(session, binding, signal)).rejects.toThrow('修音回执不符')
})
