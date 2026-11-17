/** Stored uploads and downloads whose Host path the provider keeps private or never maps. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentStore, type FileAttachmentRef, type ImageAttachmentLimits, type ImageAttachmentRef,
  type SaveFileAttachment, type SaveImageAttachment, type StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import Attachments, { type LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import { apply as applyConnection, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import Sessions, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Query from '@deepseek-ai/dsh-session-query'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, expect, it, vi } from 'vitest'
import { provideBrowserCredentials } from '../../../api/gateway/tests/browser-credentials.ts'
import SessionVideo from '../src/index.ts'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  const errors: unknown[] = []
  try { vi.unstubAllGlobals() } catch (error) { errors.push(error) }
  for (const ctx of contexts.splice(0)) {
    const failure: unknown = await ctx.fiber.dispose().then(() => undefined, (error: unknown) => error)
    if (failure !== undefined) errors.push(failure)
  }
  for (const root of roots.splice(0)) {
    const failure: unknown = await rm(root, { recursive: true, force: true }).then(() => undefined, (error: unknown) => error)
    if (failure !== undefined) errors.push(failure)
  }
  if (errors.length) throw new AggregateError(errors, 'Attachment Host-path fixture cleanup failed')
})

/** Real workspace I/O with the public FileSystem contract's unsupported Host-path mapping. */
class UnsharedFileSystem extends FileSystem {
  override processPathFromHostPath(hostPath: string): string | undefined {
    void hostPath
    return undefined
  }
}

/**
 * The attachment seam's Host-path member is optional: a provider may keep its
 * stored bytes private to itself. Storage, images and saving stay the real ones.
 * @param inner - The real local store this provider delegates storage to.
 * @returns A provider class publishing no Host file path.
 */
function attachmentsWithoutHostPaths(inner: LocalAttachmentStore) {
  return class PrivateAttachments extends AttachmentStore {
    get imageLimits(): ImageAttachmentLimits { return inner.imageLimits }
    validateImage(input: SaveImageAttachment): Promise<void> { return inner.validateImage(input) }
    saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> { return inner.saveImage(input) }
    readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
      return inner.readImage(ref, signal)
    }
    override saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef> { return inner.saveFile(input) }
    override saveFileStream(input: Parameters<LocalAttachmentStore['saveFileStream']>[0]): Promise<FileAttachmentRef> {
      return inner.saveFileStream(input)
    }
  }
}

/** Inventory needs the real point-read query implementation, without a full-text search backend. */
class InventoryQuery extends Query {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('Search is not used by video inventory')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('Search is not used by video inventory')) }
}

/**
 * Boot the real Session, projection, filesystem, attachment and subprocess
 * services around the video plugin, plus one real provider video payload.
 * @param options - Which optional provider capabilities this fixture withholds.
 * @returns The plugin context, one live Session, and real MP4 provider bytes.
 */
async function fixture(options: { readonly privateHostPaths: boolean; readonly mapHostPaths: boolean }) {
  const root = await mkdtemp(join(tmpdir(), 'session-video-attachment-'))
  roots.push(root)
  const video = join(root, 'provider.mp4')
  execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=10:d=0.2',
    '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', video])
  const provider = readFileSync(video)
  const ctx = new Context(), storage = new Context()
  contexts.push(ctx, storage)
  await storage.plugin(Attachments, { dshHome: root }).await()
  provideBrowserCredentials(ctx)
  await ctx.plugin({ inject: connectionInject, apply: applyConnection }).await()
  await ctx.plugin(Sessions).await()
  await ctx.plugin(Projections).await()
  await ctx.plugin(InventoryQuery).await()
  await ctx.plugin(options.mapHostPaths ? FileSystem : UnsharedFileSystem, { cwd: root }).await()
  if (options.privateHostPaths) {
    await ctx.plugin(attachmentsWithoutHostPaths(storage.attachments as LocalAttachmentStore)).await()
  } else {
    await ctx.plugin(Attachments, { dshHome: root }).await()
  }
  await ctx.plugin(Subprocess).await()
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', workspaceRoot: root }).await()
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(Tools).await()
  await ctx.plugin(SessionVideo).await()
  const session = ctx.sessions.create(SessionId('attachment-host-path-session'), { meta: { cwd: root } })
  return { ctx, session, provider, signal: new AbortController().signal }
}

/**
 * Record one successful logged Jubian provider video on the Session.
 * @param session - Conversation receiving the tool call and its result.
 * @param url - Provider media address the recorded result names.
 */
function recordProviderVideo(session: Session, url: string): void {
  const callId = ToolCallId(`call-${session.seq}`)
  session.append('tool/call', { turn: 1, step: 1, name: 'jubian_video', callId,
    arguments: JSON.stringify({ method: 'subtasks', task_id: 7 }) })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, isError: false,
    content: [{ type: 'text', text: JSON.stringify({ subtasks: { rows: [
      { parent_task_id: 7, status: 'succeeded', video_url: url }] } }) }] }) }, { surfaceOp: 'append' })
}

it('lists a stored upload as unavailable when its provider publishes no Host file path', async () => {
  const f = await fixture({ privateHostPaths: true, mapHostPaths: true })
  const attachment = await f.ctx.attachments.saveFile({ data: Buffer.from('session-video upload fixture'),
    name: 'upload.mp4' })
  expect(f.ctx.attachments.fileHostPath(attachment)).toBeUndefined()
  f.session.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'file', attachment }] }), { surfaceOp: 'append' })
  const inventory = await f.ctx.sessionVideo.list(f.session.id, f.signal)
  expect(inventory.complete).toBe(true)
  expect(inventory.sources).toMatchObject([{ origin: 'attachment', label: 'upload.mp4', path: null,
    status: 'missing', version: null, playbackUrl: null, issue: 'Stored video is unavailable in this filesystem' }])
})

it('refuses a downloaded provider video the attachment provider keeps private', async () => {
  const f = await fixture({ privateHostPaths: true, mapHostPaths: true })
  recordProviderVideo(f.session, 'https://101.aigc.jubianai.net/private-host-path.mp4')
  const source = (await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources[0]
  if (!source?.version) throw Error('Expected a versioned provider source')
  expect(source.status).toBe('remote-only')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(f.provider)))
  const result = await f.ctx.sessionVideo.detect(f.session.id, source.id, source.version, f.signal)
  expect(result).toMatchObject({ sourceId: source.id, sourceVersion: source.version, state: 'failed', shots: [],
    durationSeconds: null, width: null, height: null, issue: 'Video is not available as a local source' })
})

it('refuses a downloaded provider video when the filesystem maps no Host path', async () => {
  const f = await fixture({ privateHostPaths: false, mapHostPaths: false })
  const attachment = await f.ctx.attachments.saveFile({ data: Buffer.from('session-video upload fixture'),
    name: 'upload.mp4' })
  const hostPath = f.ctx.attachments.fileHostPath(attachment)
  if (hostPath === undefined) throw Error('The local attachment store did not publish its stored file')
  expect(f.ctx.fs.processPathFromHostPath(hostPath)).toBeUndefined()
  recordProviderVideo(f.session, 'https://101.aigc.jubianai.net/unshared-filesystem.mp4')
  const source = (await f.ctx.sessionVideo.list(f.session.id, f.signal)).sources[0]
  if (!source?.version) throw Error('Expected a versioned provider source')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(f.provider)))
  const result = await f.ctx.sessionVideo.detect(f.session.id, source.id, source.version, f.signal)
  expect(result).toMatchObject({ state: 'failed', shots: [], issue: 'Video is not available as a local source' })
})
