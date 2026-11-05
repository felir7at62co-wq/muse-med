/** Bounded completed-turn collection and one-at-a-time autonomous Skill reviews. */
import { Service } from '@deepseek-ai/cordis'
import { createHash, randomUUID } from 'node:crypto'
import { reviewCompletedTurn, scrubEvidence } from './reviewer.js'
import { assertSkillWriteAllowed } from './permissions.js'

const visibleText = message => (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
const reviewId = id => typeof id === 'string' && id.startsWith('muse-skill-review-')

/**
 * Keep the newest evidence, including late user corrections, within the configured aggregate budget.
 * @param {object} turn - Process-local collector for one source turn.
 * @param {string} line - Visible task evidence or a tool-name outcome summary.
 * @param {number} maximum - Maximum stored character count.
 */
function keepLine(turn, line, maximum) {
  const text = scrubEvidence(line).slice(-maximum)
  turn.lines.push(text)
  turn.chars += text.length
  while (turn.chars > maximum && turn.lines.length > 1) turn.chars -= turn.lines.shift().length
}

/** One Host-owned queue; the service exposes observable quiescence for lifecycle consumers. */
export class EvolutionRuntime extends Service {
  constructor(ctx, { config, store }) {
    super(ctx, 'museSkillEvolution')
    this.config = config
    this.store = store
    this.turns = new Map()
    this.pending = new Map()
    this.controller = new AbortController()
    this.running = undefined
    this.writes = Promise.resolve()
    this.timer = undefined
    this.timerDone = undefined
    this.lastActivity = Date.now()
    this.closed = false
    if (config.enabled) {
      ctx.on('session/event', (session, event) => { this.collect(session, event) })
      ctx.on('agent/status', ({ agent }) => {
        if (!this.normal(agent.session)) return
        this.lastActivity = Date.now()
        if (agent.status !== 'idle') this.activeReview?.abort()
        this.arm()
      })
    }
  }

  /**
   * Restore only already-collected pending batches; existing Session logs are never scanned.
   * @returns {Promise<void>} Completion after persisted queue metadata is checked.
   */
  async start() {
    for (const run of await this.store.runs()) {
      if (run.state === 'queued' && Array.isArray(run.lines) && run.route && run.source) this.pending.set(run.id, run)
      else if (run.state === 'running') await this.store.recordRun({ ...run, state: 'failed', error: 'A previous review was interrupted; no automatic retry was made.' })
    }
    this.arm()
  }

  normal(session) {
    return session.header.origin !== 'subagent' && (session.header.delegationDepth ?? 0) === 0 && !reviewId(session.id)
  }

  idle() {
    return this.ctx.agents.list().every(agent => !this.normal(agent.session) || agent.status === 'idle')
  }

  collect(session, event) {
    if (this.closed || !this.normal(session)) return
    if (event.type === 'turn/start') {
      this.lastActivity = Date.now()
      this.turns.set(session.id, { turn: event.data.turn, fromSeq: event.seq, lines: [], chars: 0, userLines: [], userChars: 0,
        toolIds: new Set(), toolCalls: 0, successfulTools: 0, human: false })
      return
    }
    const turn = this.turns.get(session.id)
    if (turn === undefined) return
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      turn.human = true
      const text = `User: ${scrubEvidence(visibleText(event.data)).slice(-Math.floor(this.config.inputMaxChars / 2))}`
      turn.userLines.push(text)
      turn.userChars += text.length
      while (turn.userChars > this.config.inputMaxChars / 2 && turn.userLines.length > 1) turn.userChars -= turn.userLines.shift().length
      keepLine(turn, text, this.config.inputMaxChars)
    } else if (event.type === 'assistant/message') {
      keepLine(turn, `Assistant: ${visibleText(event.data.message)}`, this.config.inputMaxChars)
    } else if (event.type === 'tool/call' && !['muse_skill_evolution', 'muse_feedback_submit', 'muse_feedback_status', 'show_view'].includes(event.data.name)) {
      turn.toolCalls += 1
      turn.toolIds.add(event.data.callId)
      keepLine(turn, `Tool: ${event.data.name}`, this.config.inputMaxChars)
    } else if (event.type === 'tool/result' && turn.toolIds.has(event.data.message.source.callId)) {
      if (event.data.message.isError !== true) turn.successfulTools += 1
      keepLine(turn, `Tool result: ${event.data.message.isError === true ? 'failed' : 'completed'}`, this.config.inputMaxChars)
    } else if (event.type === 'turn/end') {
      this.turns.delete(session.id)
      if (event.data.reason.kind !== 'completed' || !turn.human || turn.toolCalls < this.config.minToolCalls || turn.successfulTools === 0) return
      const agent = this.ctx.agents.get(session.id)
      const selected = session.requestHeader()?.config ?? agent?.model.current()
      if (!selected?.provider || !selected.model) return
      const id = createHash('sha256').update(`${session.id}:${turn.turn}:${event.seq}`).digest('hex')
      const job = { id, state: 'queued', source: { sessionId: session.id, turn: turn.turn, fromSeq: turn.fromSeq, throughSeq: event.seq,
        ...(session.header.cwd === undefined ? {} : { cwd: session.header.cwd }) },
      lines: [...new Set([...turn.userLines, ...turn.lines])], route: { provider: selected.provider, model: selected.model,
        ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }) },
      writeAllowed: this.ctx.sandboxPolicy.resolve({ session }).mode !== 'read-only', queuedAt: Date.now() }
      this.writes = this.writes.then(async () => {
        if (this.closed) return
        await this.store.recordRun(job)
        this.pending.set(job.id, job)
        this.arm()
      }).catch(() => { this.ctx.logger.warn('Skill learning could not save completed work; no review was started.') })
    }
  }

  arm() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
      this.releaseTimer?.()
      this.timerDone = undefined
    }
    if (this.closed || !this.config.enabled || this.running !== undefined || this.pending.size === 0 || !this.idle()) return
    this.timerDone = new Promise(resolve => { this.releaseTimer = resolve })
    const delay = Math.max(0, this.config.idleMs - (Date.now() - this.lastActivity))
    this.timer = setTimeout(() => {
      this.timer = undefined
      const release = this.releaseTimer
      this.timerDone = undefined
      this.releaseTimer = undefined
      this.running = this.run().catch(() => { this.ctx.logger.warn('Skill learning stopped before its outcome could be recorded.') })
        .finally(() => { this.running = undefined })
      release()
    }, delay)
    this.timer.unref?.()
  }

  async catalog(job) {
    const own = (await this.store.catalog()).filter(skill => skill.owned === true)
    const byName = new Map(own.map(skill => [skill.name, skill]))
    const sourceAgent = this.ctx.agents.get(job.source.sessionId)
    const lookup = { cwd: job.source.cwd, signal: this.controller.signal, ...(sourceAgent === undefined ? {} : { scope: sourceAgent }) }
    const catalog = await this.ctx.skills.snapshot(lookup)
    if (!catalog.complete) throw new Error('Skill discovery was incomplete; no review was started')
    let bodyChars = own.reduce((size, skill) => size + skill.content.length, 0)
    for (const skill of catalog.skills) {
      if (byName.has(skill.name)) continue
      const row = { name: skill.name, description: skill.description, owned: false, path: skill.path }
      if (bodyChars < this.config.inputMaxChars) {
        const definition = await this.ctx.skills.get(skill.name, lookup)
        if (definition !== undefined && definition.content.trim().length > 0 && definition.content.length <= this.config.contentMaxChars) {
          row.content = definition.content
          row.currentHash = createHash('sha256').update(`${definition.description}\n${definition.content}`).digest('hex')
          bodyChars += definition.content.length
        }
      }
      byName.set(skill.name, row)
    }
    return [...byName.values()]
  }

  async run() {
    if (this.closed || !this.idle()) return
    for (const [id, queued] of this.pending) {
      if (this.closed || !this.idle()) break
      const day = new Date().toISOString().slice(0, 10)
      const used = (await this.store.runs()).filter(run => typeof run.startedAt === 'number' && new Date(run.startedAt).toISOString().slice(0, 10) === day).length
      if (used >= this.config.maxReviewsPerDay) break
      let job = queued
      const review = new AbortController()
      const reviewSignal = AbortSignal.any([this.controller.signal, review.signal])
      this.activeReview = review
      try {
        const catalog = await this.catalog(job)
        this.controller.signal.throwIfAborted()
        if (!this.idle()) break
        job = { ...job, state: 'running', reviewSessionId: `muse-skill-review-${randomUUID()}`, startedAt: Date.now() }
        await this.store.recordRun(job)
        const result = await reviewCompletedTurn(this.ctx, this.config, job, catalog, reviewSignal)
        reviewSignal.throwIfAborted()
        if (result.proposal.action === 'none') {
          await this.store.recordRun({ ...job, state: 'none', finishedAt: Date.now(), inputHash: result.inputHash })
        } else {
          const candidate = result.proposal
          const previous = catalog.find(skill => skill.name === candidate.name)
          if (candidate.action === 'create' && previous !== undefined) throw new Error('A Skill with this name already exists')
          if (candidate.action === 'update' && (previous === undefined || previous.currentHash === undefined
            || !result.reviewedSkills.includes(candidate.name))) throw new Error('The proposed Skill lacks a complete reviewed baseline')
          const duplicate = (await this.store.proposals()).find(proposal => ['pending', 'blocked'].includes(proposal.state)
            && proposal.action === candidate.action && proposal.name === candidate.name && proposal.description === candidate.description && proposal.content === candidate.content)
          reviewSignal.throwIfAborted()
          const proposal = duplicate ?? await this.store.addProposal({ ...candidate, source: job.source, reviewSessionId: job.reviewSessionId,
            ...(previous?.currentHash === undefined ? {} : { baseHash: previous.currentHash }) })
          let state = 'proposed'
          if (this.config.autoApplyOwned && job.writeAllowed && (candidate.action === 'create' || previous?.owned === true)) {
            try {
              const sourceSession = this.ctx.sessions.get(job.source.sessionId)
              if (sourceSession === undefined) throw new Error('The source Session is no longer available')
              await assertSkillWriteAllowed(this.ctx, sourceSession, this.config.skillsRoot)
              reviewSignal.throwIfAborted()
              const applied = await this.store.apply(proposal.id, { automatic: true })
              state = applied.state === 'applied' ? 'applied' : 'blocked'
            } catch { reviewSignal.throwIfAborted(); state = 'blocked' }
          }
          await this.store.recordRun({ ...job, state, proposalId: proposal.id, finishedAt: Date.now(), inputHash: result.inputHash,
            validation: { format: 'passed', semantic: 'not_performed' } })
        }
      } catch {
        await this.store.recordRun({ ...job, state: 'failed', finishedAt: Date.now(),
          error: reviewSignal.aborted ? 'Skill review was cancelled. No automatic retry was made.' : 'Skill review failed validation or execution. Inspect its saved review Session before retrying.' })
      } finally { this.activeReview = undefined; this.pending.delete(id) }
    }
  }

  /**
   * Wait for collected writes, an already-scheduled idle delay, and active reviews.
   * @returns {Promise<void>} Quiescence; queued work blocked by activity or daily limits may remain.
   */
  async whenIdle() {
    await this.writes
    while (this.running !== undefined || this.timerDone !== undefined) await (this.running ?? this.timerDone)
  }

  /**
   * Cancel and drain pending work before the owning store closes.
   * @returns {Promise<void>} All plugin-owned asynchronous work has settled.
   */
  async dispose() {
    this.closed = true
    clearTimeout(this.timer)
    this.timer = undefined
    this.releaseTimer?.()
    this.timerDone = undefined
    this.controller.abort()
    await this.writes
    await this.running
    this.turns.clear()
  }
}
