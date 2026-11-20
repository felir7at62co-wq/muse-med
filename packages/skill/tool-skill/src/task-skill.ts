/** Restore the task skills in effect from their verified sources when their original messages leave the model's history. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, HarnessError, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent, type UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import {
  isModelInvocable, isUserInvocable, renderSkillContent, type SkillDefinition, type SkillInvocationSource,
} from '@deepseek-ai/dsh-skill'
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
const stateSchema = z.object({ inherited: z.number().int().nonnegative(), active: z.array(activeSchema) })
type TaskState = z.infer<typeof stateSchema>
type ActiveSkill = z.infer<typeof activeSchema>

/** Name in `taskSkills` that makes every skill the model or user loads a task skill. */
export const ANY_TASK_SKILL = '*'

/** Tool calls that run only while one task skill is in effect. Every rule matching a call applies. */
export interface ToolSkillRule {
  /** Exact tool names, or a prefix followed by `*`. */
  readonly tools: readonly string[]
  /** Task skill that must be in effect before those calls run. */
  readonly skill: string
  /**
   * Top-level arguments that narrow the rule to some calls of those tools: the rule applies only when each
   * named argument of the call is a string equal to one of its listed values.
   */
  readonly arguments?: Readonly<Record<string, readonly string[]>>
}

function matchesTool(pattern: string, tool: string): boolean {
  return pattern.endsWith('*') ? tool.startsWith(pattern.slice(0, -1)) : pattern === tool
}

function matchesCall(rule: ToolSkillRule, tool: string, args: unknown): boolean {
  if (!rule.tools.some(pattern => matchesTool(pattern, tool))) return false
  // Spreading copies the named values of an object and nothing from null or a number, so a rule that names
  // an argument does not apply to a call whose arguments are not an object.
  const given = new Map<string, unknown>(Object.entries({ ...(args as object) }))
  return Object.entries({ ...rule.arguments }).every(([name, values]) => {
    const value = given.get(name)
    return typeof value === 'string' && values.includes(value)
  })
}

/**
 * Count the task skills one tool can require at once. Argument conditions are ignored, so rules that
 * no single call satisfies together still count together.
 * @param rules - Tool requirements of one preset.
 * @returns The largest number of distinct skills required by rules that share a tool name.
 */
export function toolSkillDemand(rules: readonly ToolSkillRule[]): number {
  // A name equal to a prefix matches every rule that a longer name under that prefix could match by prefix.
  const names = new Set(rules.flatMap(rule => rule.tools.map(pattern => pattern.endsWith('*') ? pattern.slice(0, -1) : pattern)))
  return Math.max(0, ...[...names].map(name =>
    new Set(rules.filter(rule => rule.tools.some(pattern => matchesTool(pattern, name))).map(rule => rule.skill)).size))
}

/**
 * Choose the skills to load so that every required one is in effect afterwards. Loading releases the
 * oldest skills beyond the limit; a required skill that this loading would release is loaded again.
 * @param required - Distinct skills one call requires; no more than `limit`.
 * @param active - Skills in effect, oldest first.
 * @param limit - Task skills kept in effect at once.
 * @returns The skills to load, in loading order.
 */
function skillsToLoad(required: readonly string[], active: readonly string[], limit: number): string[] {
  let load = required.filter(name => !active.includes(name))
  for (;;) {
    const rest = active.filter(name => !load.includes(name))
    const kept = rest.slice(Math.max(0, rest.length - (limit - load.length)))
    const released = required.filter(name => !load.includes(name) && !kept.includes(name))
    if (released.length === 0) return load
    load = [...load, ...released]
  }
}

/** Put one activation last, replacing the same skill's earlier activation, and keep the newest `limit`. */
function activate(state: TaskState, next: ActiveSkill, limit: number): TaskState {
  return { ...state, active: [...state.active.filter(item => item.name !== next.name), next].slice(-limit) }
}

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

function advance(state: TaskState, event: SessionEvent, limit: number): TaskState {
  if (event.seq < state.inherited) return state
  if (event.type === 'user/message') {
    const source = event.data.source
    if (source.kind === 'skill-invocation' && typeof source.taskVersion === 'string' && version.safeParse(source.taskVersion).success) {
      return activate(state, {
        name: source.name, version: source.taskVersion, seq: event.seq, explicit: true, shownHash: shownHash(event.data.content),
      }, limit)
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
      return activate(state, {
        name: parsed.data.name, version: parsed.data.version, seq: event.seq, explicit: false,
        shownHash: shownHash(event.data.message.content),
      }, limit)
    }
  } else if (meta.kind === 'task-skill-ended') {
    const parsed = released.safeParse(meta)
    if (parsed.success && state.active.some(item => item.seq === parsed.data.activation && item.name === parsed.data.name)) {
      return { ...state, active: state.active.filter(item => item.seq !== parsed.data.activation) }
    }
  }
  return state
}

function reloadNotice(name: string): string {
  return `The current task skill "${name}" exceeds the recovery budget. Read the required instructions again before relying on them.`
}

/**
 * Register session-scoped task-skill selection, explicit completion, bounded prompt recovery, hand-over to a
 * continuation Session and tool requirements.
 * @param ctx - The preset owning the skill loader and the corresponding runtime context.
 * @param names - Skills that become task skills on successful activation; `*` admits every skill.
 * @param maxChars - Maximum length of each recovered skill's context contribution.
 * @param loader - The exact visible skill loader that owns these activations.
 * @param limit - Task skills kept in effect at once; one more activation releases the oldest.
 * @param requirements - Tool calls refused until their task skills are in effect; every matching rule applies, and the
 * next admitted step loads the missing skills. Every rule names a task skill, and no tool requires more than `limit`.
 */
export async function installTaskSkillRecovery(
  ctx: Context, names: ReadonlySet<string>, maxChars: number, loader: ToolDefinition,
  limit = 1, requirements: readonly ToolSkillRule[] = [],
): Promise<void> {
  const admits = (name: string): boolean => names.has(ANY_TASK_SKILL) || names.has(name)
  for (const name of names) {
    if (name !== ANY_TASK_SKILL && reloadNotice(name).length > maxChars) throw new RangeError('taskSkillMaxChars must fit the reload notice for each task skill')
  }
  const phases = await ctx.sessionProjections.register({
    key: 'taskSkillPhase', stateVersion: 2, stateSchema,
    init: (_header, inherited) => ({ inherited, active: [] }),
    apply: (state, event) => advance(state, event, limit),
  })
  // A state saved under a larger limit keeps only what the current limit admits.
  const inEffect = (agent: Agent): ActiveSkill[] => phases.stateOf(agent.session).active.slice(-limit).filter(item => admits(item.name))

  // The async lookup checks the current provider and permissions. Admission rechecks the
  // final surface synchronously, including compaction performed by request routing or retry.
  const prepared = new WeakMap<Agent, { signal: AbortSignal; skills: { seq: number; text: string; complete: boolean }[] }>()
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    prepared.delete(agent)
    if (decision.kind === 'reject' || ctx.tools.get('skill', agent) !== loader) return decision
    if (decision.messages.some(message => message.source.kind === 'skill-invocation' && message.source.taskVersion !== undefined)) return decision
    const active = inEffect(agent)
    if (active.length === 0) return decision
    const cwd = await ctx.workingDirectory.ensure(agent, signal)
    const skills: { seq: number; text: string; complete: boolean }[] = []
    for (const phase of active) {
      const skill = await ctx.skills.get(phase.name, { cwd, scope: agent, signal })
      signal.throwIfAborted()
      const visible = skill && (phase.explicit ? isUserInvocable(skill) : isModelInvocable(skill))
      const body = visible ? renderSkillContent(skill) : ''
      const usable = skill !== undefined && visible === true && taskSkillVersion(skill) === phase.version
      const complete = usable && phase.shownHash === createHash('sha256').update(body).digest('hex')
      let text = usable ? `For the current task, resume these previously loaded instructions. The latest user request determines the scope.\n${body}`
        : `The previously loaded version of "${phase.name}" is unavailable. Select an available skill for the current task before relying on it.`
      if (text.length > maxChars) text = reloadNotice(phase.name)
      skills.push({ seq: phase.seq, text, complete })
    }
    prepared.set(agent, { signal, skills })
    return decision
  }, { prepend: true })
  ctx.systemPrompt.context({
    name: 'task-skill', order: ctx.systemPrompt.getContextOrder('TASK_SKILL'), interpolate: false, required: true,
    text: ({ agent, signal }) => {
      if (!agent || ctx.tools.get('skill', agent) !== loader) return ''
      const ready = prepared.get(agent)
      if (!ready || ready.signal !== signal) return ''
      const current = new Set(inEffect(agent).map(item => item.seq))
      // A skill whose original message is still whole in the model's history needs no second copy.
      return ready.skills.filter(item => current.has(item.seq)
        && !(item.complete && agent.session.surface.nodes.includes(SessionSeq(item.seq)))).map(item => item.text).join('\n\n')
    },
  })
  // Task skills moving to a continuation Session wait for that agent's next admitted step.
  const carried = new WeakMap<Agent, ActiveSkill[]>()
  ctx.on('task-skill/carry', ({ from, to }) => {
    if (ctx.tools.get('skill', from) !== loader || ctx.tools.get('skill', to) !== loader) return
    const active = inEffect(from)
    if (active.length > 0) carried.set(to, active)
  })
  // Skills a refused tool call is waiting for; the agent's next admitted step loads them.
  const requested = new WeakMap<Agent, Set<string>>()
  // Requested skills that the last attempt could not add; the next refusal leaves loading them to the model.
  const unavailable = new WeakMap<Agent, ReadonlySet<string>>()
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    const waiting = carried.get(agent) ?? []
    const wanted = requested.get(agent) ?? new Set<string>()
    if (decision.kind === 'reject' || ctx.tools.get('skill', agent) !== loader) return decision
    // What could not be added is known only from the attempt of the step just before a refusal.
    unavailable.delete(agent)
    if (waiting.length + wanted.size === 0) return decision
    const cwd = await ctx.workingDirectory.ensure(agent, signal)
    const injections: UserMessage[] = []
    const loadable = async (name: string, modelOnly: boolean): Promise<boolean> => {
      const skill = await ctx.skills.get(name, { cwd, scope: agent, signal })
      signal.throwIfAborted()
      // The injection is logged as a direct invocation, which recovery restores only for a user-invocable skill.
      if (skill === undefined || !isUserInvocable(skill) || (modelOnly && !isModelInvocable(skill))) return false
      const source: SkillInvocationSource = { kind: 'skill-invocation', name, form: 'instructions', taskVersion: taskSkillVersion(skill) }
      injections.push(createUserMessage({ content: [{ type: 'text', text: renderSkillContent(skill) }], source }))
      return true
    }
    for (const phase of waiting) await loadable(phase.name, !phase.explicit)
    const gone = new Set<string>()
    // The Host adds a required skill only where the model may load it too.
    for (const name of wanted) if (!await loadable(name, true)) gone.add(name)
    // A step that was refused or aborted keeps the skills waiting; an admitted one takes them once.
    carried.delete(agent)
    requested.delete(agent)
    if (gone.size > 0) unavailable.set(agent, gone)
    return injections.length === 0 ? decision : { ...decision, messages: [...decision.messages, ...injections] }
  })
  if (requirements.length > 0) {
    const listed = (skills: readonly string[]): string => {
      const quoted = skills.map(name => `"${name}"`)
      return quoted.length === 1 ? `the ${quoted[0]} skill` : `the ${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)} skills`
    }
    ctx.effect(() => ctx.tools.guard((exec) => {
      const agent = exec.agent
      if (!agent || ctx.tools.get('skill', agent) !== loader) return undefined
      const required = [...new Set(requirements.filter(rule => matchesCall(rule, exec.name, exec.arguments)).map(rule => rule.skill))]
      const active = inEffect(agent).map(item => item.name)
      if (required.every(name => active.includes(name))) return undefined
      const load = skillsToLoad(required, active, limit)
      const wanted = requested.get(agent) ?? new Set<string>()
      for (const name of load) wanted.add(name)
      requested.set(agent, wanted)
      const gone = load.filter(name => unavailable.get(agent)?.has(name) === true)
      if (gone.length > 0) {
        const them = gone.length === 1 ? 'it' : 'them'
        return {
          reason: `${exec.name} has not run: its working method is in ${listed(gone)}, which could not be added to this conversation. Load ${them} with the skill tool if the skill catalog lists ${them}, then repeat the call; otherwise tell the user that ${exec.name} cannot run.`,
          info: { name: 'TaskSkillUnavailable', code: 'TASK_SKILL_UNAVAILABLE' },
        }
      }
      return {
        reason: `${exec.name} has not run: its working method is in ${listed(load)}, now added to this conversation. Read ${load.length === 1 ? 'it' : 'them'}, then repeat the call.`,
        info: { name: 'TaskSkillRequired', code: 'TASK_SKILL_REQUIRED' },
      }
    }), 'tool-skill: tool calls that require task skills')
  }
  ctx.tools.register(defineTool({
    name: 'end_task_skill',
    description: limit === 1
      ? 'Release the current task skill when its task is complete, cancelled or replaced. Loading another task skill switches phases automatically.'
      : `Release a task skill when its task is complete or cancelled. Up to ${limit} task skills stay in effect together and are restored after the conversation is condensed; loading one more releases the oldest.`,
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
      const phase = agent && inEffect(agent).find(item => item.name === name)
      if (!phase) throw new HarnessError('The named task skill is not active.', 'TASK_SKILL_NOT_ACTIVE')
      return Promise.resolve({ name, activation: phase.seq })
    },
    presentCall({ name }) { return { card: 'generic', title: `End task skill ${name}`, kind: 'other' } },
  }))
}
