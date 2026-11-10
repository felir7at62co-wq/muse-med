/** Consumer checks use real files and committed Session evidence without running new OCR. */
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { afterEach, expect, it, vi } from 'vitest'
import { createVideoSourceQaVerifier, type VideoSourceQaEvidenceBinding } from '../src/source-qa-evidence.ts'
import { installReviewState, reviewEvidenceJson, reviewsOf, saveReview, VideoReviewId, type VideoReview } from '../src/review-state.ts'
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

async function fixture(options: { ocr?: boolean; report?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'muse-source-qa-consumer-')), ctx = new Context()
  fixtures.push({ ctx, root })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) } as never)
  const readReviews = await installReviewState(ctx)
  const verifySourceQa = await createVideoSourceQaVerifier(ctx)
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
  saveReview(readReviews, session, review)
  const issue = (name: string, value: Record<string, JsonValue>) => {
    const callId = ToolCallId(randomUUID())
    session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: '{}' })
    session.append('tool/result', { turn: 1, step: 1, meta: { [TOOL_BODY_META_KEY]: value }, message: createToolResultMessage({ callId,
      content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }) }, { surfaceOp: 'append' })
  }
  await writeFile(ocrPath, '{"scan_status":"complete"}')
  await writeFile(inspectionPath, reviewEvidenceJson(review))
  const binding: VideoSourceQaEvidenceBinding = { mediaPath, mediaSha256: digest(await readFile(mediaPath)),
    ocrPath, ocrSha256: digest(await readFile(ocrPath)), inspectionPath, inspectionSha256: digest(await readFile(inspectionPath)),
    sessionId: session.id, reviewId: review.id }
  if (options.ocr !== false) issue('video_ocr', { path: mediaPath, source_version: info.version,
    raw_json_path: ocrPath, raw_json_sha256: binding.ocrSha256 })
  if (options.report !== false) issue('video_inspect', { complete: true, path: mediaPath, source_version: info.version,
    review_id: review.id, observation_session_id: session.id, observation_report: inspectionPath,
    observation_report_sha256: binding.inspectionSha256 })
  const verify = (value = binding) => verifySourceQa(session, value, new AbortController().signal)
  return { ctx, root, session, review, binding, readReviews, verify, verifySourceQa, issue }
}

it('rejects a missing source Session before using any report', async () => {
  const f = await fixture()
  await expect(f.verifySourceQa(undefined, f.binding, new AbortController().signal))
    .rejects.toThrow('SOURCE_QA_SESSION')
})

it('does not treat an unresolvable saved source path as matching current media', async () => {
  const f = await fixture()
  saveReview(f.readReviews, f.session, { ...f.review, path: 'invalid\0source.mp4', id: VideoReviewId('invalid-path-review') })
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
    if (target.displayPath === f.binding.inspectionPath) saveReview(f.readReviews, f.session, { ...f.review,
      frames: [{ ...f.review.frames[0]!, observation: { visible: '测试画面中的人物已经走出房门', change: '走出房门', uncertainty: '' } }] })
    return bytes
  })
  await expect(f.verify()).rejects.toThrow('SOURCE_QA_CHANGED')
})

it('retains the verifier readers after a separate review registration unloads', async () => {
  const f = await fixture()
  const peer = f.ctx.plugin(async (scope: Context) => {
    await installReviewState(scope)
    await installSourceQaState(scope)
  })
  await peer.await()
  await f.verify()
  await peer.dispose()
  await expect(f.verify()).resolves.toBeUndefined()
})

it('does not authorize inherited OCR or observations after a child issues its own report', async () => {
  const f = await fixture()
  const child = f.ctx.sessions.fork(f.session, undefined, SessionId(randomUUID()))
  const callId = ToolCallId(randomUUID())
  child.append('tool/call', { turn: 1, step: 1, callId, name: 'video_source_review', arguments: '{}' })
  child.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId,
    content: [{ type: 'text', text: JSON.stringify({ complete: true, path: f.binding.mediaPath,
      source_version: f.review.source_version, review_id: f.review.id, observation_session_id: child.id,
      observation_report: f.binding.inspectionPath, observation_report_sha256: f.binding.inspectionSha256 }) }], isError: false }),
  }, { surfaceOp: 'append' })
  expect(reviewsOf(await installReviewState(f.ctx), child)[f.review.path]?.id).toBe(f.review.id)
  await expect(f.verifySourceQa(child, { ...f.binding, sessionId: child.id }, new AbortController().signal))
    .rejects.toThrow('审看来自继承会话')
  await expect(f.verify()).resolves.toBeUndefined()
  const ownReview = { ...f.review, id: VideoReviewId('child-review') }
  saveReview(await installReviewState(f.ctx), child, ownReview)
  await writeFile(f.binding.inspectionPath, reviewEvidenceJson(ownReview))
  const ownReportSha = digest(await readFile(f.binding.inspectionPath))
  const ownResult = (name: string, value: Record<string, JsonValue>): void => {
    const id = ToolCallId(randomUUID())
    child.append('tool/call', { turn: 1, step: 1, callId: id, name, arguments: '{}' })
    child.append('tool/result', { turn: 1, step: 1, meta: { [TOOL_BODY_META_KEY]: value }, message: createToolResultMessage({ callId: id,
      content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }) }, { surfaceOp: 'append' })
  }
  ownResult('video_ocr', { path: f.binding.mediaPath, source_version: ownReview.source_version,
    raw_json_path: f.binding.ocrPath, raw_json_sha256: f.binding.ocrSha256 })
  ownResult('video_source_review', { complete: true, path: f.binding.mediaPath, source_version: ownReview.source_version,
    review_id: ownReview.id, observation_session_id: child.id, observation_report: f.binding.inspectionPath,
    observation_report_sha256: ownReportSha })
  await expect(f.verifySourceQa(child, { ...f.binding, sessionId: child.id, reviewId: ownReview.id,
    inspectionSha256: ownReportSha }, new AbortController().signal)).resolves.toBeUndefined()
})
