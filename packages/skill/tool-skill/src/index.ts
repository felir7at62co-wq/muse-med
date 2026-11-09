/**
 * Durable session skill catalog and model-facing `skill` loader tool.
 *
 * @module @deepseek-ai/dsh-tool-skill
 */

import type {} from '@deepseek-ai/dsh-working-directory'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, type UserMessage } from '@deepseek-ai/dsh-session'
import {
  escapeText,
  isModelInvocable,
  isSkillName,
  isUserInvocable,
  renderSkillContent,
  type SkillInvocationSource,
  type SkillSummary,
} from '@deepseek-ai/dsh-skill'

import { needsCatalogSelection, selectCatalogSkills, type CatalogSourceLimits } from './catalog-selection.ts'
import { pageSkillCatalog, SkillCatalogError } from './catalog-directory.ts'
export type { SkillCatalogCursor, SkillCatalogRequest, SkillCatalogDirectoryEntry, SkillCatalogPage } from './catalog-directory.ts'

export const name = 'tool-skill'
export const inject = ['agents', 'tools', 'skills', 'workingDirectory']

const DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH = 500
// Only the visible active loader owns a catalog in nested preset compositions.
const activeSkillTools = new WeakSet<ToolDefinition>()
/**
 * Durable provider and item records for one published session skill catalog. The catalog is a
 * `catalog`-form context, so it records the entries it published beside the
 * model-facing prose: a consumer presenting the list must not re-parse the
 * `<available_skills>` block, whose framing exists for the model.
 */
export interface SkillCatalogSource {
  readonly kind: 'skill-catalog'
  readonly form: 'catalog'
  /** Marks a replacement catalog rather than this session's first publication. */
  readonly update?: true
  /** Some discovery failed; entries contain only skills found in this observation. Absence means complete. */
  readonly incomplete?: true
  /** Complete discovery deliberately omitted eligible summaries under configured source limits. */
  readonly bounded?: true
  /** Exactly the entries this message published, in catalog order. */
  readonly entries: readonly { readonly name: string; readonly description: string }[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'skill-catalog': SkillCatalogSource
  }
}

/** Durable entry list mirroring the rendered catalog lines, for non-model consumers. */
function catalogSourceEntries(
  skills: SkillSummary[],
  descriptionMaxLength: number,
): SkillCatalogSource['entries'] {
  return skills.map(skill => ({
    name: skill.name,
    description: catalogDescription(skill, descriptionMaxLength),
  }))
}

/** Model-facing skill catalog configuration. */
export interface Config {
  /** Maximum normalized description length rendered in the session catalog; minimum 3. */
  catalogDescriptionMaxLength?: number
  /** Preserve this scoped loader's catalog through other Host loader listeners; defaults to false. */
  scopedCatalogOwner?: boolean
  /** Maximum advertised summaries for each exact source; omitted sources remain complete. */
  catalogSourceLimits?: CatalogSourceLimits
  /** Default metadata directory page size, an integer from 1 through 100. */
  catalogPageSize?: number
}

/** Validate and default the model-facing skill catalog configuration. */
export const Config: z<Config> = z.object({
  catalogDescriptionMaxLength: z.number().default(DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH),
  scopedCatalogOwner: z.boolean().default(false),
  catalogSourceLimits: z.dict(z.number().min(1).step(1)).default({}),
  catalogPageSize: z.number().min(1).max(100).step(1).default(20),
})

/**
 * Register the model-facing skill loader and its visibility-matched
 * durable session catalog. The catalog is emitted only when the calling agent
 * resolves this plugin's exact tool registration; a restriction or scoped
 * same-name shadow therefore removes both the schema and its call guidance.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const catalogDescriptionMaxLength = config.catalogDescriptionMaxLength ?? DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH
  const scopedCatalogOwner = config.scopedCatalogOwner ?? false
  assertPositiveInteger('catalogDescriptionMaxLength', catalogDescriptionMaxLength, 3)
  const limits = config.catalogSourceLimits ?? {}, pageSize = config.catalogPageSize ?? 20
  for (const value of Object.values(limits)) assertPositiveInteger('catalogSourceLimits', value)
  assertPositiveInteger('catalogPageSize', pageSize)
  if (pageSize > 100) throw new Error('tool-skill: catalogPageSize must not exceed 100')
  const limited = Object.keys(limits).length > 0
  const prepared = new WeakMap<Agent, WeakMap<AbortSignal, { enabled: boolean }>>()

  const skillTool = defineTool({
    name: 'skill',
    description: 'Load the full instructions for a skill. Call it before acting on a task that names or clearly matches a skill in the session skill catalog.',
    parameters: {
      name: { type: 'string', required: true, description: 'The exact skill name from the available skills list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          resourceBase: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'directory' },
                  path: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'url' },
                  url: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'opaque' },
                  description: { type: 'string', required: true },
                },
              },
            ],
          },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSkillContent(value) }],
    },
    async execute(args, exec) {
      if (!isSkillName(args.name)) {
        throw new Error(`invalid skill name "${args.name}"`)
      }
      // The agent is its own scope key, so the lookup resolves the layered
      // registry exactly as this agent's composition sees it.
      const cwd = exec.agent === undefined ? undefined : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      const lookup = { cwd, signal: exec.signal, scope: exec.agent }
      const summary = (await ctx.skills.list(lookup)).find(skill => skill.name === args.name)
      if (!summary) {
        throw new Error(`skill "${args.name}" is unknown or no longer available`)
      }
      if (!isModelInvocable(summary)) {
        throw new Error(`skill "${args.name}" is not available for model invocation`)
      }
      const skill = await ctx.skills.get(args.name, lookup)
      if (!skill) {
        throw new Error(`skill "${args.name}" is unknown or no longer available`)
      }
      if (!isModelInvocable(skill)) {
        throw new Error(`skill "${args.name}" is not available for model invocation`)
      }
      return {
        name: skill.name,
        provider: skill.provider,
        ...skill.resourceBase !== undefined ? {
          resourceBase: { ...skill.resourceBase },
        } : {},
        content: skill.content,
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Load skill ${args.name}`, kind: 'read', rawInput: args.name }
    },
  })
  ctx.tools.register(skillTool)
  if (scopedCatalogOwner) {
    ctx.effect(() => {
      activeSkillTools.add(skillTool)
      return () => { activeSkillTools.delete(skillTool) }
    }, 'tool-skill.catalog-owner')
  }

  const cursorFields = {
    version: { type: 'integer', const: 1, required: true },
    sessionId: { type: 'string', required: true },
    digest: { type: 'string', required: true },
    query: { type: 'string', required: true },
    offset: { type: 'integer', required: true },
  } as const
  const directoryTool = defineTool({
    name: 'skill_catalog',
    description: 'Search or page the complete directory of skills permitted for model invocation. Returns metadata only; load an exact name with skill before following its instructions.',
    parameters: {
      query: { type: 'string', description: 'Case-insensitive substring in name, description or when-to-use guidance.' },
      cursor: { type: 'object', additionalProperties: false, properties: cursorFields,
        description: 'The unchanged nextCursor from this Session and directory query.' },
      limit: { type: 'integer', description: 'Maximum metadata entries in this page.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        entries: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          name: { type: 'string', required: true }, description: { type: 'string', required: true },
          source: { type: 'string', required: true }, whenToUse: { type: 'string' },
        } } },
        totalMatched: { type: 'integer', required: true },
        catalogComplete: { type: 'boolean', const: true, required: true },
        nextCursor: { type: 'object', additionalProperties: false, properties: cursorFields },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => ({ kind: 'skill-catalog', count: value.entries.length,
        totalMatched: value.totalMatched, hasMore: value.nextCursor !== undefined }),
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('skill_catalog requires an admitted Agent step')
      const snapshot = await ctx.skills.snapshot({ cwd: await ctx.workingDirectory.ensure(agent, exec.signal),
        signal: exec.signal, scope: agent })
      if (!snapshot.complete) throw new SkillCatalogError('SKILL_CATALOG_INCOMPLETE')
      const page = pageSkillCatalog(agent.id, snapshot.skills.filter(isModelInvocable), {
        ...(args.query === undefined ? {} : { query: args.query }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
        ...(args.cursor === undefined ? {} : { cursor: { ...args.cursor, sessionId: SessionId(args.cursor.sessionId) } }),
      }, pageSize)
      return { ...page, entries: [...page.entries] }
    },
    presentCall(args) { return { card: 'generic', title: 'Find skills', kind: 'read', rawInput: args.query ?? '' } },
    presentResult(_args, result) {
      if (result.isError) return { card: 'generic', title: 'Skill directory unavailable' }
      const meta = result.meta
      if (meta === undefined || meta === null || typeof meta !== 'object' || Array.isArray(meta)
        || meta.kind !== 'skill-catalog' || typeof meta.count !== 'number' || typeof meta.totalMatched !== 'number') return undefined
      return { card: 'generic', title: 'Skill directory', content: [{ type: 'text',
        text: `${meta.count} of ${meta.totalMatched} matching skills${meta.hasMore === true ? '; more results are available' : ''}` }] }
    },
  })
  if (limited) ctx.tools.register(directoryTool, { when: async ({ agent, signal }) => {
    if (ctx.tools.get(skillTool.name, agent) !== skillTool) return false
    const snapshot = await ctx.skills.snapshot({ cwd: ctx.workingDirectory.get(agent.session), signal, scope: agent })
    signal.throwIfAborted()
    const enabled = snapshot.complete
      ? needsCatalogSelection(snapshot.skills.filter(isModelInvocable), limits)
      : catalogHistory(agent).visibleBounded === true
    let admissions = prepared.get(agent)
    if (admissions === undefined) { admissions = new WeakMap(); prepared.set(agent, admissions) }
    admissions.set(signal, { enabled })
    return enabled
  } })

  // User-explicit skill invocation: a claimed user message containing a whitespace-bounded
  // `/<name>` naming a user-invocable skill is a deterministic
  // load gesture. The rendered body enters this step as injected
  // instructions context appended after every other injection — background
  // first (workspace rules, runtime policy, the catalog), the material the
  // model must act on last, closest to its answer. Registration order makes
  // that placement deterministic: this listener registers before the catalog
  // listener, so the waterfall hands it the catalog-bearing list to extend.
  // Only `source.kind === 'user'` messages are scanned — external text
  // cannot forge the gesture — and a token naming no user-invocable skill
  // stays ordinary prose (the command registry is a different closed
  // namespace, resolved client-side before a line ever becomes a prompt).
  // This is the only entry point for `disable-model-invocation` skills; the
  // catalog and the `skill` tool below never see them.
  ctx.on('agent/pre-step', async (
    { agent, messages, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (ctx.tools.get(skillTool.name, agent) !== skillTool) return decision
    const names = invokedSkillNames(messages)
    if (names.length === 0) return decision
    signal.throwIfAborted()
    const lookup = { cwd: await ctx.workingDirectory.ensure(agent, signal), signal, scope: agent }
    const injections: UserMessage[] = []
    for (const name of names) {
      const skill = await ctx.skills.get(name, lookup)
      signal.throwIfAborted()
      // Unknown names and user-disabled skills stay plain prose: the
      // gesture was never a claim this boundary recognizes. The check sits
      // on the loaded definition — the single lookup that produces what is
      // actually injected.
      if (skill === undefined || !isUserInvocable(skill)) continue
      const source: SkillInvocationSource = { kind: 'skill-invocation', name, form: 'instructions' }
      injections.push(createUserMessage({
        content: [{ type: 'text', text: renderSkillContent(skill) }],
        source,
      }))
    }
    if (injections.length === 0 || ctx.tools.get(skillTool.name, agent) !== skillTool) return decision
    return { ...decision, messages: [...decision.messages, ...injections] }
  })

  // Register after the tool so reverse teardown removes guidance first. Exact definition
  // identity prevents a scoped shadow merely named `skill` from inheriting this catalog.
  //
  // The comparison is against the definition this plugin registered, not against
  // a lookup of its own name: `register()` files into the CALLING context's
  // scope, so a plugin mounted inside an agent preset registers for that agent
  // alone and an unscoped lookup correctly finds nothing.
  ctx.on('agent/pre-step', async (
    { agent, messages, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal.throwIfAborted()
    const visibleTool = ctx.tools.get(skillTool.name, agent)
    if (visibleTool !== skillTool && visibleTool !== undefined && activeSkillTools.has(visibleTool)) return decision
    const toolVisible = visibleTool === skillTool
    let snapshot = toolVisible
      ? await ctx.skills.snapshot({ cwd: await ctx.workingDirectory.ensure(agent, signal), signal, scope: agent })
      : { skills: [], complete: true }
    signal.throwIfAborted()
    const currentTool = ctx.tools.get(skillTool.name, agent)
    if (currentTool !== skillTool) {
      if (currentTool !== undefined && activeSkillTools.has(currentTool)) return decision
      if (scopedCatalogOwner) snapshot = { skills: [], complete: true }
    }
    const history = catalogHistory(agent)
    if (!snapshot.complete) {
      if (history.visibleDigest === undefined) {
        throw new Error('Skill preparation did not complete; no model request was sent. Check skill folders and retry.')
      }
      return decision
    }
    const incomplete = false
    const eligible = snapshot.skills.filter(isModelInvocable)
    const bounded = limited && needsCatalogSelection(eligible, limits)
    const admissions = prepared.get(agent)
    if (bounded || admissions?.has(signal)) {
      const admission = admissions?.get(signal); admissions?.delete(signal)
      if (admission?.enabled !== bounded
        || bounded && ctx.tools.get(directoryTool.name, agent) !== directoryTool) {
        throw new Error('Skill catalog changed while preparing its directory access; retry before sending a model request.')
      }
    }
    const direct = messages.filter(message => message.source.kind === 'user').at(-1)
    const intent = direct?.content.filter(block => block.type === 'text').map(block => block.text).join(' ') ?? ''
    const preferred = direct === undefined ? history.latestEntries?.map(entry => entry.name) ?? [] : invokedSkillNames([direct])
    const skills = bounded ? selectCatalogSkills(eligible, limits, intent, preferred) : eligible
    const entries = catalogSourceEntries(skills, catalogDescriptionMaxLength)
    const digest = digestCatalogEntries(entries, incomplete, bounded)
    const existing = catalogMessage(decision.messages)
    if (history.visibleDigest === digest) {
      return existing === undefined
        ? decision
        : { ...decision, messages: decision.messages.filter(message => message.id !== existing.message.id) }
    }
    if (existing !== undefined && digestCatalogEntries(existing.entries, existing.incomplete, existing.bounded) === digest) return decision
    if (!history.published && skills.length === 0) {
      return existing === undefined
        ? decision
        : { ...decision, messages: decision.messages.filter(message => message.id !== existing.message.id) }
    }
    const catalog = history.published
      ? renderCatalogUpdate(entries, incomplete, bounded)
      : renderCatalogMessage(entries, incomplete, bounded)
    return {
      ...decision,
      messages: existing === undefined
        ? [...decision.messages, catalog]
        : decision.messages.map(message => message.id === existing.message.id ? catalog : message),
    }
  })
}

function renderCatalogMessage(entries: SkillCatalogSource['entries'], incomplete: boolean, bounded = false): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        entries.length === 0
          ? 'No skills could be confirmed in this discovery attempt.'
          : bounded
            ? 'The following are selected skill summaries, not the complete permitted directory. Use skill_catalog to search or page all currently permitted names:'
            : 'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
        '',
        '<available_skills>',
        ...renderCatalogEntries(entries),
        '</available_skills>',
        '',
        ...incomplete ? [incompleteCatalogNotice(), ''] : [],
        entries.length === 0
          ? 'Wait for an updated catalog before calling the `skill` tool. Do not infer skill instructions from an empty catalog.'
          : "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
        'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
        '</system-reminder>',
      ].join('\n'),
    }],
    source: {
      kind: 'skill-catalog',
      form: 'catalog',
      entries,
      ...incomplete ? { incomplete: true } : {},
      ...bounded ? { bounded: true } : {},
    },
  })
}

function renderCatalogUpdate(entries: SkillCatalogSource['entries'], incomplete: boolean, bounded = false): UserMessage {
  const availability = entries.length === 0
    ? [
      incomplete
        ? 'No skills could be confirmed in this discovery attempt. Do not use names from earlier skill catalogs.'
        : 'No skills are currently available through the `skill` tool. Do not use names from earlier skill catalogs.',
      'A user may still invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool for it.',
    ]
    : [
      bounded
        ? 'These are selected summaries. Use skill_catalog for the complete permitted directory, then load an exact name with skill. Selection changes do not change invocation permissions.'
        : 'Use only names in this replacement catalog. If the user names a listed skill, or the task clearly matches its description, call the `skill` tool with the exact name before acting.',
      'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
    ]
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        bounded
          ? 'The selected skill summaries changed. This selection replaces earlier recommendations; use skill_catalog for the complete permitted directory:'
          : incomplete
            ? 'Skill discovery is incomplete. This catalog of currently available skills replaces every earlier available-skills list in this session:'
            : 'The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:',
        '',
        '<available_skills>',
        ...renderCatalogEntries(entries),
        '</available_skills>',
        '',
        ...incomplete ? [incompleteCatalogNotice(), ''] : [],
        ...availability,
        '</system-reminder>',
      ].join('\n'),
    }],
    source: {
      kind: 'skill-catalog',
      form: 'catalog',
      update: true,
      entries,
      ...incomplete ? { incomplete: true } : {},
      ...bounded ? { bounded: true } : {},
    },
  })
}

function incompleteCatalogNotice(): string {
  return 'Some skills could not be checked. Only confirmed skills are listed; a lower-priority definition of the same name may be selected when a preferred source is unavailable. Discovery will be retried on the next request.'
}

/**
 * Model-facing catalog lines, projected from the same entries the source records.
 * The pseudo-XML escaping belongs to this frame, not to the published fact, so it
 * is applied here and never stored. Names are `isSkillName`-validated and carry
 * no escapable character.
 */
function renderCatalogEntries(entries: SkillCatalogSource['entries']): string[] {
  return entries.map(entry => `- \`${entry.name}\`: ${escapeText(entry.description)}`)
}

/**
 * Catalog identity includes durable entries and completeness so recovery clears
 * a discovery warning even when the entries are unchanged.
 */
function digestCatalogEntries(entries: SkillCatalogSource['entries'], incomplete = false, bounded = false): string {
  // JSON per entry rather than a separator character: every separator is itself
  // a legal description character, so only quoting makes the boundary exact.
  const canonical = entries.map(entry => JSON.stringify([entry.name, entry.description])).join('\n')
  return createHash('sha256')
    .update(incomplete ? 'incomplete\n' : '')
    .update(bounded ? 'bounded\n' : '')
    .update(canonical)
    .digest('hex')
}

/**
 * Entries of one durable catalog message, or undefined when the record is not a
 * usable catalog.
 *
 * `agent.session.snapshotEvents()` may contain a resumed, forked, or externally written seed,
 * and seed validation only guarantees a source object with a non-empty `kind`;
 * no per-kind field is checked there. An unreadable record is therefore treated
 * as "not this plugin's catalog" — the posture the replaced content digest had —
 * rather than throwing inside the step listener, which would fail every
 * subsequent turn of that session.
 */
function readCatalogEntries(source: unknown): SkillCatalogSource['entries'] | undefined {
  const bounded = (source as { bounded?: unknown }).bounded
  if (bounded !== undefined && bounded !== true) return undefined
  const entries = (source as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return undefined
  const readable: { name: string; description: string }[] = []
  for (const entry of entries as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const { name, description } = entry as { name?: unknown; description?: unknown }
    if (typeof name !== 'string' || name === '' || typeof description !== 'string') return undefined
    readable.push({ name, description })
  }
  return readable
}

function catalogHistory(agent: Agent): { visibleDigest?: string; visibleBounded?: true; published: boolean; latestEntries?: SkillCatalogSource['entries'] } {
  const visible = new Set(agent.session.surface.nodes)
  let published = false
  let latestEntries: SkillCatalogSource['entries'] | undefined
  for (let index = agent.session.seq - 1; index >= 0; index -= 1) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = agent.session.eventAt(SessionSeq(index))
    if (event === undefined) {
      throw new Error(`skill catalog cannot read seq ${String(index)} below the current Session length`)
    }
    if (event.type !== 'user/message' || event.data.source.kind !== 'skill-catalog') continue
    const entries = readCatalogEntries(event.data.source)
    if (entries === undefined) continue
    latestEntries ??= entries
    const digest = digestCatalogEntries(entries, event.data.source.incomplete === true, event.data.source.bounded === true)
    published = true
    if (visible.has(event.seq)) return { visibleDigest: digest, published, latestEntries,
      ...(event.data.source.bounded === true ? { visibleBounded: true } : {}) }
  }
  return { published, ...(latestEntries === undefined ? {} : { latestEntries }) }
}

function catalogMessage(
  messages: readonly UserMessage[],
): { message: UserMessage; entries: SkillCatalogSource['entries']; incomplete: boolean; bounded: boolean } | undefined {
  for (const message of messages) {
    if (message.source.kind !== 'skill-catalog') continue
    const entries = readCatalogEntries(message.source)
    if (entries !== undefined) return { message, entries, incomplete: message.source.incomplete === true,
      bounded: message.source.bounded === true }
  }
  return undefined
}

/** Fit trigger guidance before the description within the existing per-skill budget. */
function catalogDescription(skill: Pick<SkillSummary, 'description' | 'whenToUse'>, maxLength: number): string {
  const description = skill.description.replaceAll(/\s+/g, ' ').trim()
  const whenToUse = skill.whenToUse?.replaceAll(/\s+/g, ' ').trim()
  const summary = whenToUse && whenToUse !== description
    ? `When to use: ${whenToUse} Description: ${description}`
    : description
  return summary.length <= maxLength ? summary : `${summary.slice(0, maxLength - 3)}...`
}

function assertPositiveInteger(name: string, value: number, minimum = 1): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`tool-skill: ${name} must be an integer greater than or equal to ${minimum}`)
  }
}

/**
 * A whitespace-bounded `/name` token (the public skill-name grammar) anywhere
 * in the text — the same word-boundary shape the transcript chip decoration
 * uses, so a gesture reads as one wherever it sits in the sentence. A second
 * `/` or any non-boundary character breaks the match, which keeps file paths
 * (`/usr/bin`) and fractions (`5/8`) out.
 */
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g

/**
 * `/name` gesture tokens from the claimed user messages, deduplicated in
 * first-seen order. Every text block of direct user input is scanned; no
 * other source can forge a gesture.
 * @param messages - the step's claimed batch.
 * @returns candidate skill names, unvalidated against the registry.
 */
function invokedSkillNames(messages: readonly UserMessage[]): string[] {
  const names: string[] = []
  for (const message of messages) {
    if ((message.source as { kind?: unknown }).kind !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      for (const match of block.text.matchAll(SKILL_GESTURE)) {
        const name = match[2]
        if (name !== undefined && !names.includes(name)) names.push(name)
      }
    }
  }
  return names
}
