/**
 * Session working directories, durable changes, and model context.
 * @module @deepseek-ai/dsh-working-directory
 */

import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workingDirectory: WorkingDirectoryService
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Committed working-directory transition notices.
     * @persistenceAttribution
     */
    'working-directory': { kind: 'working-directory' }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Effective working directory; the immutable Session header retains the original project. */
    'working-directory/change': {
      /** Absolute directory used by subsequent directory-based operations. */
      cwd: string
    }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Recorded current directory for Session observations, or null when none is recorded. */
    workingDirectory: string | null
  }
}

/** Deployment default for Sessions without an original project directory. */
export interface Config {
  /** Absolute execution-world fallback directory; omitted values use the launch directory. */
  defaultDirectory?: string
}

/** Same-process guard for a Session's effective directory; it grants no filesystem or workspace access. */
export interface WorkingDirectoryGuard {
  /** Directory selected when the guard was acquired. */
  readonly directory: string
  /** Aborts on release, owner cancellation, Session change, or service disposal. */
  readonly signal: AbortSignal
  /** Release this guard and abort its signal. */
  release(): void
}

interface ActiveDirectoryGuard {
  readonly agent: Agent
  readonly directory: string
  release(): void
}

/** One owner for each Session's effective directory and its model-visible changes. */
export class WorkingDirectoryService extends Service {
  static inject = ['fs', 'sessionProjections', 'systemPrompt']

  static Config: z<Config> = z.object({
    defaultDirectory: z.string(),
  })

  /** Absolute deployment fallback for Sessions with no recorded original directory. */
  readonly defaultDirectory: string
  private readonly pending = new WeakMap<Session, Promise<void>>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly lifecycle = new AbortController()
  private readonly guards = new Map<Session, ActiveDirectoryGuard>()

  private workingDirectoryProjectionHandle!: ProjectionHandle<string | null>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'workingDirectory')
    const directory = config.defaultDirectory ?? process.cwd()
    if (!isAbsolute(directory)) throw new Error('working-directory: defaultDirectory must be absolute')
    this.defaultDirectory = directory
  }

  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    const directorySchema = zod.string().min(1).refine(isAbsolute).nullable()
    this.workingDirectoryProjectionHandle = await ctx.sessionProjections.register({
      key: 'workingDirectory',
      stateVersion: 1,
      stateSchema: directorySchema,
      init: header => header.cwd ?? null,
      apply: (state, event) => event.type === 'working-directory/change' ? event.data.cwd : state,
      wire: { viewSchema: directorySchema, view: state => state },
    })
    ctx.systemPrompt.context({
      name: 'working-directory:current',
      order: ctx.systemPrompt.getContextOrder('WORKING_DIRECTORY'),
      required: true,
      interpolate: false,
      text: context => context.agent === undefined ? '' : this.contextText(context.agent.session),
    })
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      if (context.agent === undefined) return next()
      await this.ensure(context.agent, context.signal)
      const assembly = await next()
      this.lifecycle.signal.throwIfAborted()
      const text = this.contextText(context.agent.session)
      const contribution = assembly.contexts.find(entry => entry.name === 'working-directory:current')
      if (contribution === undefined) assembly.contexts.unshift({ name: 'working-directory:current', text, interpolate: false })
      else {
        contribution.text = text
        contribution.interpolate = false
      }
      return assembly
    }, { prepend: true })
    ctx.on('session/event', (session, event) => {
      const guard = this.guards.get(session)
      if (guard !== undefined && event.type === 'working-directory/change' && event.data.cwd !== guard.directory) guard.release()
    })
    ctx.on('session/disposed', (session) => { this.guards.get(session)?.release() })
    ctx.on('agent/disposed', ({ agent }) => {
      const guard = this.guards.get(agent.session)
      if (guard?.agent === agent) guard.release()
    })
    ctx.effect(() => async () => {
      for (const guard of this.guards.values()) guard.release()
      this.lifecycle.abort(new Error('working-directory service disposed'))
      await Promise.allSettled(this.operations)
    })
  }

  /**
   * Read the committed directory without filesystem I/O.
   * @param session - Session whose directory is requested.
   * @returns its effective absolute directory.
   */
  get(session: Session): string {
    return this.workingDirectoryProjectionHandle.stateOf(session) ?? this.defaultDirectory
  }

  /**
   * Validate the current directory and restore the original project when it disappeared.
   * @param agent - live or unpublished Agent owning the Session.
   * @param signal - cancellation for filesystem inspection.
   * @returns the existing directory; recovery is committed before fulfillment.
   * A notice failure is warned without reverting the committed state.
   * @throws when the original project is also unavailable.
   */
  ensure(agent: Agent, signal?: AbortSignal): Promise<string> {
    return this.serialize(agent, signal, async (control) => {
      const current = this.get(agent.session)
      const guard = this.guards.get(agent.session)
      if (guard !== undefined && guard.directory !== current) { guard.release(); throw new Error('working-directory: guarded directory changed') }
      const target = await this.ctx.fs.resolve(current, { signal: control })
      const info = await this.ctx.fs.stat(target, control)
      control.throwIfAborted()
      agent.ctx.fiber.assertActive()
      if (guard !== undefined && (this.guards.get(agent.session) !== guard || this.get(agent.session) !== current)) {
        guard.release(); throw new Error('working-directory: guarded directory changed')
      }
      if (info?.type === 'directory') {
        if (this.workingDirectoryProjectionHandle.stateOf(agent.session) === null) {
          agent.session.append('working-directory/change', { cwd: current })
        }
        return current
      }
      if (guard !== undefined) { guard.release(); throw new Error('working-directory: guarded directory unavailable') }
      const original = agent.session.header.cwd ?? this.defaultDirectory
      const restored = await this.directory(original, original, control)
      this.commit(agent, restored, true, control)
      return restored
    })
  }

  /**
   * Change one Session's directory without changing existing processes or permissions.
   * @param agent - live or unpublished Agent owning the Session.
   * @param path - absolute path or a path relative to its current directory.
   * @param signal - cancellation before the durable change.
   * @returns the canonical absolute directory, committed before fulfillment.
   * A notice failure is warned; the next request still receives the committed directory.
   * @throws when the requested path is not an existing directory.
   */
  set(agent: Agent, path: string, signal?: AbortSignal): Promise<string> {
    return this.serialize(agent, signal, async (control) => {
      if (this.guards.has(agent.session)) throw new Error('working-directory: guarded directory cannot change')
      if (path.length === 0) throw new Error('working-directory: cd must not be empty')
      const directory = await this.directory(path, this.get(agent.session), control)
      this.commit(agent, directory, false, control)
      return directory
    })
  }

  /**
   * Hold a same-process directory choice until cancellation or release.
   * This guard does not authenticate the Agent, freeze the model, protect workspace membership,
   * lock the filesystem or serialize other processes. Consumers must provide those separately.
   * @param agent - Existing Agent whose effective directory must remain selected.
   * @param expected - Exact effective directory previously selected by the owner.
   * @param signal - Owner lifetime; cancellation rejects a queued acquisition or releases a held guard.
   * @returns The directory and cancellation signal while the guard is held.
   */
  guard(agent: Agent, expected: string, signal: AbortSignal): Promise<WorkingDirectoryGuard> {
    const operation = this.serialize(agent, signal, async (control) => {
      if (this.guards.has(agent.session)) throw new Error('working-directory: guarded directory already held')
      const current = this.get(agent.session)
      if (current !== expected || this.workingDirectoryProjectionHandle.stateOf(agent.session) === null) {
        throw new Error('working-directory: guarded directory does not match')
      }
      const target = await this.ctx.fs.resolve(current, { signal: control })
      const info = await this.ctx.fs.stat(target, control)
      control.throwIfAborted()
      agent.ctx.fiber.assertActive()
      if (info?.type !== 'directory' || this.get(agent.session) !== current) {
        throw new Error('working-directory: guarded directory unavailable or changed')
      }
      const controller = new AbortController()
      let released = false
      const release = () => {
        if (released) return
        released = true
        signal.removeEventListener('abort', release)
        this.guards.delete(agent.session)
        controller.abort(new Error('working-directory: guard released'))
        void detachOwner()
      }
      const state: ActiveDirectoryGuard = { agent, directory: current, release }
      const detachOwner = agent.ctx.effect(() => release, 'working-directory.guard')
      this.guards.set(agent.session, state)
      signal.addEventListener('abort', release, { once: true })
      return { directory: current, signal: controller.signal, release }
    })
    const lifetime = AbortSignal.any([signal, this.lifecycle.signal])
    return new Promise((resolve, reject) => {
      const cancelled = () => {
        lifetime.removeEventListener('abort', cancelled)
        reject(lifetime.reason instanceof Error ? lifetime.reason : new Error('working-directory: guard cancelled', { cause: lifetime.reason }))
      }
      lifetime.addEventListener('abort', cancelled, { once: true })
      void operation.then((guard) => {
        lifetime.removeEventListener('abort', cancelled)
        resolve(guard)
      }, (error: unknown) => {
        lifetime.removeEventListener('abort', cancelled)
        reject(error instanceof Error ? error : new Error('working-directory: guard failed', { cause: error }))
      })
      if (lifetime.aborted) cancelled()
    })
  }

  private contextText(session: Session): string {
    return `Current working directory: ${JSON.stringify(this.get(session))}.`
  }

  private async directory(path: string, cwd: string, signal: AbortSignal): Promise<string> {
    const target = await this.ctx.fs.resolve(path, { cwd, signal })
    const info = await this.ctx.fs.stat(target, signal)
    signal.throwIfAborted()
    if (info?.type !== 'directory') {
      throw new Error(`working-directory: directory does not exist: ${JSON.stringify(path)}`)
    }
    return this.ctx.fs.processPath(target)
  }

  private commit(agent: Agent, directory: string, recovered: boolean, signal: AbortSignal): void {
    signal.throwIfAborted()
    agent.ctx.fiber.assertActive()
    const previous = this.get(agent.session)
    if (previous === directory) return
    agent.session.append('working-directory/change', { cwd: directory })
    const notice = createUserMessage({
      content: [{
        type: 'text',
        text: recovered
          ? `The working directory ${JSON.stringify(previous)} is unavailable. The working directory is now ${JSON.stringify(directory)}.`
          : `The working directory changed from ${JSON.stringify(previous)} to ${JSON.stringify(directory)}.`,
      }],
      source: { kind: 'working-directory' },
    })
    try {
      agent.inject(notice)
    } catch (error) {
      this.ctx.logger.warn(`working-directory: committed ${JSON.stringify(directory)}, but could not queue its notice: ${String(error)}`)
    }
  }

  private serialize<T>(agent: Agent, signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const session = agent.session
    const control = signal === undefined
      ? this.lifecycle.signal
      : AbortSignal.any([this.lifecycle.signal, signal])
    const operation = (this.pending.get(session) ?? Promise.resolve()).then(() => {
      control.throwIfAborted()
      agent.ctx.fiber.assertActive()
      return action(control)
    })
    const settled = operation.finally(() => this.operations.delete(settled))
    this.operations.add(settled)
    this.pending.set(session, settled.then(() => {}, () => {}))
    return settled
  }
}

export default WorkingDirectoryService
