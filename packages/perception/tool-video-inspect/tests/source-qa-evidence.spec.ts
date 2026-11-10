/** Consumer checks use real files and committed Session evidence without running new OCR. */
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { afterEach, expect, it, vi } from 'vitest'
import { verifyVideoObservationEvidence, verifyVideoSourceQaEvidence,
  type VideoObservationEvidenceBinding, type VideoSourceQaEvidenceBinding } from '../src/source-qa-evidence.ts'
import { installReviewState, reviewEvidenceJson, saveReview, VideoReviewId, type VideoReview } from '../src/review-state.ts'
import { installSourceQaState } from '../src/source-qa-state.ts'

const fixtures: { ctx: Context; root: string }[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const { ctx, root } of fixtures.splice(0)) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')

async function fixture(options: { ocr?: boolean; report?: boolean; reportTool?: 'video_inspect' | 'video_source_review' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'muse-source-qa-consumer-')), ctx = new Context()
  fixtures.push({ ctx, root })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) } as never)
  installReviewState(ctx)
  installSourceQaState(ctx)
  const session = ctx.sessions.create(SessionId(randomUUID()))
  const mediaPath = join(root, 'source.mp4'), ocrPath = join(root, 'ocr.json'), inspectionPath = join(root, 'review.json')
  await writeFile(mediaPath, 'consumer fixture source bytes')
  const source = await ctx.fs.resolve(mediaPath, { cwd: root })
  const info = await ctx.fs.stat(source)
  if (info === undefined) throw new Error('Missing fixture media')
  const review: VideoReview = { id: VideoReviewId('original-review'), episode: '50', path: mediaPath,
    source_version: info.version, duration: 3, scanned_until: 3, scan_complete: true,
    frames: [{ id: 'F00001', time: 1, reasons: ['fixture'], exposed: true,
      image: { attachmentId: 'fixture-frame', mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
      observation: { visible: '测试画面中的人物站在门口', change: '人物转头', uncertainty: '' } }] }
  saveReview(ctx, session, review)
  const issue = (name: string, value: object, isError = false) => {
    const callId = ToolCallId(randomUUID())
    session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: '{}' })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId,
      content: [{ type: 'text', text: JSON.stringify(value) }], isError }) }, { surfaceOp: 'append' })
  }
  await writeFile(ocrPath, '{"scan_status":"complete"}')
  await writeFile(inspectionPath, reviewEvidenceJson(review))
  const binding: VideoSourceQaEvidenceBinding = { mediaPath, mediaSha256: digest(await readFile(mediaPath)),
    ocrPath, ocrSha256: digest(await readFile(ocrPath)), inspectionPath, inspectionSha256: digest(await readFile(inspectionPath)),
    sessionId: session.id, reviewId: review.id }
  if (options.ocr !== false) issue('video_ocr', { path: mediaPath, source_version: info.version,
    raw_json_path: ocrPath, raw_json_sha256: binding.ocrSha256 })
  if (options.report !== false) issue(options.reportTool ?? 'video_inspect', { complete: true, path: mediaPath, source_version: info.version,
    review_id: review.id, observation_session_id: session.id, observation_report: inspectionPath,
    observation_report_sha256: binding.inspectionSha256 })
  const verify = (value = binding) => verifyVideoSourceQaEvidence(ctx, session, value, new AbortController().signal)
  const observation: VideoObservationEvidenceBinding = { mediaPath, mediaSha256: binding.mediaSha256,
    inspectionPath, inspectionSha256: binding.inspectionSha256, sessionId: session.id, reviewId: review.id }
  const verifyObservation = (value = observation) => verifyVideoObservationEvidence(ctx, session, value, new AbortController().signal)
  return { ctx, root, session, review, binding, verify, issue, observation, verifyObservation }
}

it('rejects a missing source Session before using any report', async () => {
  const f = await fixture()
  await expect(verifyVideoSourceQaEvidence(f.ctx, undefined, f.binding, new AbortController().signal))
    .rejects.toThrow('SOURCE_QA_SESSION')
})

it('uses the available complete-review tool while rejecting OCR-free source adoption', async () => {
  const f = await fixture({ ocr: false })
  f.ctx.tools.register(defineTool({ name: 'video_source_review', description: 'Fixture complete review availability.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'unused' }))
  await expect(f.verifyObservation()).resolves.toBeUndefined()
  await expect(f.verify()).rejects.toThrow('SOURCE_QA_OCR')
  f.issue('video_ocr', { path: f.binding.mediaPath, source_version: f.review.source_version,
    raw_json_path: f.binding.ocrPath, raw_json_sha256: 'f'.repeat(64) })
  await expect(f.verify()).rejects.toThrow('SOURCE_QA_OCR')
})

it('requires a fresh OCR check when the source version changes before adoption', async () => {
  const f = await fixture()
  await appendFile(f.binding.mediaPath, 'new source before adoption')
  await expect(f.verify()).rejects.toThrow('须重新审看和OCR')
})

it('does not treat an unresolvable saved source path as matching current media', async () => {
  const f = await fixture()
  saveReview(f.ctx, f.session, { ...f.review, path: 'invalid\0source.mp4', id: VideoReviewId('invalid-path-review') })
  await expect(f.verify({ ...f.binding, reviewId: 'invalid-path-review' })).rejects.toThrow('SOURCE_QA_REVIEW')
  await expect(f.verify()).resolves.toBeUndefined()
})

it('requires evidence files rather than a directory or changed bytes', async () => {
  const f = await fixture()
  const directory = join(f.root, 'not-an-artifact')
  await mkdir(directory)
  await expect(f.verify({ ...f.binding, ocrPath: directory })).rejects.toThrow('SOURCE_QA_ARTIFACT')
  await appendFile(f.binding.ocrPath, 'changed')
  await expect(f.verify()).rejects.toThrow('SOURCE_QA_ARTIFACT')
})

it('detects an artifact replaced during its bounded read', async () => {
  const f = await fixture()
  const read = f.ctx.fs.readBytes.bind(f.ctx.fs)
  vi.spyOn(f.ctx.fs, 'readBytes').mockImplementation(async (target, signal, maxBytes) => {
    const bytes = await read(target, signal, maxBytes)
    if (target.displayPath === f.binding.ocrPath) await appendFile(target.displayPath, 'replacement')
    return bytes
  })
  await expect(f.verify()).rejects.toThrow('SOURCE_QA_ARTIFACT')
})

it('rejects even a correctly hashed report whose bytes differ from the current observations', async () => {
  const f = await fixture()
  await appendFile(f.binding.inspectionPath, ' ')
  await expect(f.verify({ ...f.binding, inspectionSha256: digest(await readFile(f.binding.inspectionPath)) }))
    .rejects.toThrow('准确完整观察记录')
})

it.each([false, true])('requires committed report issuance (tool still pending: %s)', async (pending) => {
  const f = await fixture({ report: false })
  if (pending) f.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('pending-review'),
    name: 'video_inspect', arguments: '{}' })
  await expect(f.verify()).rejects.toThrow(pending ? 'SOURCE_QA_TOOL_PENDING' : '报告路径不是当前会话')
})

it('detects source mutation after the report and OCR hashes have been read', async () => {
  const f = await fixture()
  const read = f.ctx.fs.readBytes.bind(f.ctx.fs)
  vi.spyOn(f.ctx.fs, 'readBytes').mockImplementation(async (target, signal, maxBytes) => {
    const bytes = await read(target, signal, maxBytes)
    if (target.displayPath === f.binding.inspectionPath) await appendFile(f.binding.mediaPath, 'new source')
    return bytes
  })
  await expect(f.verify()).rejects.toThrow('SOURCE_QA_CHANGED')
})

it('detects a newer observation revision committed during source verification', async () => {
  const f = await fixture()
  const read = f.ctx.fs.readBytes.bind(f.ctx.fs)
  vi.spyOn(f.ctx.fs, 'readBytes').mockImplementation(async (target, signal, maxBytes) => {
    const bytes = await read(target, signal, maxBytes)
    if (target.displayPath === f.binding.inspectionPath) saveReview(f.ctx, f.session, { ...f.review,
      frames: [{ ...f.review.frames[0]!, observation: { visible: '测试画面中的人物已经走出房门', change: '走出房门', uncertainty: '' } }] })
    return bytes
  })
  await expect(f.verify()).rejects.toThrow('SOURCE_QA_CHANGED')
})

it.each(['video_inspect', 'video_source_review'] as const)('verifies %s observations without reading or requiring OCR', async (reportTool) => {
  const f = await fixture({ ocr: false, reportTool })
  await rm(f.binding.ocrPath)
  const read = vi.spyOn(f.ctx.fs, 'readBytes')
  await expect(f.verifyObservation()).resolves.toBeUndefined()
  expect(read.mock.calls.map(([target]) => target.displayPath)).toEqual([f.observation.inspectionPath])
  await expect(f.verify()).rejects.toThrow()
})

it('ignores unfinished OCR for observation-only evidence while source adoption still waits', async () => {
  const f = await fixture({ ocr: false })
  f.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('pending-ocr'), name: 'video_ocr', arguments: '{}' })
  await expect(f.verifyObservation()).resolves.toBeUndefined()
  await expect(f.verify()).rejects.toThrow('SOURCE_QA_TOOL_PENDING')
})

it('requires the same initiating Session for observation evidence', async () => {
  const f = await fixture({ ocr: false })
  await expect(verifyVideoObservationEvidence(f.ctx, undefined, f.observation, new AbortController().signal))
    .rejects.toThrow('SOURCE_QA_SESSION')
  await expect(f.verifyObservation({ ...f.observation, sessionId: 'another-session' })).rejects.toThrow('SOURCE_QA_SESSION')
})

it.each(['incomplete scan', 'unscanned tail', 'no frames', 'unexposed image', 'missing image',
  'missing observation', 'uncertainty'] as const)('rejects incomplete observation evidence: %s', async (kind) => {
  const f = await fixture({ ocr: false })
  const review = structuredClone(f.review)
  const frame = review.frames[0]!
  if (kind === 'incomplete scan') review.scan_complete = false
  if (kind === 'unscanned tail') review.scanned_until = 2
  if (kind === 'no frames') review.frames = []
  if (kind === 'unexposed image') frame.exposed = false
  if (kind === 'missing image') delete frame.image
  if (kind === 'missing observation') delete frame.observation
  if (kind === 'uncertainty') frame.observation!.uncertainty = '手部是否接触墙面仍需补看。'
  saveReview(f.ctx, f.session, review)
  await expect(f.verifyObservation()).rejects.toThrow('SOURCE_QA_REVIEW')
})

it.each(['missing', 'failed', 'pending'] as const)('requires successful committed observation issuance: %s', async (kind) => {
  const f = await fixture({ ocr: false, report: false })
  if (kind === 'failed') f.issue('video_inspect', { complete: true, path: f.observation.mediaPath,
    source_version: f.review.source_version, review_id: f.review.id, observation_session_id: f.session.id,
    observation_report: f.observation.inspectionPath, observation_report_sha256: f.observation.inspectionSha256 }, true)
  if (kind === 'pending') f.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('pending-observation'),
    name: 'video_inspect', arguments: '{}' })
  await expect(f.verifyObservation()).rejects.toThrow(kind === 'pending' ? 'SOURCE_QA_TOOL_PENDING' : '报告路径不是当前会话')
})

it('rejects a copied or changed report even when its new hash is supplied', async () => {
  const f = await fixture({ ocr: false })
  const copy = join(f.root, 'unissued-copy.json')
  await writeFile(copy, await readFile(f.observation.inspectionPath))
  await expect(f.verifyObservation({ ...f.observation, inspectionPath: copy })).rejects.toThrow('报告路径不是当前会话')
  await appendFile(f.observation.inspectionPath, ' ')
  await expect(f.verifyObservation({ ...f.observation, inspectionSha256: digest(await readFile(f.observation.inspectionPath)) }))
    .rejects.toThrow('准确完整观察记录')
})

it('rejects changed media and a cancelled observation check', async () => {
  const f = await fixture({ ocr: false })
  const controller = new AbortController()
  controller.abort(new Error('cancelled observation'))
  await expect(verifyVideoObservationEvidence(f.ctx, f.session, f.observation, controller.signal))
    .rejects.toThrow('cancelled observation')
  await appendFile(f.observation.mediaPath, 'changed')
  await expect(f.verifyObservation()).rejects.toThrow('SOURCE_QA_CHANGED')
})

it.each(['source', 'observations'] as const)('detects %s changing during an observation-only check', async (kind) => {
  const f = await fixture({ ocr: false })
  const read = f.ctx.fs.readBytes.bind(f.ctx.fs)
  vi.spyOn(f.ctx.fs, 'readBytes').mockImplementation(async (target, signal, maxBytes) => {
    const bytes = await read(target, signal, maxBytes)
    if (kind === 'source') await appendFile(f.observation.mediaPath, 'new source')
    else saveReview(f.ctx, f.session, { ...f.review, frames: [{ ...f.review.frames[0]!,
      observation: { visible: '测试画面中的人物已经走出房门', change: '走出房门', uncertainty: '' } }] })
    return bytes
  })
  await expect(f.verifyObservation()).rejects.toThrow('SOURCE_QA_CHANGED')
})
