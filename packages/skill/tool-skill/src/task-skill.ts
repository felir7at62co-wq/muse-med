/** Restore the selected task skill from its verified source when its original message leaves the model's history. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { isModelInvocable, isUserInvocable, renderSkillContent, type SkillDefinition } from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools/pipeline'
import { z } from 'zod'

const version = z.string().regex(/^[a-f0-9]{64}$/u)
const loaded = z.object({ kind: z.literal('task-skill-loaded'), name: z.string(), version })
const released = z.object({ kind: z.literal('task-skill-ended'), name: z.string(), activation: z.number().int().nonnegative() })
const activeSchema = z.object({
  name: z.string(), version, seq: z.number().int().nonnegative(), explicit: z.boolean(), shownHash: version.nullable(),
})
const stateSchema = z.object({ inherited: z.number().int().nonnegative(), active: activeSchema.nullable() })
type TaskState = z.infer<typeof stateSchema>

/**
 * Identify one provider's exact instructions independently of its installation directory.
 * @param skill - Selected skill owner, name and unmodified instructions.
 * @returns Lowercase SHA-256.
 */
export function taskSkillVersion(skill: Pick<SkillDefinition, 'name' | 'provider' | 'content'>): string {
  return createHash('sha256').update(JSON.stringify([skill.name, skill.provider, skill.content])).digest('hex')
}

function shownHash(content: readonly ContentBlock[]): string | null {
  const [block] = content
  return content.length === 1 && block?.type === 'text' ? createHash('sha256').update(block.text).digest('hex') : null
}

function advance(state: TaskState, event: SessionEvent): TaskState {
  if (event.seq < state.inherited) return state
  if (event.type === 'user/message') {
    const source = event.data.source
    if (source.kind === 'skill-invocation' && typeof source.taskVersion === 'string' && version.safeParse(source.taskVersion).success) {
      return { ...state, active: {
        name: source.name, version: source.taskVersion, seq: event.seq, explicit: true, shownHash: shownHash(event.data.content),
      } }
    }
  }
  if (event.type !== 'tool/result' || event.data.message.isError || event.data.meta === undefined) return state
  const envelope = event.data.meta
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) return state
  const meta = envelope[TOOL_BODY_META_KEY]
  if (meta === undefined || meta === null || typeof meta !== 'object' || Array.isArray(meta)) return state
  if (meta.kind === 'task-skill-loaded') {
    const parsed = loaded.safeParse(meta)
    if (parsed.success) {
      return { ...state, active: {
        name: parsed.data.name, version: parsed.data.version, seq: event.seq, explicit: false,
        shownHash: shownHash(event.data.message.content),
      } }
    }
  } else if (meta.kind === 'task-skill-ended') {
    const parsed = released.safeParse(meta)
    if (parsed.success && state.active?.seq === parsed.data.activation && state.active.name === parsed.data.name) {
      return { ...state, active: null }
    }
  }
  return state
}

function reloadNotice(name: string): string {
  return `The current task skill "${name}" exceeds the recovery budget. Read the required instructions again before relying on them.`
}

/**
 * Register session-scoped phase selection, explicit completion and bounded prompt recovery.
 * @param ctx - The preset owning the skill loader and the corresponding runtime context.
 * @param names - Skills that replace the previous phase on successful activation.
 * @param maxChars - Maximum length of the recovered context contribution.
 * @param loader - The exact visible skill loader that owns these activations.
 */
export async function installTaskSkillRecovery(
  ctx: Context, names: ReadonlySet<string>, maxChars: number, loader: ToolDefinition,
): Promise<void> {
  for (const name of names) {
    if (reloadNotice(name).length > maxChars) throw new RangeError('taskSkillMaxChars must fit the reload notice for each task skill')
  }
  const phases = await ctx.sessionProjections.register({
    key: 'taskSkillPhase', stateVersion: 1, stateSchema,
    init: (_header, inherited) => ({ inherited, active: null }),
    apply: advance,
  })

  // The async lookup checks the current provider and permissions. Admission rechecks the
  // final surface synchronously, including compaction performed by request routing or retry.
  const prepared = new WeakMap<Agent, { signal: AbortSignal; seq: number; text: string; complete: boolean }>()
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    prepared.delete(agent)
    if (decision.kind === 'reject' || ctx.tools.get('skill', agent) !== loader) return decision
    if (decision.messages.some(message => message.source.kind === 'skill-invocation' && message.source.taskVersion !== undefined)) return decision
    const phase = phases.stateOf(agent.session).active
    if (!phase || !names.has(phase.name)) return decision
    const cwd = await ctx.workingDirectory.ensure(agent, signal)
    const skill = await ctx.skills.get(phase.name, { cwd, scope: agent, signal })
    signal.throwIfAborted()
    const visible = skill && (phase.explicit ? isUserInvocable(skill) : isModelInvocable(skill))
    const body = visible ? renderSkillContent(skill) : ''
    const usable = skill !== undefined && visible === true && taskSkillVersion(skill) === phase.version
    const complete = usable && phase.shownHash === createHash('sha256').update(body).digest('hex')
    let text = usable ? `For the current task, resume these previously loaded instructions. The latest user request determines the scope.\n${body}`
      : `The previously loaded version of "${phase.name}" is unavailable. Select an available skill for the current task before relying on it.`
    if (text.length > maxChars) text = reloadNotice(phase.name)
    prepared.set(agent, { signal, seq: phase.seq, text, complete })
    return decision
  }, { prepend: true })
  ctx.systemPrompt.context({
    name: 'task-skill', order: ctx.systemPrompt.getContextOrder('TASK_SKILL'), interpolate: false, required: true,
    text: ({ agent, signal }) => {
      if (!agent || ctx.tools.get('skill', agent) !== loader) return ''
      const ready = prepared.get(agent)
      const phase = phases.stateOf(agent.session).active
      if (!phase || !ready || ready.signal !== signal || ready.seq !== phase.seq) return ''
      if (ready.complete && agent.session.surface.nodes.includes(SessionSeq(phase.seq))) return ''
      return ready.text
    },
  })
  ctx.tools.register(defineTool({
    name: 'end_task_skill',
    description: 'Release the current task skill when its task is complete, cancelled or replaced. Loading another task skill switches phases automatically.',
    parameters: { name: { type: 'string', required: true, description: 'Name of the task skill being released.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        name: { type: 'string', required: true }, activation: { type: 'integer', required: true },
      } },
      render: (_args, result) => [{ type: 'text', text: `Ended task skill "${result.name}".` }],
      preserveBodyMeta: true,
      presentationMeta: (_args, result) => ({ kind: 'task-skill-ended', ...result }),
    },
    execute({ name }, { agent }) {
      const phase = agent && phases.stateOf(agent.session).active
      if (!phase || phase.name !== name || !names.has(name)) {
        throw new HarnessError('The named task skill is not active.', 'TASK_SKILL_NOT_ACTIVE')
      }
      return Promise.resolve({ name, activation: phase.seq })
    },
    presentCall({ name }) { return { card: 'generic', title: `End task skill ${name}`, kind: 'other' } },
  }))
}
