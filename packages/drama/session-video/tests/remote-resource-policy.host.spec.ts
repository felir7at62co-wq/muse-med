/** Source-generated video calls through the real Gateway and non-owner resource policy. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Attachments from '@deepseek-ai/dsh-attachment-local'
import { apply as applyConnection, inject as connectionInject, Peer } from '@deepseek-ai/dsh-client-connection'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { FaceModelEmitter, WorkspaceAnalyzer } from '@deepseek-ai/dsh-typert-generator'
import type { TypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry, { type TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import { afterEach, beforeAll, expect, it, onTestFinished, vi } from 'vitest'
import { provideBrowserCredentials } from '../../../api/gateway/tests/browser-credentials.ts'
import { executableRemoteModule } from '../../../typert/generator/tests/remote-module.ts'
import { TestSessionQueryEngine } from '../../../session-query/session-query/tests/test-service.ts'
import SessionVideo from '../src/index.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** A caller with no Session video grants. */
    'session-video-test-guest': { readonly kind: 'session-video-test-guest' }
  }
}

let host: TypertContribution, remote: TypertRemoteInfo
beforeAll(async () => {
  // Full Host builds own diagnostics; this owner exercises source-generated wire codecs and resource readers.
  const [face] = new WorkspaceAnalyzer({ root: resolve(import.meta.dirname, '../../../..'),
    packages: ['@deepseek-ai/dsh-session-video'], faces: ['host'], checkDiagnostics: false, rejectBuildOutputs: true }).analyze().faces
  if (face === undefined) throw Error('Missing Session video Host program')
  const artifact = new FaceModelEmitter(face).emit('@deepseek-ai/dsh-session-video')
  if (artifact?.remote === undefined) throw Error('Missing source-generated Session video Remote')
  host = (await executableRemoteModule<{ TYPERT: TypertContribution }>(artifact.js)).TYPERT
  remote = (await executableRemoteModule<{ TYPERT_REMOTE: TypertRemoteInfo }>(artifact.remote.js)).TYPERT_REMOTE
}, 60_000)

afterEach(() => { vi.restoreAllMocks() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'session-video-remote-policy-')), ctx = new Context()
  onTestFinished(async () => { try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } })
  await ctx.plugin(TypertRegistry).await()
  await ctx.plugin(RemoteAccess).await()
  await ctx.plugin(Gateway).await()
  provideBrowserCredentials(ctx)
  await ctx.plugin({ inject: [...connectionInject], apply: applyConnection }).await()
  await ctx.plugin(Sessions).await()
  await ctx.plugin(Projections).await()
  await ctx.plugin(TestSessionQueryEngine).await()
  await ctx.plugin(FileSystem, { cwd: root }).await()
  await ctx.plugin(Attachments, { dshHome: root }).await()
  await ctx.plugin(Subprocess).await()
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', workspaceRoot: root }).await()
  await ctx.plugin(SessionVideo).await()
  ctx.typert.register(host)
  ctx.typert.remotes.register(remote)
  ctx.remoteAccess.registerPolicy('session-video-test-guest', { bindings: () => [] })
  const session = ctx.sessions.create(SessionId('remote-policy-session'), { meta: { cwd: root } })
  const guest = new Peer(ctx, { principal: { kind: 'session-video-test-guest' } })
  return { ctx, session, guest }
}

it.each(['list', 'detect'] as const)('denies generated %s calls for the addressed Session before media access', async (method) => {
  const { ctx, session, guest } = await fixture()
  const decide = vi.spyOn(RemoteAccess.prototype, 'decide')
  const resolveSource = vi.spyOn(ctx.fs, 'resolve'), readSession = vi.spyOn(ctx.sessionQuery, 'readSession')
  const spawn = vi.spyOn(ctx.subprocess, 'spawn'), resolveExecutable = vi.spyOn(ctx.subprocess, 'resolveExecutable')
  const args = method === 'list' ? { sessionId: session.id }
    : { sessionId: session.id, sourceId: 'ungranted-source', sourceVersion: 'ungranted-version' }
  const descriptor = remote.methods[`sessionVideo/${method}`]
  if (descriptor === undefined) throw Error('Missing generated video method')
  expect(descriptor.input({ strict: true }).create().parse(args)).toEqual(args)
  await expect(ctx.typertGateway.invoke({ namespace: 'sessionVideo', method, args, peer: guest }))
    .rejects.toMatchObject({ code: 'remote-access/denied', details: { action: `sessionVideo/${method}`, reason: 'no-allow' } })
  expect(decide).toHaveBeenCalledExactlyOnceWith({ principal: guest.principal, action: `sessionVideo/${method}`,
    resources: [{ kind: 'session', id: session.id }], args })
  expect(resolveSource).not.toHaveBeenCalled()
  expect(readSession).not.toHaveBeenCalled()
  expect(resolveExecutable).not.toHaveBeenCalled()
  expect(spawn).not.toHaveBeenCalled()
})

it('returns an empty generated inventory to the legitimate owner without media access', async () => {
  const { ctx, session } = await fixture(), owner = new Peer(ctx, { principal: { kind: 'owner' } })
  const decide = vi.spyOn(RemoteAccess.prototype, 'decide'), spawn = vi.spyOn(ctx.subprocess, 'spawn')
  const descriptor = remote.methods['sessionVideo/list']
  if (descriptor === undefined) throw Error('Missing generated video inventory method')
  const inventory = await ctx.typertGateway.invoke({ namespace: 'sessionVideo', method: 'list', args: { sessionId: session.id }, peer: owner })
  expect(descriptor.result.create().parse(inventory)).toEqual({ sessionId: session.id, sources: [], complete: true, issues: [] })
  expect(decide).not.toHaveBeenCalled()
  expect(spawn).not.toHaveBeenCalled()
})
