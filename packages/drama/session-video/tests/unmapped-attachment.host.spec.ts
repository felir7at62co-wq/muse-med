/** Uploaded Host files remain unavailable to an execution world without a shared-path mapping. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Attachments from '@deepseek-ai/dsh-attachment-local'
import { apply as applyConnection, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Query from '@deepseek-ai/dsh-session-query'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { expect, it, onTestFinished, vi } from 'vitest'
import { provideBrowserCredentials } from '../../../api/gateway/tests/browser-credentials.ts'
import SessionVideo from '../src/index.ts'

/** Real workspace I/O with the public FileSystem contract's unsupported Host-path mapping. */
class UnsharedFileSystem extends FileSystem {
  override processPathFromHostPath(hostPath: string): string | undefined {
    void hostPath
    return undefined
  }
}

/** Inventory needs the real point-read implementation, without a full-text search backend. */
class InventoryQuery extends Query {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('Search is not used by video inventory')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('Search is not used by video inventory')) }
}

it('lists a stored upload as unavailable when its Host path is not shared with the execution filesystem', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-video-unmapped-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  })
  provideBrowserCredentials(ctx)
  await ctx.plugin({ inject: connectionInject, apply: applyConnection })
  await ctx.plugin(Sessions)
  await ctx.plugin(Projections)
  await ctx.plugin(InventoryQuery)
  await ctx.plugin(UnsharedFileSystem, { cwd: root })
  await ctx.plugin(Attachments, { dshHome: root })
  await ctx.plugin(Subprocess)
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', workspaceRoot: root })
  await ctx.plugin(SessionVideo)

  // Inventory does not decode media; both sources carry the same real, stored bytes.
  const bytes = Buffer.from('session-video inventory fixture')
  const workspacePath = join(root, 'workspace.mp4')
  await writeFile(workspacePath, bytes)
  const attachment = await ctx.attachments.saveFile({ data: bytes, name: 'upload.mp4' })
  const hostPath = ctx.attachments.fileHostPath(attachment)
  if (hostPath === undefined) throw Error('The local attachment store did not publish its stored file')
  expect(await readFile(hostPath)).toEqual(bytes)

  const session = ctx.sessions.create(SessionId('unmapped-video-session'), { meta: { cwd: root } })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [
    { type: 'file', attachment },
    { type: 'text', text: '@workspace.mp4' },
  ] }), { surfaceOp: 'append' })
  const mapHostPath = vi.spyOn(ctx.fs, 'processPathFromHostPath')
  const resolve = vi.spyOn(ctx.fs, 'resolve')
  const readBytes = vi.spyOn(ctx.fs, 'readByteRange')
  const spawn = vi.spyOn(ctx.subprocess, 'spawn')
  onTestFinished(() => { vi.restoreAllMocks() })

  const inventory = await ctx.sessionVideo.list(session.id, new AbortController().signal)
  expect(inventory.complete).toBe(true)
  expect(inventory.sources).toMatchObject([
    { origin: 'attachment', label: 'upload.mp4', path: null, status: 'missing', version: null,
      playbackUrl: null, issue: 'Stored video is unavailable in this filesystem' },
    { origin: 'workspace', label: 'workspace.mp4', status: 'local', issue: null },
  ])
  expect(mapHostPath).toHaveBeenCalledExactlyOnceWith(hostPath)
  expect(resolve).toHaveBeenCalledOnce()
  expect(resolve.mock.calls[0]?.[0]).toBe('workspace.mp4')
  expect(inventory.sources[1]?.playbackUrl).toMatch(/^api\/session-video\?/u)
  expect(readBytes).not.toHaveBeenCalled()
  expect(spawn).not.toHaveBeenCalled()
  expect(await readFile(hostPath)).toEqual(bytes)
  expect(await readFile(workspacePath)).toEqual(bytes)
})
