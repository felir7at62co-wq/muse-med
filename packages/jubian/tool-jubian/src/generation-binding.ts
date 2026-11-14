/** Original native Session and workspace ownership for generation completion.
 * @module @deepseek-ai/dsh-tool-jubian/generation-binding
 */
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-working-directory'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'

/** Persisted authority and exact workspace membership observed at submission. */
export const generationWorkspaceIdentitySchema = z.object({
  version: z.literal(1),
  authorityId: z.uuid().brand<'GenerationAuthorityId'>(),
  workspaceId: z.string().min(1).transform(WorkspaceId),
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
    reasoningEffort: z.string().min(1).transform(ReasoningEffortId).optional(),
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
    void detachOwner?.()
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
  const binding = generationSessionBindingSchema.parse({ ...identity, workingDirectory, model })
  const lease = await acquireGenerationSessionBinding(ctx, agent, binding, signal)
  return lease === undefined ? undefined : { binding, lease }
}
