/** Original native Session and workspace ownership for generation completion.
 * @module @deepseek-ai/dsh-tool-jubian/generation-binding
 */
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-working-directory'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'

/** Persisted authority and exact workspace membership observed at submission. */
export const generationWorkspaceIdentitySchema = z.object({
  version: z.literal(1),
  authorityId: z.uuid().brand<'GenerationAuthorityId'>(),
  workspaceId: z.string().min(1).transform(brandString<WorkspaceId>),
  workspaceCreatedAt: z.string().min(1),
  workspacePath: z.string().refine(isAbsolute),
  membershipEpoch: z.uuid().brand<'GenerationMembershipEpoch'>(),
  sessionId: z.string().min(1).transform(SessionId),
}).strict()

/** Exact native execution selection stored with a newly submitted watch. */
export const generationSessionBindingSchema = generationWorkspaceIdentitySchema.extend({
  workingDirectory: z.string().refine(isAbsolute),
  model: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: z.string().min(1).transform(brandString<ReasoningEffortId>).optional(),
  }).strict(),
}).strict()

/** Durable original workspace membership. */
export type GenerationWorkspaceIdentity = z.infer<typeof generationWorkspaceIdentitySchema>
/** Durable original native Session, workspace, directory and chat model choice. */
export type GenerationSessionBinding = z.infer<typeof generationSessionBindingSchema>

/** Revocable access to an unchanged membership, held through continuation work. */
export interface GenerationWorkspaceLease {
  /** Aborted on release, owner cancellation, disposal or membership change. */
  readonly signal: AbortSignal
  /** Reject if the lease was released, cancelled or lost its authority. */
  assertCurrent(): void
  /** Release this lease; repeated releases have no effect. */
  release(): void
}

/** Workspace owner capability supplied only by a process with exclusive durable ownership. */
export interface GenerationWorkspaceAuthority {
  /**
   * Capture exact non-archived ownership, or return undefined for an unowned Session.
   * @param sessionId - Native Session whose owner is requested.
   * @param signal - Cancellation during capture.
   * @returns the original membership evidence when unambiguous.
   */
  capture(sessionId: SessionId, signal: AbortSignal): Promise<GenerationWorkspaceIdentity | undefined>
  /**
   * Keep an unchanged membership until the caller releases it.
   * @param identity - Previously captured durable membership.
   * @param signal - Owner cancellation releases the lease.
   * @returns a lease whose assertions cover this authority's current durable state.
   */
  acquire(identity: GenerationWorkspaceIdentity, signal: AbortSignal): Promise<GenerationWorkspaceLease>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    generationWorkspaceAuthority: GenerationWorkspaceAuthority
  }
}

/** One exact native Session execution context held until release. */
export interface GenerationExecutionLease {
  /** Combined cancellation of the Session, workspace, model and directory owners. */
  readonly signal: AbortSignal
  /** Recheck all live owners before a model request or tool side effect. */
  assertCurrent(): void
  /** Release every held owner capability. */
  release(): void
}

interface SharedGenerationBinding {
  binding: GenerationSessionBinding
  controller: AbortController
  acquisition: Promise<GenerationExecutionLease | undefined>
  references: number
}

/** Plugin-owned execution guards shared only by one live Agent and exact recorded binding. */
export class GenerationSessionBindings {
  private readonly held = new Map<Agent, SharedGenerationBinding>()
  private readonly acquisitions = new Set<Promise<GenerationExecutionLease | undefined>>()
  private closed = false

  /** @param ctx - Host plugin instance owning the workspace, directory and model services. */
  constructor(private readonly ctx: Context) {
    ctx.effect(() => async () => {
      this.closed = true
      for (const shared of this.held.values()) shared.controller.abort(new Error('generation execution owner unloaded'))
      this.held.clear()
      await Promise.allSettled([...this.acquisitions])
    }, 'generation.sessionBindings')
  }

  /**
   * Retain the original execution guards without competing with this Agent's continuation.
   * Each reference has independent cancellation; the last release frees the underlying guards.
   * Ownership revocation or plugin disposal invalidates every reference.
   * @param agent - Exact live ordinary Agent.
   * @param binding - Unchanged recorded workspace, model and directory identity.
   * @param signal - Lifetime of this reference, independent of other callers.
   * @returns A caller-owned reference, or undefined when an owner capability is absent.
   */
  async acquire(agent: Agent, binding: GenerationSessionBinding, signal: AbortSignal): Promise<GenerationExecutionLease | undefined> {
    signal.throwIfAborted()
    if (this.closed) throw new Error('generation execution owner unloaded')
    let shared = this.held.get(agent)
    if (shared !== undefined && !isDeepStrictEqual(shared.binding, binding)) {
      throw new Error('generation execution binding differs from the held Session selection')
    }
    if (shared === undefined) {
      const controller = new AbortController()
      shared = { binding: structuredClone(binding), controller, references: 0,
        acquisition: acquireGenerationSessionBinding(this.ctx, agent, binding, controller.signal) }
      this.held.set(agent, shared)
      const acquisition = shared.acquisition
      this.acquisitions.add(acquisition)
      void acquisition.then(() => { this.acquisitions.delete(acquisition) }, () => { this.acquisitions.delete(acquisition) })
    }
    const current = shared
    current.references++
    const lifetime = new AbortController()
    let ownerSignal: AbortSignal | undefined
    const release = () => {
      if (lifetime.signal.aborted) return
      signal.removeEventListener('abort', release)
      current.controller.signal.removeEventListener('abort', release)
      ownerSignal?.removeEventListener('abort', release)
      lifetime.abort(signal.aborted ? signal.reason : ownerSignal?.reason
        ?? current.controller.signal.reason ?? new Error('generation execution reference released'))
      current.references--
      if (current.references === 0) {
        this.held.delete(agent)
        current.controller.abort(new Error('generation execution binding has no remaining references'))
      }
    }
    const cancelled = new Promise<never>((_resolve, reject) => {
      lifetime.signal.addEventListener('abort', () => {
        const reason: unknown = lifetime.signal.reason
        reject(reason instanceof Error ? reason : new Error('generation execution reference cancelled', { cause: reason }))
      }, { once: true })
    })
    signal.addEventListener('abort', release, { once: true })
    current.controller.signal.addEventListener('abort', release, { once: true })
    if (signal.aborted || current.controller.signal.aborted) release()
    try {
      const lease = await Promise.race([current.acquisition, cancelled])
      if (lease === undefined) { release(); return undefined }
      ownerSignal = lease.signal
      ownerSignal.addEventListener('abort', release, { once: true })
      if (ownerSignal.aborted) release()
      const assertCurrent = () => { lifetime.signal.throwIfAborted(); lease.assertCurrent() }
      assertCurrent()
      return { signal: lifetime.signal, assertCurrent, release }
    } catch (error) {
      release()
      throw error
    }
  }

  /**
   * Capture and retain this Agent's exact submission selection.
   * @param agent - Ordinary Agent executing the native submission.
   * @param signal - Lifetime of this submission reference.
   * @returns Original binding and its reference, or undefined without owner capabilities.
   */
  async capture(agent: Agent, signal: AbortSignal):
  Promise<{ binding: GenerationSessionBinding; lease: GenerationExecutionLease } | undefined> {
    const binding = await captureGenerationBinding(this.ctx, agent, signal)
    if (binding === undefined) return undefined
    const lease = await this.acquire(agent, binding, signal)
    return lease === undefined ? undefined : { binding, lease }
  }
}

/**
 * Hold a recorded native binding with the real workspace, model and directory owners.
 * @param ctx - Native Host composition providing the owner services.
 * @param agent - Exact registered ordinary Agent to resume.
 * @param binding - Original submission evidence; never inferred from a new workspace.
 * @param signal - Lifetime of the submitting or resuming operation.
 * @returns the held execution context, or undefined when an owner capability is absent.
 */
export async function acquireGenerationSessionBinding(
  ctx: Context, agent: Agent, binding: GenerationSessionBinding, signal: AbortSignal,
): Promise<GenerationExecutionLease | undefined> {
  const authority = ctx.get('generationWorkspaceAuthority')
  const directory = ctx.get('workingDirectory')
  const registry = ctx.get('agents'), sessions = ctx.get('sessions')
  if (authority === undefined || directory === undefined || registry === undefined
    || sessions === undefined || agent.model.guard === undefined) return undefined
  signal.throwIfAborted()
  if (binding.sessionId !== agent.session.id || agent.session.header.origin === 'subagent'
    || registry.get(agent.session.id) !== agent || sessions.get(agent.session.id) !== agent.session) {
    throw new Error('generation binding does not name the live native Session')
  }
  const workspace = await authority.acquire(binding, signal)
  let model: ReturnType<NonNullable<Agent['model']['guard']>> | undefined
  let working: Awaited<ReturnType<typeof directory.guard>> | undefined
  let active: AbortSignal | undefined
  let detachOwner: (() => Promise<void>) | undefined
  const lifetime = new AbortController()
  const release = () => {
    if (lifetime.signal.aborted) return
    active?.removeEventListener('abort', release)
    lifetime.abort(new Error('generation execution binding released'))
    working?.release()
    model?.release()
    workspace.release()
    void Promise.resolve().then(() => detachOwner?.()).catch((error: unknown) => {
      ctx.logger.warn(`generation binding cleanup failed: ${String(error)}`)
    })
  }
  try {
    model = agent.model.guard({ provider: binding.model.provider, model: binding.model.model,
      ...binding.model.reasoningEffort === undefined ? {} : { reasoningEffort: binding.model.reasoningEffort } }, signal)
    working = await directory.guard(agent, binding.workingDirectory, signal)
    active = AbortSignal.any([signal, lifetime.signal, workspace.signal, model.signal, working.signal])
    const effectiveSignal = active
    const heldModel = model
    const assertCurrent = () => {
      effectiveSignal.throwIfAborted()
      if (registry.get(agent.session.id) !== agent || sessions.get(agent.session.id) !== agent.session) throw new Error('generation Session owner changed')
      workspace.assertCurrent()
      heldModel.assertCurrent()
      if (directory.get(agent.session) !== binding.workingDirectory) throw new Error('generation working directory changed')
    }
    active.addEventListener('abort', release, { once: true })
    detachOwner = agent.ctx.effect(() => release, 'generation.executionBinding')
    assertCurrent()
    return { signal: active, assertCurrent, release }
  } catch (error) {
    release()
    throw error
  }
}

/**
 * Capture a new submission's exact registered native Session selection while holding it.
 * @param ctx - Native Host composition providing the owner services.
 * @param agent - Ordinary Agent executing the submission tool body.
 * @param signal - Submission lifetime.
 * @returns new binding and its held context, or undefined without all owner capabilities.
 */
export async function captureGenerationSessionBinding(
  ctx: Context, agent: Agent, signal: AbortSignal,
): Promise<{ binding: GenerationSessionBinding; lease: GenerationExecutionLease } | undefined> {
  const binding = await captureGenerationBinding(ctx, agent, signal)
  if (binding === undefined) return undefined
  const lease = await acquireGenerationSessionBinding(ctx, agent, binding, signal)
  return lease === undefined ? undefined : { binding, lease }
}

async function captureGenerationBinding(ctx: Context, agent: Agent, signal: AbortSignal): Promise<GenerationSessionBinding | undefined> {
  const authority = ctx.get('generationWorkspaceAuthority'), directory = ctx.get('workingDirectory')
  if (authority === undefined || directory === undefined || agent.model.guard === undefined) return undefined
  signal.throwIfAborted()
  const header = agent.session.requestHeader()
  if (header === undefined) return undefined
  const model = { provider: header.config.provider, model: header.config.model,
    ...header.adapterDefaults?.reasoningEffort === true || header.config.reasoningEffort === undefined
      ? {} : { reasoningEffort: header.config.reasoningEffort } }
  const workingDirectory = directory.get(agent.session)
  const identity = await authority.capture(agent.session.id, signal)
  if (identity === undefined) return undefined
  return generationSessionBindingSchema.parse({ ...identity, workingDirectory, model })
}
