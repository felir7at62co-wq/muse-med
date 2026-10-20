/**
 * Same-session goal-round driver over public agent, session, and goal services.
 * @module @deepseek-ai/dsh-goal-round-driver
 */

import { isDeepStrictEqual } from 'node:util'
import { FiberState } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { GoalMessageSource, GoalRef, GoalView, GoalWait, GoalWaitRequest } from '@deepseek-ai/dsh-goal'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobEvent } from '@deepseek-ai/dsh-jobs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageId, MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JobOutputValue } from '@deepseek-ai/dsh-tool-jobs'
import { renderGoalRoundPrompt } from './prompt.ts'

export { renderGoalRoundPrompt } from './prompt.ts'

export const name = 'goal-round-driver'
export const inject = ['agents', 'goals', 'sessions', 'tools']

/** Identity reserved before a goal continuation enters the agent inbox. */
interface RoundIdentity {
  readonly goalId: GoalRef['id']
  readonly revision: number
  readonly round: number
}

/** One queued, claimed, or admitted goal message retained until whole-agent quiescence. */
interface RoundAttempt extends RoundIdentity {
  readonly pollOffsets: Map<string, NonNullable<GoalWaitRequest['job']>>
  completed: boolean
  toolsSeen: boolean
  productiveTool: boolean
  emptyJob?: GoalWaitRequest
  readonly messageId: MessageId
  readonly content: ContentBlock[]
  phase: 'queued' | 'claimed' | 'admitted'
  cancelled: boolean
  stale: boolean
}

/** Serialized process-local scheduling state for one exact Agent lifecycle. */
interface DriverState {
  inputWake: { ref: GoalRef; sequence: number } | undefined
  wakeTimer: ReturnType<typeof setTimeout> | undefined
  wakeSequence: number | undefined
  readonly agent: Agent
  attempt: RoundAttempt | undefined
  competingQueued: boolean
  needsCheckpoint: boolean
  requested: boolean
  run: Promise<void> | undefined
  stopping: boolean
}

/** Whether a source identifies an automatic, positive-numbered goal round. */
function isGoalRoundSource(source: MessageSource): source is GoalMessageSource {
  return source.kind === 'goal' && source.round > 0
}

/** Compare a source to one reserved identity. */
function sameRound(source: GoalMessageSource, round: RoundIdentity): boolean {
  return source.goalId === round.goalId
    && source.revision === round.revision
    && source.round === round.round
}

/** Compare the complete queued record to the driver's reservation. */
function sameQueued(content: readonly ContentBlock[], source: MessageSource, attempt: RoundAttempt): boolean {
  return isGoalRoundSource(source) && sameRound(source, attempt) && isDeepStrictEqual(content, attempt.content)
}

/** Exact current ref for a view. */
function goalRef(goal: GoalView): GoalRef {
  return { id: goal.id, revision: goal.revision }
}

/** Human-readable unexpected values for logs. */
function renderThrown(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** Install automatic same-session continuation and its race fences. */
export function apply(ctx: Context): void {
  const states = new Map<Agent, DriverState>()

  /** Create state for an exact currently live agent. */
  function stateFor(agent: Agent): DriverState {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    const state: DriverState = {
      inputWake: undefined,
      wakeTimer: undefined,
      wakeSequence: undefined,
      agent,
      attempt: undefined,
      competingQueued: false,
      needsCheckpoint: false,
      requested: false,
      run: undefined,
      stopping: false,
    }
    states.set(agent, state)
    return state
  }

  /** Read only when the exact Agent remains live. */
  function currentGoal(state: DriverState): GoalView | undefined {
    if (ctx.agents.get(state.agent.id) !== state.agent) return undefined
    return ctx.goals.get(state.agent)
  }

  /** Whether this exact lifecycle is quiescent with no competing prompt. */
  function readyToDrive(state: DriverState): boolean {
    return ctx.fiber.state === FiberState.ACTIVE
      && !state.stopping
      && ctx.agents.get(state.agent.id) === state.agent
      && state.agent.status === 'idle'
      && !state.competingQueued
  }

  /** Recheck every condition that an awaited checkpoint may have changed. */
  function readyAfterCheckpoint(state: DriverState): boolean {
    return readyToDrive(state) && !state.needsCheckpoint
  }

  /** Remove automatic authority while preserving the durable phase. */
  function disarm(state: DriverState): void {
    clearWake(state)
    try {
      const goal = currentGoal(state)
      if (goal?.activation === 'armed') ctx.goals.disarm(state.agent)
    } catch (error: unknown) {
      ctx.logger.warn(`goal-round-driver: could not disarm agent "${state.agent.id}": ${renderThrown(error)}`)
    }
  }

  /** Release an obsolete timer before replacing a wait or retiring its agent. */
  function clearWake(state: DriverState): void {
    if (state.wakeTimer !== undefined) clearTimeout(state.wakeTimer)
    state.wakeTimer = undefined
    state.wakeSequence = undefined
  }

  /** Observe committed job state without consuming its model output cursor. */
  function jobReady(state: DriverState, wait: GoalWait): boolean {
    const condition = wait.job
    const jobs = ctx.get('jobs')
    if (condition === undefined || jobs === undefined) return false
    try {
      const job = jobs.get(condition.id, state.agent.id)
      return job.output.total > condition.outputOffset || (job.status !== 'running' && job.status !== 'stopping')
    } catch (error) {
      // A process-local job can disappear after restart; the durable wait still yields to input or its timer.
      ctx.logger.debug(`goal-round-driver: waiting job is unavailable: ${renderThrown(error)}`)
      return false
    }
  }

  /** Install one revision-fenced timer, or release a condition already satisfied. */
  function watchWait(state: DriverState, goal: GoalView, wait: GoalWait): void {
    if (jobReady(state, wait) || (wait.wakeAt !== undefined && wait.wakeAt <= Date.now())) {
      clearWake(state)
      ctx.goals.wake(state.agent, goalRef(goal), wait.sequence)
      return
    }
    if (state.wakeSequence !== wait.sequence) clearWake(state)
    state.wakeSequence = wait.sequence
    if (wait.wakeAt === undefined || state.wakeTimer !== undefined) return
    // Node timers accept at most a signed 32-bit delay; longer waits recheck the same deadline.
    const delay = Math.min(wait.wakeAt - Date.now(), 2_147_483_647)
    state.wakeTimer = setTimeout(() => {
      state.wakeTimer = undefined
      if (state.stopping) return
      const current = currentGoal(state)
      if (current?.phase !== 'active' || current.activation !== 'armed'
        || current.wait?.sequence !== wait.sequence) return
      watchWait(state, current, current.wait)
      requestDrive(state)
    }, delay)
    state.wakeTimer.unref()
  }

  /** Preserve claimed step context when this driver drops only its own round. */
  function restoreOtherClaimed(agent: Agent, messages: UserMessage[], messageId: MessageId): void {
    const retained = messages.filter(message => message.id !== messageId
      && !(message.source.kind === 'goal' && message.source.round === 0))
    for (const message of retained.toReversed()) {
      if (agent.inbox.nextStep.some(candidate => candidate.id === message.id)
        || agent.inbox.nextTurn.some(candidate => candidate.id === message.id)) continue
      agent.inbox.prepend('next-step', message)
    }
  }

  /** Process admitted work at quiescence, then reserve at most one next round. */
  async function drive(state: DriverState): Promise<void> {
    const { agent } = state
    if (!readyToDrive(state)) return

    if (state.needsCheckpoint) {
      state.needsCheckpoint = false
      try {
        await ctx.sessions.flush(agent.session)
      } catch (error: unknown) {
        ctx.logger.warn(`goal-round-driver: durability checkpoint failed for agent "${agent.id}": ${renderThrown(error)}`)
        disarm(state)
        return
      }
      // A mutation or ordinary prompt may have arrived while the checkpoint
      // was settling. Give it its own checkpoint / turn before reserving.
      if (!readyAfterCheckpoint(state)) return
    }

    const attempt = state.attempt
    if (state.inputWake !== undefined) {
      const wake = state.inputWake
      state.inputWake = undefined
      ctx.goals.wake(agent, wake.ref, wake.sequence)
      state.requested = true
      return
    }
    if (attempt !== undefined) {
      state.attempt = undefined
      const goal = currentGoal(state)
      if (attempt.completed && goal?.phase === 'active' && goal.activation === 'armed'
        && goal.id === attempt.goalId && goal.revision === attempt.revision && goal.wait === undefined
        && goal.roundsStarted < goal.maxGoalRounds) {
        if (attempt.emptyJob !== undefined && !attempt.productiveTool) ctx.goals.wait(agent, goalRef(goal), attempt.emptyJob)
        else if (!attempt.toolsSeen) ctx.goals.wait(agent, goalRef(goal), {
          reason: 'no-tools', message: 'The last automatic round made no tool calls. Waiting for user input or resume.',
        })
      }
      state.needsCheckpoint = true
      state.requested = true
      return
    }

    const goal = currentGoal(state)
    if (goal === undefined || goal.phase !== 'active' || goal.activation !== 'armed') return
    if (goal.roundsStarted >= goal.maxGoalRounds) {
      ctx.goals.block(agent, goalRef(goal), {
        code: 'round-limit',
        message: `Goal reached its configured limit of ${goal.maxGoalRounds} rounds.`,
      })
      return
    }
    if (goal.wait !== undefined) { watchWait(state, goal, goal.wait); return }
    clearWake(state)

    const round = goal.roundsStarted + 1
    const content = renderGoalRoundPrompt(goal, round)
    const message = createUserMessage({
      content,
      source: { kind: 'goal', goalId: goal.id, revision: goal.revision, round },
    })
    const reservation: RoundAttempt = {
      completed: false,
      pollOffsets: new Map(),
      toolsSeen: false,
      productiveTool: false,
      goalId: goal.id,
      revision: goal.revision,
      round,
      messageId: message.id,
      content,
      phase: 'queued',
      cancelled: false,
      stale: false,
    }
    state.attempt = reservation
    try {
      agent.followup(message)
    } catch (error: unknown) {
      state.attempt = undefined
      ctx.logger.warn(`goal-round-driver: could not queue round ${round} for agent "${agent.id}": ${renderThrown(error)}`)
      const latest = currentGoal(state)
      if (latest !== undefined && latest.id === goal.id && latest.revision === goal.revision
        && latest.phase === 'active' && latest.activation === 'armed') {
        ctx.goals.block(agent, goalRef(latest), {
          code: 'queue-failed',
          message: `Could not queue goal round ${round}: ${renderThrown(error)}`,
        })
      }
    }
  }

  /** Coalesce triggers onto one agent-local serialized driver. */
  function requestDrive(state: DriverState): void {
    /* v8 ignore next -- teardown may race a final trigger after synchronously closing the step fence */
    if (state.stopping) return
    state.requested = true
    if (state.run !== undefined) return
    let run: Promise<void>
    try {
      run = ctx.agents.withoutInitiator(async () => {
        while (state.requested && !state.stopping) {
          state.requested = false
          try {
            await drive(state)
          } catch (error: unknown) {
            ctx.logger.warn(`goal-round-driver: driver failed for agent "${state.agent.id}": ${renderThrown(error)}`)
            disarm(state)
          }
        }
      })
    } catch (error: unknown) {
      ctx.logger.warn(`goal-round-driver: could not start driver for agent "${state.agent.id}": ${renderThrown(error)}`)
      disarm(state)
      return
    }
    state.run = run
    const retire = (): void => {
      state.run = undefined
      if (state.requested && !state.stopping) requestDrive(state)
    }
    void run.then(retire, (error: unknown) => {
      ctx.logger.warn(`goal-round-driver: driver task rejected for agent "${state.agent.id}": ${renderThrown(error)}`)
      disarm(state)
      retire()
    })
  }

  // One composite effect keeps the step fence installed until this
  // plugin's own scheduling tasks settle.
  ctx.effect(function* () {
    ctx.on('tools/pre-execute', async (execution: ToolExecution, next) => {
      const state = execution.agent === undefined ? undefined : states.get(execution.agent)
      const attempt = state?.attempt
      const args = execution.arguments
      const jobs = ctx.get('jobs')
      if (execution.name === 'job_output' && state !== undefined && attempt?.phase === 'admitted'
        && jobs !== undefined && typeof args === 'object' && args !== null && 'job_id' in args
        && typeof args.job_id === 'string') {
        try {
          const job = jobs.get(JobId(args.job_id), state.agent.id)
          attempt.pollOffsets.set(execution.callId, { id: job.id, outputOffset: job.output.total })
        } catch (error) {
          // The job tool owns authorization and missing-job errors; observation must not replace them.
          ctx.logger.debug(`goal-round-driver: cannot observe job poll: ${renderThrown(error)}`)
        }
      }
      return next()
    })
    ctx.on('tools/post-execute', async (execution, result, next) => {
      const downstream = await next()
      const state = execution.agent === undefined ? undefined : states.get(execution.agent)
      const attempt = state?.attempt
      if (state === undefined || attempt?.phase !== 'admitted' || downstream.kind === 'block') return downstream
      if (execution.name === 'job_output' && !result.isError) {
        // The job tool validates this canonical value before post-execute policies run.
        const value = result.value as JobOutputValue
        const observed = attempt.pollOffsets.get(execution.callId)
        if (value.text === '' && (value.job.status === 'running' || value.job.status === 'stopping')
          && observed !== undefined) {
          attempt.emptyJob = {
            reason: 'job', message: 'Waiting for new background job output or completion.',
            job: observed,
          }
        } else attempt.productiveTool = true
      } else if (execution.name !== 'run_code') attempt.productiveTool = true
      return downstream
    })
    ctx.inject(['jobs'], (child) => {
      child.effect(() => child.jobs.events.subscribe({ owners: 'scope' }, (event: JobEvent) => {
        const id = event.type === 'output' ? event.id : event.job.id
        for (const state of states.values()) {
          const goal = currentGoal(state)
          if (goal?.phase === 'active' && goal.activation === 'armed' && goal.wait?.job?.id === id) {
            watchWait(state, goal, goal.wait)
          }
        }
      }))
    })
    ctx.on('agent/error', ({ agent }) => {
      const state = stateFor(agent)
      disarm(state)
    })

    ctx.on('agent/disposed', ({ agent }) => {
      const state = states.get(agent)
      if (state !== undefined) clearWake(state)
      states.delete(agent)
    })
    ctx.on('agent/created', ({ agent }) => {
      const state = stateFor(agent)
      state.attempt = undefined
      state.competingQueued = false
      state.needsCheckpoint = false
    })
    ctx.on('agent/status', ({ agent, status }) => {
      const state = stateFor(agent)
      if (status === 'idle') {
        state.competingQueued = false
        const attempt = state.attempt
        const goal = currentGoal(state)
        // Fence the pause to the exact dropped attempt's ref. A resume bumps
        // the revision, so a host pause followed by an immediate resume (before
        // the aborted turn converges to idle) must not re-pause the resumed goal.
        const pause = attempt !== undefined
          && (attempt.phase === 'queued' || attempt.phase === 'claimed' || attempt.cancelled)
          && goal !== undefined && goal.phase === 'active' && goal.activation === 'armed'
          && attempt.goalId === goal.id && attempt.revision === goal.revision
        // A reservation still queued when the agent reaches idle cannot run:
        // withdraw it so human input queued behind it is not stranded.
        if (pause || attempt?.phase === 'queued') {
          state.attempt = undefined
          try {
            if (attempt.phase === 'queued') agent.inbox.remove(attempt.messageId)
            if (pause) ctx.goals.pause(agent, goalRef(goal))
          } catch (error: unknown) {
            ctx.logger.warn(`goal-round-driver: could not settle cancelled goal round for agent "${agent.id}": ${renderThrown(error)}`)
            disarm(state)
          }
        }
        requestDrive(state)
      }
    })
    ctx.on('goal/changed', ({ agent, change }) => {
      const state = stateFor(agent)
      clearWake(state)
      state.needsCheckpoint = true
      // A host-initiated pause stops goal execution: abort the live turn so the
      // model cannot keep acting or resume in the same turn. A model-initiated
      // pause (update_goal inside its own turn) finishes normally.
      if (change.operation === 'pause' && agent.status === 'running'
        && ctx.agents.currentInitiator() !== agent) {
        agent.cancel({ kind: 'user' }, { keepInbox: true })
      }
      requestDrive(state)
    })
    ctx.on('goal/wait-changed', ({ agent }) => {
      const state = stateFor(agent)
      clearWake(state)
      state.needsCheckpoint = true
      requestDrive(state)
    })

    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (!agent.inbox.nextTurn.some(candidate => candidate.id === message.id)) return
      const state = stateFor(agent)
      const attempt = state.attempt
      if (attempt !== undefined && sameQueued(message.content, message.source, attempt)) return
      state.competingQueued = true
      if (attempt?.phase === 'queued') attempt.stale = true
    })
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      const state = stateFor(agent)
      const attempt = state.attempt
      if (attempt !== undefined && sameQueued(message.content, message.source, attempt)) {
        attempt.phase = 'claimed'
      }
    })
    ctx.on('agent/inbox/discarded', ({ agent, message }) => {
      const state = stateFor(agent)
      const attempt = state.attempt
      if (attempt !== undefined && sameQueued(message.content, message.source, attempt)) {
        attempt.cancelled = true
      }
    })

    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      const agent = ctx.agents.get(session.id)
      if (agent === undefined || agent.session !== session) return
      const state = stateFor(agent)
      switch (event.type) {
        case 'user/message':
          if (state.attempt !== undefined && event.data.id === state.attempt.messageId) {
            state.attempt.phase = 'admitted'
          }
          if (event.data.source.kind === 'user') {
            const goal = currentGoal(state)
            if (goal?.phase === 'active' && goal.activation === 'armed' && goal.wait !== undefined) {
              state.inputWake = { ref: goalRef(goal), sequence: goal.wait.sequence }
            }
          }
          return
        case 'tool/call':
          if (state.attempt?.phase === 'admitted') state.attempt.toolsSeen = true
          return
        case 'turn/end':
          if (event.data.reason.kind === 'max-tokens') {
            disarm(state)
            return
          }
          if (event.data.reason.kind === 'completed') {
            if (state.attempt?.phase === 'admitted') state.attempt.completed = true
            return
          }
          if (event.data.reason.kind !== 'aborted') return
          if (state.attempt?.phase === 'claimed' || state.attempt?.phase === 'admitted') {
            state.attempt.cancelled = true
          }
          else disarm(state)
          return
        default:
          return
      }
    })

    /** Fail closed unless the queued prompt still owns the exact live revision. */
    function validReservation(
      state: DriverState,
      content: readonly ContentBlock[],
      source: GoalMessageSource,
    ): boolean {
      const attempt = state.attempt
      const goal = currentGoal(state)
      return ctx.fiber.state === FiberState.ACTIVE
        && !state.stopping && attempt !== undefined && attempt.phase === 'claimed'
      && !attempt.stale && sameQueued(content, source, attempt)
      && goal !== undefined && goal.id === source.goalId && goal.revision === source.revision
      && goal.phase === 'active' && goal.activation === 'armed'
      && goal.wait === undefined
      && source.round === goal.roundsStarted + 1
    }

    ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
      const submitted = messages.find((message): message is UserMessage & { source: GoalMessageSource } =>
        isGoalRoundSource(message.source))
      if (submitted === undefined) return next()
      const { content, source } = submitted
      const state = stateFor(agent)
      let valid = false
      try {
        valid = validReservation(state, content, source)
      } catch (error: unknown) {
        ctx.logger.warn(`goal-round-driver: pre-step check failed for agent "${agent.id}": ${renderThrown(error)}`)
        disarm(state)
      }
      if (!valid) {
        const attempt = state.attempt
        if (attempt !== undefined && sameRound(source, attempt)) {
          attempt.stale = true
          state.attempt = undefined
        }
        restoreOtherClaimed(agent, messages, submitted.id)
        requestDrive(state)
        return { kind: 'reject' }
      }
      let decision: PreStepDecision
      try {
        decision = await next()
      } catch (error: unknown) {
        if (signal.aborted) throw error
        // A throwing downstream hook drops the whole step proposal. Clear the
        // reservation before the balanced no-step turn returns to idle so the
        // next drive pass can reschedule the round.
        state.attempt = undefined
        requestDrive(state)
        throw error
      }
      if (signal.aborted) {
        if (decision.kind === 'enter') restoreOtherClaimed(agent, decision.messages, submitted.id)
        return decision
      }
      if (decision.kind === 'reject') {
        state.attempt = undefined
        const goal = currentGoal(state)
        if (goal !== undefined && goal.id === source.goalId && goal.revision === source.revision
          && goal.phase === 'active' && goal.activation === 'armed') {
          ctx.goals.block(agent, goalRef(goal), {
            code: 'prompt-rejected',
            message: 'Goal round was rejected before entering its step.',
          })
        }
        return decision
      }
      try {
        valid = validReservation(state, content, source)
      } catch (error: unknown) {
        ctx.logger.warn(`goal-round-driver: post-decision check failed for agent "${agent.id}": ${renderThrown(error)}`)
        disarm(state)
        valid = false
      }
      if (!valid) {
        state.attempt = undefined
        restoreOtherClaimed(agent, decision.messages, submitted.id)
        requestDrive(state)
        return { kind: 'reject' }
      }
      return { ...decision, startsRequestSeries: true }
    })

    // Loading a lifecycle driver over existing agents never inherits hidden
    // automatic authority from an earlier producer instance.
    for (const agent of ctx.agents.list()) {
      const state = stateFor(agent)
      disarm(state)
    }

    // Yielded after listener registration, so this close runs first and the
    // composite effect removes listeners only after its promise settles.
    yield async () => {
      const waits: Promise<void>[] = []
      for (const state of states.values()) {
        state.stopping = true
        disarm(state)
        const attempt = state.attempt
        if (attempt !== undefined) {
          attempt.stale = true
          /* v8 ignore next -- followup reserves the live agent before publishing a queued attempt */
          if (state.agent.status === 'running') {
            state.agent.cancel({ kind: 'parent' })
            waits.push(state.agent.whenIdle())
          }
        }
        if (state.run !== undefined) waits.push(state.run)
      }
      await Promise.allSettled(waits)
      states.clear()
    }
  }, 'goal-round-driver lifecycle')
}
