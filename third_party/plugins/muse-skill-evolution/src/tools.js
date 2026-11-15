/** Review and version management of the learning plugin's own Skill files. */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertSkillWriteAllowed } from './permissions.js'

/**
 * Mount one management tool without exposing arbitrary paths or permission overrides.
 * @param {object} ctx - Tool registry and the initiating Session's sandbox policy.
 * @param {object} store - Owned Skill storage.
 * @param {object} options - Complete output character budget.
 */
export function mountEvolutionTools(ctx, store, { outputMaxChars, enabled, autoApplyOwned, maxReviewsPerDay, autoSubmitFeedback, maxFeedbackPerDay }) {
  const bounded = (action, data, offset) => {
    if (!Array.isArray(data)) {
      const result = { action, state: 'ready', data }
      return JSON.stringify(result).length <= outputMaxChars ? result : { action, state: 'too-large', guidance: 'Select one proposal or Skill version; the complete result exceeds the configured output limit.' }
    }
    const result = { action, state: 'ready', total: data.length, items: [], nextOffset: offset }
    for (const entry of data.slice(offset)) {
      result.items.push(entry); result.nextOffset++
      if (JSON.stringify(result).length <= outputMaxChars) continue
      result.items.pop(); result.nextOffset--; break
    }
    if (result.nextOffset >= data.length) delete result.nextOffset
    if (!result.items.length && offset < data.length) return { action, state: 'too-large', total: data.length, guidance: 'Select one proposal or Skill version; an item exceeds the configured output limit.' }
    return result
  }
  ctx.tools.register(defineTool({
    name: 'muse_skill_evolution',
    description: 'Inspect learned Skills, review proposals, apply a proposal, reject it, or restore an owned version, or inspect automatic product feedback receipts. A submitted receipt only confirms inbox intake, not a PR or fix. Changes affect only this plugin\'s muse-learned Skills. Inspect the current hash before apply or undo; user-edited and unrelated Skills are never overwritten. Learning does not alter the model or grant tool permissions.',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'list', 'proposals', 'view', 'apply', 'reject', 'history', 'undo', 'feedback'], description: 'Read status, list Skills or proposals, view content, apply/reject a proposal, list versions, restore a saved version, or read automatic feedback candidates and receipts.' },
      id: { type: 'string', description: 'Proposal ID for view, apply or reject.' },
      name: { type: 'string', description: 'Exact learned Skill name for view, history or undo.' },
      baselineHash: { type: 'string', description: 'Current SHA-256 from list/view. Required by undo; apply also validates its proposal baseline.' },
      versionId: { type: 'string', description: 'Saved version ID for undo, or for view with name.' },
      offset: { type: 'integer', description: 'Zero-based continuation offset for list, proposals or history. Defaults to zero.' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    presentCall: args => ({ card: 'generic', title: 'Manage learned Skills', kind: ['apply', 'undo', 'reject'].includes(args.action) ? 'edit' : 'read' }),
    async execute(args, exec) {
      const offset = args.offset ?? 0
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a nonnegative safe integer')
      await store.ready()
      if (['apply', 'undo', 'reject'].includes(args.action)) await assertSkillWriteAllowed(ctx, exec.agent?.session, store.skillsRoot)
      let result
      switch (args.action) {
        case 'status': {
          const runs = store.runs(), reviewStates = {}
          for (const run of runs) reviewStates[run.state] = (reviewStates[run.state] ?? 0) + 1
          const latest = runs.sort((a, b) => (b.finishedAt ?? b.startedAt ?? b.queuedAt ?? 0) - (a.finishedAt ?? a.startedAt ?? a.queuedAt ?? 0))[0]
          const { work: _work, lines: _lines, ...latestRun } = latest ?? {}
          const feedbackStates = {}
          for (const run of runs) {
            if (run.feedback !== undefined) feedbackStates[run.feedback.state] = (feedbackStates[run.feedback.state] ?? 0) + 1
            else if (run.feedbackProblem !== undefined) feedbackStates.rejected = (feedbackStates.rejected ?? 0) + 1
          }
          result = { enabled, autoApplyOwned, maxReviewsPerDay, autoSubmitFeedback, maxFeedbackPerDay, feedbackStates, ...store.state(), reviewStates, ...(latest ? { latestRun } : {}) }
          break
        }
        case 'feedback': result = store.runs().filter(run => run.feedback !== undefined || run.feedbackProblem !== undefined).map(run => ({ runId: run.id, source: run.source,
          ...(run.feedback === undefined ? {} : { feedback: run.feedback }), ...(run.feedbackProblem === undefined ? {} : { feedbackProblem: run.feedbackProblem }) })); break
        case 'list': result = await store.list(); break
        case 'proposals': result = store.proposals().map(({ content: _content, ...proposal }) => proposal); break
        case 'view':
          result = args.id ? store.get(args.id) : args.versionId ? store.history(args.name).find(version => version.id === args.versionId) : (await store.catalog()).find(skill => skill.name === args.name)
          if (result === undefined) throw new Error('The requested Skill or proposal is unavailable')
          break
        case 'apply': if (!args.id) throw new Error('apply requires a proposal id'); result = await store.apply(args.id, { baselineHash: args.baselineHash }); break
        case 'reject': if (!args.id) throw new Error('reject requires a proposal id'); result = await store.reject(args.id); break
        case 'history': if (!args.name) throw new Error('history requires a learned Skill name'); result = store.history(args.name).map(({ content: _content, ...version }) => version); break
        case 'undo': if (!args.name || !args.versionId || !args.baselineHash) throw new Error('undo requires name, versionId and baselineHash'); result = await store.undo(args.name, args); break
        default: throw new Error('Unknown Skill learning operation')
      }
      return bounded(args.action, result, offset)
    },
  }))
}
