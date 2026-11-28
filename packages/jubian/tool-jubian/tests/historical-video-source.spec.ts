/** Exact Session and local file evidence for historical generation reuse. */
import { createHash } from 'node:crypto'
import * as files from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionEventMap } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools/pipeline'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { createHistoricalVideoSourceVerifier } from '../src/prior-video-source.ts'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => { vi.restoreAllMocks() })

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const original = 'https://example.invalid/original.mp4'
const identity = { scriptId: 101, episodeId: 21, storyboardId: 201, taskId: 301, subtaskId: 401, firstResultId: 501 }
const originalFact = { ...identity, originalUrlSha256: hash(original) }
const lookup = { method: 'sources', script_id: identity.scriptId, storyboard_id: identity.storyboardId }
const downloadArgs = { method: 'download', media_kind: 'video', media_url: original, resume: true }

async function fixture() {
  const root = await files.mkdtemp(join(tmpdir(), 'muse-historical-source-'))
  onTestFinished(() => files.rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  const verify = await createHistoricalVideoSourceVerifier(ctx)
  const projectDir = await files.realpath(root)
  const sourcePath = join(projectDir, 'original.mp4')
  const receiptPath = join(projectDir, 'original-receipt.json')
  const bytes = Buffer.from('000000106674797069736f6d00000000', 'hex')
  const saved = { version: 1, path: sourcePath, source_sha256: hash(original), sha256: `sha256:${hash(bytes)}`,
    kind: 'video', media_type: 'video/mp4', bytes: bytes.length }
  const receipt = { ...saved, download_receipt_path: receiptPath, reused: false }
  await Promise.all([files.writeFile(sourcePath, bytes), files.writeFile(receiptPath, JSON.stringify(saved))])
  const session = ctx.sessions.create()
  let step = 0
  const start = (name: string, args: string | Readonly<Record<string, string | number | boolean>>) => {
    const callId = ToolCallId(`source-proof-${String(++step)}`)
    const address = { turn: 1, step }
    session.append('tool/call', { ...address, callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) })
    return (meta?: SessionEventMap['tool/result']['meta'], isError = false) => {
      session.append('tool/result', { ...address, message: createToolResultMessage({ callId, isError, content: [] }),
        ...(meta === undefined ? {} : { meta }) }, { surfaceOp: 'append' })
    }
  }
  const markSource = () => {
    start('jubian_video', lookup)({ [TOOL_BODY_META_KEY]: { historical_video_sources: [originalFact] } })
  }
  const markDownload = () => {
    start('jubian_media', downloadArgs)({ [TOOL_BODY_META_KEY]: receipt })
  }
  const input = { ...identity, sourcePath, projectDir }
  const check = (signal = new AbortController().signal) => verify(session, input, signal)
  return { ctx, session, verify, start, markSource, markDownload, input, check, saved, receipt, receiptPath, sourcePath }
}

it('accepts only a successful matching read and does not revive an older superseded call', async () => {
  const f = await fixture()
  const nonCanonical = ToolCallId('noncanonical-source')
  // @ts-expect-error A malformed in-memory event can bypass the persisted argument field's string type.
  f.session.append('tool/call', { turn: 1, step: 99, name: 'jubian_video', callId: nonCanonical, arguments: { method: 'tasks' } })
  f.session.append('tool/result', { turn: 1, step: 99, message: createToolResultMessage({ callId: nonCanonical, isError: false, content: [] }),
    meta: { [TOOL_BODY_META_KEY]: { historical_video_sources: [originalFact] } } }, { surfaceOp: 'append' })
  f.start('jubian_video', '{malformed')({ [TOOL_BODY_META_KEY]: { historical_video_sources: [originalFact] } })
  f.start('jubian_video', { method: 'tasks' })({ [TOOL_BODY_META_KEY]: { historical_video_sources: [originalFact] } })
  await expect(f.check()).rejects.toThrow('HISTORICAL_VIDEO_SOURCE_RESULT')
  const download = f.start('jubian_media', downloadArgs)
  const oldest = f.start('jubian_video', lookup)
  const otherCard = f.start('jubian_video', { ...lookup, storyboard_id: lookup.storyboard_id + 1 })
  const newest = f.start('jubian_video', JSON.stringify(lookup))
  oldest({ [TOOL_BODY_META_KEY]: { historical_video_sources: [originalFact] } })
  otherCard({ [TOOL_BODY_META_KEY]: { historical_video_sources: [originalFact] } })
  await expect(f.check()).rejects.toThrow('HISTORICAL_VIDEO_SOURCE_RESULT')
  newest({ [TOOL_BODY_META_KEY]: { historical_video_sources: [originalFact] } })
  download({ [TOOL_BODY_META_KEY]: f.receipt })
  await expect(f.check()).resolves.toMatchObject({ path: f.sourcePath, receiptPath: f.receiptPath })
  const failedRefresh = f.start('jubian_video', lookup)
  failedRefresh({ [TOOL_BODY_META_KEY]: { historical_video_sources: [originalFact] } }, true)
  await expect(f.check()).rejects.toThrow('HISTORICAL_VIDEO_SOURCE_RESULT')
})

it.each([
  [{ ...originalFact, scriptId: identity.scriptId + 1 }],
  [{ ...originalFact, storyboardId: identity.storyboardId + 1 }],
  [originalFact, { ...originalFact, episodeId: originalFact.episodeId + 1 }],
  [originalFact, originalFact],
])('rejects contradictory original identity facts from a successful tool call', async (...facts) => {
  const f = await fixture()
  f.start('jubian_video', lookup)({ [TOOL_BODY_META_KEY]: { historical_video_sources: facts } })
  f.markDownload()
  await expect(f.check()).rejects.toThrow('HISTORICAL_VIDEO_SOURCE_RESULT')
})

it('rejects unmatched download arguments, a different URL fingerprint, and invalid Session input', async () => {
  const f = await fixture()
  f.markSource()
  f.start('jubian_media', { ...downloadArgs, resume: false })({ [TOOL_BODY_META_KEY]: f.receipt })
  f.start('jubian_media', { ...downloadArgs, media_url: `${original}?other` })({ [TOOL_BODY_META_KEY]: f.receipt })
  await expect(f.check()).rejects.toThrow('HISTORICAL_VIDEO_SOURCE_DOWNLOAD')
  const signal = new AbortController().signal
  for (const input of [{ ...f.input, sourcePath: 'relative.mp4' }, { ...f.input, projectDir: 'relative' },
    { ...f.input, taskId: 0 }]) {
    await expect(f.verify(f.session, input, signal)).rejects.toThrow('HISTORICAL_VIDEO_SOURCE_SESSION')
  }
  await expect(f.verify(undefined, f.input, signal)).rejects.toThrow('HISTORICAL_VIDEO_SOURCE_SESSION')
  const subagent = f.ctx.sessions.create(undefined, { meta: { origin: 'subagent', parentSession: f.session.id } })
  await expect(f.verify(subagent, f.input, signal)).rejects.toThrow('HISTORICAL_VIDEO_SOURCE_SESSION')
})

it('uses absolute file identity on both Windows and other platforms while keeping the bound URL', async () => {
  const f = await fixture()
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  if (descriptor === undefined) throw new Error('Missing platform descriptor')
  f.markSource()
  for (const platform of ['win32', 'linux']) {
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
    try {
      f.markDownload()
      await expect(f.check()).resolves.toMatchObject({ path: f.sourcePath, urlSha256: hash(original) })
    } finally { Object.defineProperty(process, 'platform', descriptor) }
  }
})

it('refuses paths outside the project, a bad receipt, and a receipt removed after resolution', async () => {
  const f = await fixture()
  f.markSource()
  f.markDownload()
  const outsideProject = await files.mkdir(join(f.input.projectDir, 'other'), { recursive: true })
  if (outsideProject === undefined) throw new Error('Could not create the fixture project')
  await expect(f.verify(f.session, { ...f.input, projectDir: outsideProject }, new AbortController().signal))
    .rejects.toThrow('HISTORICAL_VIDEO_SOURCE_CHANGED')
  await files.writeFile(f.receiptPath, JSON.stringify({ ...f.saved, source_sha256: 'a'.repeat(64) }))
  await expect(f.check()).rejects.toThrow('HISTORICAL_VIDEO_SOURCE_CHANGED')
  await files.writeFile(f.receiptPath, JSON.stringify(f.saved))
  const lstat = files.lstat
  vi.spyOn(files, 'lstat').mockImplementation((path, options) => path === f.receiptPath
    ? Promise.reject(Object.assign(new Error('Fixture receipt removed'), { code: 'ENOENT' })) : lstat(path, options))
  await expect(f.check()).rejects.toThrow('HISTORICAL_VIDEO_SOURCE_CHANGED')
})

it('rejects a media file whose size already disagrees with its downloaded receipt', async () => {
  const f = await fixture()
  f.markSource()
  f.markDownload()
  await files.truncate(f.sourcePath, f.saved.bytes - 1)
  await expect(f.check()).rejects.toThrow('HISTORICAL_VIDEO_SOURCE_CHANGED')
})

it.each(['open', 'read', 'settle'] as const)('rejects a file version change at %s', async (stage) => {
  const f = await fixture()
  f.markSource()
  f.markDownload()
  const open = files.open
  vi.spyOn(files, 'open').mockImplementation(async (path, flags, mode) => {
    const handle = await open(path, flags, mode)
    if (path !== f.sourcePath) return handle
    const stat = handle.stat.bind(handle)
    const wrapped = vi.spyOn(handle, 'stat')
    if (stage === 'open') wrapped.mockImplementationOnce(async (options) => {
      const snapshot = await stat(options)
      return Object.assign(snapshot, { mtimeMs: Number(snapshot.mtimeMs) + 1 })
    })
    if (stage === 'read') wrapped.mockImplementationOnce(async (options) => {
      const snapshot = await stat(options)
      await files.truncate(f.sourcePath, f.saved.bytes - 1)
      return snapshot
    })
    if (stage === 'settle') wrapped.mockImplementationOnce(stat).mockImplementationOnce(async (options) => {
      const snapshot = await stat(options)
      return Object.assign(snapshot, { ctimeMs: Number(snapshot.ctimeMs) + 1 })
    })
    return handle
  })
  await expect(f.check()).rejects.toThrow('HISTORICAL_VIDEO_SOURCE_CHANGED')
})
