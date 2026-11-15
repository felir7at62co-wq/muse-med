/** Native Host ownership retained while a reviewed source is rendered and published. */
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import {
  acquireGenerationSessionBinding,
  captureGenerationSessionBinding,
  type GenerationExecutionLease,
} from '@deepseek-ai/dsh-tool-jubian/generation-binding'
import { createVideoSourceQaVerifier } from '@deepseek-ai/dsh-tool-video-inspect'
import type { EpisodeSourceAuthorityFactory, EpisodeSourceQaAuthority } from './episode-source-authority-types.ts'

const evidenceTools = new Set(['video_ocr', 'video_inspect', 'video_source_review'])
const evidenceEpochSchema = z.object({ revision: z.number().int(),
  native: z.record(z.string(), z.literal(true)), nested: z.record(z.string(), z.literal(true)) })
type EvidenceEpoch = z.infer<typeof evidenceEpochSchema>

/** Associate completed tool events with their original source-review call. */
function isEvidenceEvent(event: SessionEvent, native: Set<string>, nested: Set<string>): boolean {
  if (event.type === 'video/review') return true
  if (event.type === 'tool/call' && evidenceTools.has(event.data.name)) {
    native.add(event.data.callId)
    return true
  }
  if (event.type === 'tool/ptc-dispatch-start' && evidenceTools.has(event.data.name)) {
    nested.add(event.data.subCallId)
    return true
  }
  if (event.type === 'tool/result' && native.delete(event.data.message.toolCallId)) return true
  if (event.type === 'tool/ptc-dispatch' && (nested.delete(event.data.subCallId) || evidenceTools.has(event.data.name))) return true
  return false
}

/** Refuse restored copies, delegated children, and registry replacements. */
function assertOwner(ctx: Context, agent: Agent, sessionId: SessionId): void {
  if (agent.id !== sessionId || agent.session.id !== sessionId || agent.session.header.origin === 'subagent'
    || ctx.agents.get(sessionId) !== agent || ctx.sessions.get(sessionId) !== agent.session) {
    throw new Error('SOURCE_QA_SESSION: source review requires its registered ordinary Session')
  }
}

/**
 * Retain real Session, workspace, model, directory and source-review owners.
 * @param ctx - Native Host scope supplying the controller, filesystem and projection owners.
 * @returns A factory that acquires an exact saved binding when supplied, otherwise captures the named Session.
 * Publication claims the actual Agent maintenance slot and consumes the authority before queued input wakes.
 * Maintenance excludes the Agent driver, not arbitrary Host appends; source events revoke the authority monotonically.
 */
export async function createEpisodeSourceAuthorityResolver(ctx: Context): Promise<EpisodeSourceAuthorityFactory> {
  for (const name of ['sessionController', 'agents', 'sessions', 'generationWorkspaceAuthority',
    'workingDirectory', 'fs', 'sandboxPolicy', 'sessionProjections', 'tools'] as const) {
    if (ctx.get(name) === undefined) throw new Error(`SOURCE_QA_HOST_UNAVAILABLE: missing ${name}`)
  }
  const verifySourceQa = await createVideoSourceQaVerifier(ctx)
  const epoch = await ctx.sessionProjections.register<'episodeSourceAuthorityEpoch', EvidenceEpoch>({
    key: 'episodeSourceAuthorityEpoch', stateVersion: 1, stateSchema: evidenceEpochSchema,
    init: () => ({ revision: -1, native: {}, nested: {} }),
    apply: (state, event) => {
      const native = new Set(Object.keys(state.native)), nested = new Set(Object.keys(state.nested))
      if (!isEvidenceEvent(event, native, nested)) return state
      return { revision: event.seq,
        native: Object.fromEntries([...native].map(id => [id, true as const])),
        nested: Object.fromEntries([...nested].map(id => [id, true as const])) }
    },
  })
  const lifetime = new AbortController()
  const pending = new Set<Promise<unknown>>()
  const held = new Set<{ session: Session; check(): void; release(): void }>()
  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    const task = operation()
    pending.add(task)
    void task.then(() => { pending.delete(task) }, () => { pending.delete(task) })
    return task
  }
  ctx.on('session/event', (session) => {
    for (const entry of held) if (entry.session === session) entry.check()
  }, { global: true })
  ctx.on('session/disposed', (session) => {
    for (const entry of held) if (entry.session === session) entry.release()
  }, { global: true })
  // Retained projection readers remain readable after their registrations unload.
  ctx.effect(() => async () => {
    lifetime.abort(new Error('SOURCE_QA_OWNER_DISPOSED: Host source-review scope unloaded'))
    await Promise.allSettled([...pending])
    for (const entry of [...held]) entry.release()
  }, 'episode.sourceAuthority')

  return (sessionId, projectDir, signal, expected) => track(async () => {
    const ownerSignal = AbortSignal.any([signal, lifetime.signal])
    ownerSignal.throwIfAborted()
    if (expected !== undefined && expected.sessionId !== sessionId) {
      throw new Error('SOURCE_QA_SESSION: saved binding names another Session')
    }
    const found = await ctx.sessionController.resolveAgent(sessionId)
    if ('error' in found) throw found.error
    ownerSignal.throwIfAborted()
    const agent = found.agent
    assertOwner(ctx, agent, sessionId)
    const revision = epoch.stateOf(agent.session).revision
    let lease: GenerationExecutionLease | undefined
    try {
      const captured = expected === undefined
        ? await captureGenerationSessionBinding(ctx, agent, ownerSignal)
        : undefined
      const binding = expected ?? captured?.binding
      lease = expected === undefined ? captured?.lease
        : await acquireGenerationSessionBinding(ctx, agent, expected, ownerSignal)
      if (binding === undefined || lease === undefined) {
        throw new Error('SOURCE_QA_OWNER_UNAVAILABLE: native workspace, model or directory owner unavailable')
      }
      const execution = lease
      const revoked = new AbortController()
      const active = AbortSignal.any([ownerSignal, revoked.signal, execution.signal])
      const release = () => {
        if (!revoked.signal.aborted) revoked.abort(new Error('SOURCE_QA_AUTHORITY_RELEASED: source authority released'))
        active.removeEventListener('abort', release)
        held.delete(entry)
        execution.release()
      }
      const check = () => {
        if (epoch.stateOf(agent.session).revision !== revision && !revoked.signal.aborted) {
          revoked.abort(new Error('SOURCE_QA_CHANGED: source review changed after authority acquisition'))
        }
      }
      const entry = { session: agent.session, check, release }
      const assertCurrent = () => {
        active.throwIfAborted()
        check()
        active.throwIfAborted()
        assertOwner(ctx, agent, sessionId)
        execution.assertCurrent()
      }
      active.addEventListener('abort', release, { once: true })
      held.add(entry)
      assertCurrent()
      const policy = ctx.sandboxPolicy.resolve({ session: agent.session })
      const [project, workspace, sandbox] = await Promise.all([
        ctx.fs.resolve(projectDir, { cwd: binding.workingDirectory, signal: active }),
        ctx.fs.resolve(binding.workspacePath, { signal: active }),
        ctx.fs.resolve(policy.workspaceRoot, { signal: active }),
      ])
      const projectPath = ctx.fs.processPath(project)
      const workspaceRoot = ctx.fs.processPath(workspace)
      if (!isAbsolute(projectPath) || !isAbsolute(workspaceRoot)
        || !ctx.fs.contains(workspace, project) || !ctx.fs.contains(sandbox, project)
        || (await ctx.fs.stat(project, active))?.type !== 'directory'
        || (await ctx.fs.stat(workspace, active))?.type !== 'directory'
        || (await ctx.fs.stat(sandbox, active))?.type !== 'directory') {
        throw new Error('SOURCE_QA_PROJECT: project is outside the original authorized workspace')
      }
      assertCurrent()
      const assertProject = async (operationSignal: AbortSignal) => {
        assertCurrent()
        const currentPolicy = ctx.sandboxPolicy.resolve({ session: agent.session })
        const [currentProject, currentWorkspace, currentSandbox] = await Promise.all([
          ctx.fs.resolve(projectDir, { cwd: binding.workingDirectory, signal: operationSignal }),
          ctx.fs.resolve(binding.workspacePath, { signal: operationSignal }),
          ctx.fs.resolve(currentPolicy.workspaceRoot, { signal: operationSignal }),
        ])
        if (currentProject.targetKey !== project.targetKey || currentWorkspace.targetKey !== workspace.targetKey
          || currentSandbox.targetKey !== sandbox.targetKey || !ctx.fs.contains(currentWorkspace, currentProject)
          || !ctx.fs.contains(currentSandbox, currentProject) || (await ctx.fs.stat(currentProject, operationSignal))?.type !== 'directory') {
          release()
          throw new Error('SOURCE_QA_PROJECT: authorized project identity changed')
        }
        assertCurrent()
      }
      const authority: EpisodeSourceQaAuthority = {
        binding, sessionId, workspaceRoot, signal: active, assertCurrent, release,
        verify: (evidence, operationSignal) => track(async () => {
          const verifying = AbortSignal.any([active, operationSignal])
          await assertProject(verifying)
          if (evidence.sessionId !== sessionId) throw new Error('SOURCE_QA_SESSION: evidence belongs to another Session')
          for (const file of [evidence.mediaPath, evidence.ocrPath, evidence.inspectionPath]) {
            const target = await ctx.fs.resolve(file, { cwd: projectPath, signal: verifying })
            if (!ctx.fs.contains(file === evidence.mediaPath ? project : workspace, target)
              || !ctx.fs.contains(sandbox, target) || (await ctx.fs.stat(target, verifying))?.type !== 'file') {
              throw new Error('SOURCE_QA_PROJECT: source or Session evidence is outside its original authorized root')
            }
          }
          await verifySourceQa(agent.session, evidence, verifying)
          await assertProject(verifying)
        }),
        withPublication: publish => track(async () => {
          assertCurrent()
          return agent.runMaintenance(async (maintenance) => {
            try {
              const publishing = AbortSignal.any([active, maintenance])
              await assertProject(publishing)
              const result = await publish(publishing)
              await assertProject(publishing)
              return result
            } finally {
              // Release before maintenance wakes queued input; an in-flight directory ensure must not inherit this guard.
              release()
            }
          })
        }),
      }
      return authority
    } catch (error) {
      lease?.release()
      throw error
    }
  })
}
