import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId, type Message } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, MessageSource } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import {
  SESSION_FORMAT_VERSION, Session, SessionId, type SessionEvent, type UserMessage,
} from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import * as toolSkill from '@deepseek-ai/dsh-tool-skill'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-tool-skill': { kind: 'dsh-tool-skill' } & ContextFormed
    'later-contribution': { kind: 'later-contribution' } & ContextFormed
  }
}

type CheckpointSource = Extract<MessageSource, { readonly kind: 'compact-checkpoint' }>

/** Build a typed checkpoint source for a skill projection fixture. */
function checkpointSource(compactionId: string): CheckpointSource {
  return { kind: 'compact-checkpoint', compactionId: compactionId as CheckpointSource['compactionId'] }
}

const testToolSignal = new AbortController().signal

/** Every temp dir created by this file, removed after each test. */
const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(name: string): Promise<string> {
  const dir = await import('node:fs/promises').then(fs => fs.mkdtemp(join(tmpdir(), `dsh-${name}-`)))
  tempDirs.push(dir)
  return dir
}

async function writeSkill(root: string, name: string, description: string, body: string): Promise<void> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
}

async function setup(home: string, config: toolSkill.Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SkillFileSystem, { dshHome: join(home, '.dsh'), museHome: join(home, '.muse'), agentsHome: join(home, '.agents'), watch: false })
  await ctx.plugin(toolSkill, config)
  return ctx
}

function agentForCwd(cwd: string): Agent {
  const id = SessionId(`tool-skill-${cwd}`)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd, isSeeded: false,
  })
  return {
    ctx: new Context(),
    id,
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('step-boundary catalog must not use agent.inject()') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function sessionAgent(session: Session, id = 'tool-skill-agent'): Agent {
  const agent: Agent = {
    id: SessionId(id),
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('step-boundary catalog must not use agent.inject()') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  return agent
}

function openMessageTurn(session: Session, turn = 1): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `turn ${turn}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

async function fireStep(ctx: Context, agent: Agent, turn: number, step: number): Promise<void> {
  const signal = new AbortController().signal
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [], turn, step, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
  if (decision.kind === 'enter') {
    for (const message of decision.messages) {
      agent.session.append('user/message', message, { surfaceOp: 'append' })
    }
  }
}

async function proposeStep(
  ctx: Context,
  agent: Agent,
  messages: UserMessage[],
): Promise<PreStepDecision> {
  const signal = new AbortController().signal
  return await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages, turn: 1, step: 1, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages }),
  )
}

function catalogMessages(session: Session): Extract<SessionEvent, { type: 'user/message' }>[] {
  return session.snapshotEvents().filter((event): event is Extract<SessionEvent, { type: 'user/message' }> => event.type === 'user/message'
    && event.data.source.kind === 'skill-catalog')
}

function readableCatalog(event: Extract<SessionEvent, { type: 'user/message' }>): boolean {
  const entries = (event.data.source as { entries?: unknown }).entries
  return Array.isArray(entries)
    && entries.every(entry => typeof entry === 'object' && entry !== null
      && typeof (entry as { name?: unknown }).name === 'string'
      && typeof (entry as { description?: unknown }).description === 'string')
}

function catalogContent(entries: string[]): Message['content'] {
  return [{
    type: 'text',
    text: ['<system-reminder>', '<available_skills>', ...entries, '</available_skills>', '</system-reminder>'].join('\n'),
  }]
}

async function composePrefix(ctx: Context, cwd: string, signal = new AbortController().signal): Promise<Message[]> {
  return await composePrefixForAgent(ctx, agentForCwd(cwd), signal)
}

async function composePrefixForAgent(ctx: Context, agent: Agent, signal = new AbortController().signal): Promise<Message[]> {
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
  if (decision.kind === 'enter') {
    for (const message of decision.messages) {
      agent.session.append('user/message', message, { surfaceOp: 'append' })
    }
  }
  return agent.session.deriveMessages()
}

async function mintAgentScope(ctx: Context, subject: string | Agent, parent?: Agent): Promise<{ agent: Agent; scope: Scope }> {
  const agent = typeof subject === 'string' ? agentForCwd(subject) : subject
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent, parent === undefined ? undefined : { parent }) }, {
    inject: ['tools'],
  }))
  return { agent, scope }
}

describe('dsh-tool-skill', () => {
  it('registers the skill tool schema and removes it on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    const home = await tempDir('tool-schema')
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { dshHome: join(home, '.dsh'), museHome: join(home, '.muse'), agentsHome: join(home, '.agents'), watch: false })
    ctx.skills.register({ name: 'lifecycle-skill', description: 'Lifecycle', source: 'runtime', content: 'body' })

    const fiber = await ctx.plugin(toolSkill)
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['skill'])
    expect(await composePrefix(ctx, '/workspace')).toHaveLength(1)
    expect(ctx.tools.get('skill')?.presentCall?.({ name: 'project-skill' })).toEqual({
      card: 'generic',
      title: 'Load skill project-skill',
      kind: 'read',
      rawInput: 'project-skill',
    })
    await fiber.dispose()
    expect(ctx.tools.schemas()).toEqual([])
    expect(await composePrefix(ctx, '/workspace')).toEqual([])

    toolSkill.apply(ctx)
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['skill'])
  })

  it('forwards the step abort signal to skill discovery', async () => {
    const home = await tempDir('tool-prefix-signal')
    const ctx = await setup(home)
    let seenSignal: AbortSignal | undefined
    ctx.skills.registerProvider(() => ({
      name: 'signal-probe',
      async list(options) {
        seenSignal = options.signal
        return []
      },
      async get() {
        return undefined
      },
    }))
    const controller = new AbortController()

    await composePrefix(ctx, '/workspace', controller.signal)

    expect(seenSignal).toBe(controller.signal)
  })

  it('injects a stable durable name-and-description catalog at the first step', async () => {
    const home = await tempDir('tool-catalog')
    const ctx = await setup(home, { catalogDescriptionMaxLength: 50 })
    ctx.skills.register({
      name: 'z-skill',
      description: 'Long   description '.repeat(5),
      whenToUse: 'Never render this routing hint.',
      source: 'secret-source',
      provider: 'runtime',
      resourceBase: { kind: 'directory', path: '/secret/path' },
      content: 'Secret body.',
    })
    ctx.skills.register({
      name: 'a-skill',
      description: 'Use {{placeholder}} <safely> & carefully.',
      source: 'runtime',
      provider: 'runtime',
      content: 'A body.',
    })
    ctx.skills.register({
      name: 'model-only-skill',
      description: 'Model-only skill.',
      invocation: { modelInvocable: true, userInvocable: false },
      source: 'runtime',
      content: 'Model-only body.',
    })
    ctx.skills.register({
      name: 'user-only-skill',
      description: 'User-only skill.',
      invocation: { modelInvocable: false, userInvocable: true },
      source: 'runtime',
      content: 'User-only body.',
    })
    ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      return {
        ...decision,
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: 'text', text: 'later contribution' }],
            source: { kind: 'later-contribution' },
          }),
        ],
      }
    })

    const prefix = await composePrefix(ctx, '/workspace')

    expect(prefix).toEqual([
      {
        id: expect.any(String) as unknown,
        role: 'user',
        content: [{ type: 'text', text: 'later contribution' }],
        source: { kind: 'later-contribution' },
      },
      {
        id: expect.any(String) as unknown,
        role: 'user',
        source: {
          kind: 'skill-catalog',
          form: 'catalog',
          entries: [
            { name: 'a-skill', description: 'Use {{placeholder}} <safely> & carefully.' },
            { name: 'model-only-skill', description: 'Model-only skill.' },
            { name: 'z-skill', description: 'Long description Long description Long descript...' },
          ],
        },
        content: [{
          type: 'text',
          text: [
            '<system-reminder>',
            'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
            '',
            '<available_skills>',
            '- `a-skill`: Use {{placeholder}} &lt;safely&gt; &amp; carefully.',
            '- `model-only-skill`: Model-only skill.',
            '- `z-skill`: Long description Long description Long descript...',
            '</available_skills>',
            '',
            "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
            'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
            '</system-reminder>',
          ].join('\n'),
        }],
      },
    ])
    const rendered = JSON.stringify(prefix[1])
    expect(rendered).not.toContain('whenToUse')
    expect(rendered).not.toContain('secret-source')
    expect(rendered).not.toContain('/secret/path')
    expect(rendered).not.toContain('Secret body')
    expect(rendered).not.toContain('user-only-skill')
    expect(renderPrompt(await ctx.systemPrompt.assemble({ agent: agentForCwd('/workspace') }))).not.toContain('<available_skills>')
  })

  it('does not inject a catalog when no model-invocable skills are available', async () => {
    const home = await tempDir('tool-empty-catalog')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'user-only-skill',
      description: 'User-only skill',
      invocation: { modelInvocable: false, userInvocable: true },
      source: 'runtime',
      content: 'User-only body.',
    })

    const agent = agentForCwd('/workspace')
    expect(await composePrefixForAgent(ctx, agent)).toEqual([])
    expect(await composePrefixForAgent(ctx, agent)).toEqual([])
  })

  it('omits an incomplete initial catalog and retries on a later request boundary', async () => {
    const home = await tempDir('tool-incomplete-prefix')
    const ctx = await setup(home)
    let failing = true
    const provider = {
      name: 'recovering',
      async list() {
        if (failing) throw new Error('temporarily unavailable')
        return []
      },
      async get() {
        return undefined
      },
    }
    let invalidate = (): void => {}
    ctx.skills.registerProvider((control) => {
      invalidate = control.invalidate
      return provider
    })
    const session = Session.create(SessionId('incomplete-prefix'))
    const agent = sessionAgent(session)
    openMessageTurn(session)

    await composePrefixForAgent(ctx, agent)
    expect(catalogMessages(session)).toEqual([])
    failing = false
    invalidate()
    await fireStep(ctx, agent, 1, 1)

    expect(catalogMessages(session)).toEqual([])
  })

  it('records an empty baseline across repeated step observations', async () => {
    const home = await tempDir('tool-empty-step')
    const ctx = await setup(home)
    const session = Session.create(SessionId('empty-step'))
    const agent = sessionAgent(session)
    openMessageTurn(session)

    await fireStep(ctx, agent, 1, 1)
    await fireStep(ctx, agent, 1, 2)

    expect(catalogMessages(session)).toEqual([])
  })

  it('deduplicates or replaces a catalog already proposed for the same step', async () => {
    const home = await tempDir('tool-proposed-catalog')
    const ctx = await setup(home)
    const disposeFirst = ctx.skills.register({
      name: 'first-skill',
      description: 'First skill',
      source: 'runtime',
      content: 'First body.',
    })
    const session = Session.create(SessionId('proposed-catalog'))
    const agent = sessionAgent(session)
    openMessageTurn(session)
    await fireStep(ctx, agent, 1, 1)
    const initial = catalogMessages(session)[0]?.data
    if (initial === undefined) throw new Error('expected initial catalog')

    const duplicate = await proposeStep(ctx, agent, [initial])
    expect(duplicate).toEqual({ kind: 'enter', messages: [] })

    ctx.skills.register({
      name: 'second-skill',
      description: 'Second skill',
      source: 'runtime',
      content: 'Second body.',
    })
    const companion = createUserMessage({
      content: [{ type: 'text', text: 'keep this message' }],
      source: { kind: 'user' },
    })
    const replaced = await proposeStep(ctx, agent, [companion, initial])
    expect(replaced.kind).toBe('enter')
    if (replaced.kind === 'reject') throw new Error('expected catalog replacement')
    expect(replaced.messages).toHaveLength(2)
    expect(replaced.messages[0]).toBe(companion)
    expect(replaced.messages[1]?.id).not.toBe(initial.id)
    expect(JSON.stringify(replaced.messages[1]?.content)).toContain('second-skill')

    disposeFirst()
  })

  it('removes a stale proposed catalog before the first empty baseline', async () => {
    const home = await tempDir('tool-proposed-empty-catalog')
    const ctx = await setup(home)
    const session = Session.create(SessionId('proposed-empty-catalog'))
    const malformed = createUserMessage({
      content: [{ type: 'text', text: 'preserve unreadable claimed context' }],
      source: { kind: 'skill-catalog', form: 'catalog' } as never,
    })
    const stale = createUserMessage({
      content: catalogContent(['- `stale-skill`: Stale skill']),
      source: {
        kind: 'skill-catalog',
        form: 'catalog',
        entries: [{ name: 'stale-skill', description: 'Stale skill' }],
      },
    })

    const decision = await proposeStep(ctx, sessionAgent(session), [malformed, stale])

    expect(decision).toEqual({ kind: 'enter', messages: [malformed] })
  })

  it('keeps a proposed catalog that already matches the current snapshot', async () => {
    const home = await tempDir('tool-matching-proposal')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'first-skill',
      description: 'First skill',
      source: 'runtime',
      content: 'First body.',
    })
    const session = Session.create(SessionId('matching-proposal'))
    const proposed = createUserMessage({
      content: catalogContent(['- `first-skill`: First skill']),
      source: {
        kind: 'skill-catalog',
        form: 'catalog',
        entries: [{ name: 'first-skill', description: 'First skill' }],
      },
    })

    const decision = await proposeStep(ctx, sessionAgent(session), [proposed])

    expect(decision).toEqual({ kind: 'enter', messages: [proposed] })
  })

  it('injects complete replacement catalogs for additions and an empty tombstone for removals', async () => {
    const home = await tempDir('tool-dynamic-catalog')
    const ctx = await setup(home)
    const disposeFirst = ctx.skills.register({
      name: 'first-skill',
      description: 'First skill',
      source: 'runtime',
      content: 'First body.',
    })
    const session = Session.create(SessionId('dynamic-catalog'))
    const agent = sessionAgent(session)
    openMessageTurn(session)

    expect(JSON.stringify(await composePrefixForAgent(ctx, agent))).toContain('first-skill')
    await fireStep(ctx, agent, 1, 1)
    expect(catalogMessages(session)).toHaveLength(1)

    const disposeSecond = ctx.skills.register({
      name: 'second-skill',
      description: 'Second skill',
      source: 'runtime',
      content: 'Second body.',
    })
    await fireStep(ctx, agent, 1, 2)

    const addition = catalogMessages(session)[1]
    if (addition?.type !== 'user/message') throw new Error('expected catalog addition')
    expect(JSON.stringify(addition.data.content)).toContain('first-skill')
    expect(JSON.stringify(addition.data.content)).toContain('second-skill')

    disposeSecond()
    disposeFirst()
    await fireStep(ctx, agent, 1, 3)

    const removal = catalogMessages(session)[2]
    if (removal?.type !== 'user/message') throw new Error('expected catalog removal')
    expect(JSON.stringify(removal.data.content)).toContain('No skills are currently available')
    expect(JSON.stringify(removal.data.content)).not.toContain('first-skill')
    expect(JSON.stringify(removal.data.content)).not.toContain('second-skill')

    await fireStep(ctx, agent, 1, 4)
    expect(catalogMessages(session)).toHaveLength(3)
  })

  it('resumes from the durable entries of the latest visible catalog', async () => {
    // Catalog identity lives on `source.entries`: the model-facing prose does
    // not decide whether a republish is needed, so a seeded message is
    // recognized by its source alone and malformed prose cannot hide (or fake)
    // a published catalog. A foreign-sourced message is not this plugin's
    // catalog at all.
    const home = await tempDir('tool-catalog-resume')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'resumed-skill',
      description: 'Resumed skill',
      source: 'runtime',
      content: 'Resumed body.',
    })
    const session = Session.create(SessionId('catalog-resume'))
    const agent = sessionAgent(session)
    openMessageTurn(session)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'prose a reader cannot rely on' }],
      source: {
        kind: 'skill-catalog',
        form: 'catalog',
        entries: [{ name: 'old-skill', description: 'Old skill' }],
      },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: catalogContent(['- `resumed-skill`: Resumed skill']),
      source: { kind: 'dsh-tool-skill' },
    }), { surfaceOp: 'append' })

    await fireStep(ctx, agent, 1, 1)

    // The seeded entries differ from the live snapshot, so one replacement
    // lands; the foreign-sourced lookalike neither counts as published nor
    // suppresses it.
    expect(catalogMessages(session)).toHaveLength(2)
    const latest = catalogMessages(session).at(-1)
    expect(latest?.data.source).toMatchObject({
      kind: 'skill-catalog',
      form: 'catalog',
      update: true,
      entries: [{ name: 'resumed-skill', description: 'Resumed skill' }],
    })
    expect(JSON.stringify(latest?.data.content)).toContain('resumed-skill')

    // A second step over unchanged entries republishes nothing.
    await fireStep(ctx, agent, 1, 2)
    expect(catalogMessages(session)).toHaveLength(2)
  })

  it('treats a malformed durable catalog as unrecognizable instead of failing the step', async () => {
    // Seeds reach `agent.session.snapshotEvents()` from persistence on resume or fork,
    // and seed validation only guarantees a source object with a non-empty
    // `kind`. A catalog whose entries are missing or wrongly shaped must be
    // skipped like any foreign record; throwing here would fail every later
    // step of that session at the latest possible point.
    const home = await tempDir('tool-catalog-malformed')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'live-skill',
      description: 'Live skill',
      source: 'runtime',
      content: 'Live body.',
    })
    const session = Session.create(SessionId('catalog-malformed'))
    const agent = sessionAgent(session)
    openMessageTurn(session)
    for (const source of [
      { kind: 'skill-catalog', form: 'catalog' },
      { kind: 'skill-catalog', form: 'catalog', entries: null },
      { kind: 'skill-catalog', form: 'catalog', entries: 'not-an-array' },
      { kind: 'skill-catalog', form: 'catalog', entries: [null] },
      { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'x' }] },
      { kind: 'skill-catalog', form: 'catalog', entries: [{ description: 'no name' }] },
    ]) {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'unreadable catalog' }],
        source: source as never,
      }), { surfaceOp: 'append' })
    }

    await expect(fireStep(ctx, agent, 1, 1)).resolves.toBeUndefined()

    // None of the six counted as published, so the live catalog lands as a
    // first publication rather than a replacement.
    const published = catalogMessages(session).filter(event => readableCatalog(event))
    expect(published).toHaveLength(1)
    expect(published[0]?.data.source).toMatchObject({ kind: 'skill-catalog', form: 'catalog' })
    expect(published[0]?.data.source).not.toHaveProperty('update')
    expect(JSON.stringify(published[0]?.data.content)).toContain('live-skill')
  })

  it('rejects a missing event below the current Session length', async () => {
    const home = await tempDir('tool-catalog-missing-event')
    const ctx = await setup(home)
    const session = Session.create(SessionId('catalog-missing-event'))
    const agent = sessionAgent(session)
    openMessageTurn(session)
    Object.defineProperty(session, 'eventAt', { value: () => undefined })

    await expect(fireStep(ctx, agent, 1, 1))
      .rejects.toThrow('skill catalog cannot read seq 1 below the current Session length')
  })

  it('re-establishes the current catalog after compaction hides its durable message', async () => {
    const home = await tempDir('tool-catalog-compaction')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'first-skill',
      description: 'First skill',
      source: 'runtime',
      content: 'First body.',
    })
    const session = Session.create(SessionId('catalog-compaction'))
    const agent = sessionAgent(session)
    openMessageTurn(session)
    expect(JSON.stringify(await composePrefixForAgent(ctx, agent))).toContain('first-skill')
    const initial = catalogMessages(session)[0]
    if (initial === undefined) throw new Error('expected initial catalog')
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'compacted history' }],
      source: checkpointSource('skill-compaction'),
    }), {
      surfaceOp: { op: 'replace', startSeq: initial.seq, endSeq: initial.seq },
      sourceEventSeqs: [initial.seq],
    })

    await fireStep(ctx, agent, 1, 1)

    expect(catalogMessages(session)).toHaveLength(2)
    expect(JSON.stringify(catalogMessages(session).at(-1)?.data.content)).toContain('first-skill')
  })

  it('keeps body-only edits out of the catalog and loads the latest body on demand', async () => {
    const home = await tempDir('tool-body-refresh')
    const root = join(home, '.dsh/skills')
    await writeSkill(root, 'body-skill', 'Stable description', 'First body.')
    const ctx = await setup(home)
    const session = Session.create(SessionId('body-refresh'))
    const agent = sessionAgent(session)
    openMessageTurn(session)

    expect(JSON.stringify(await composePrefixForAgent(ctx, agent))).toContain('Stable description')
    await writeSkill(root, 'body-skill', 'Stable description', 'Second body.')
    await fireStep(ctx, agent, 1, 1)
    expect(catalogMessages(session)).toHaveLength(1)

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('body-refresh'),
      name: 'skill',
      arguments: { name: 'body-skill' },
      agent,
    })
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain('Second body.')
    expect(JSON.stringify(result.content)).not.toContain('First body.')
  })

  it('resolves the layered registry as the calling agent sees it', async () => {
    const home = await tempDir('tool-scoped-layer')
    const ctx = await setup(home)
    const { agent, scope } = await mintAgentScope(ctx, '/workspace/scoped')
    const scopedSkills = scope.ctx.get('skills')
    if (scopedSkills === undefined) throw new Error('skills service missing')
    scopedSkills.register({
      name: 'preset-only-skill',
      description: 'Visible to the scoped agent alone',
      source: 'preset',
      content: 'Preset-only body.',
    })

    expect(JSON.stringify(await composePrefixForAgent(ctx, agent))).toContain('preset-only-skill')
    expect(JSON.stringify(await composePrefix(ctx, '/workspace/other'))).not.toContain('preset-only-skill')

    const scoped = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('scoped-load'),
      name: 'skill',
      arguments: { name: 'preset-only-skill' },
      agent,
    })
    expect(scoped.isError).toBe(false)
    expect(JSON.stringify(scoped.content)).toContain('Preset-only body.')

    const foreign = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('foreign-load'),
      name: 'skill',
      arguments: { name: 'preset-only-skill' },
      agent: agentForCwd('/workspace/other'),
    })
    expect(foreign.isError).toBe(true)
    await scope.dispose()
  })

  it('retains the last-good catalog while any provider discovery is incomplete', async () => {
    const home = await tempDir('tool-incomplete-catalog')
    const ctx = await setup(home)
    const disposeStable = ctx.skills.register({
      name: 'stable-skill',
      description: 'Stable skill',
      source: 'runtime',
      content: 'Stable body.',
    })
    const session = Session.create(SessionId('incomplete-catalog'))
    const agent = sessionAgent(session)
    openMessageTurn(session)
    expect(JSON.stringify(await composePrefixForAgent(ctx, agent))).toContain('stable-skill')

    ctx.skills.registerProvider(() => ({
      name: 'failing',
      async list() {
        throw new Error('temporarily unavailable')
      },
      async get() {
        return undefined
      },
    }))
    disposeStable()
    await fireStep(ctx, agent, 1, 1)

    expect(catalogMessages(session)).toHaveLength(1)
  })

  it('keeps default nested-loader catalogs omitted until scoped ownership is enabled', async () => {
    const home = await tempDir('tool-catalog-owner-opt-in')
    const ctx = await setup(home)
    try {
      ctx.skills.register({ name: 'root-skill', description: 'Root skill', source: 'runtime', content: 'Root body.' })
      const { agent, scope } = await mintAgentScope(ctx, '/workspace/nested')
      const isolated = scope.ctx.isolate('skills')
      await isolated.plugin(SkillRegistry)
      isolated.get('skills')!.register({ name: 'nested-skill', description: 'Nested skill', source: 'runtime', content: 'Nested body.' })
      const defaultLoader = await isolated.plugin(toolSkill)
      await fireStep(ctx, agent, 1, 1)
      expect(catalogMessages(agent.session)).toEqual([])
      expect(await composePrefix(ctx, '/workspace/root')).toHaveLength(1)
      const user = createUserMessage({ content: [{ type: 'text', text: '/nested-skill /root-skill' }], source: { kind: 'user' } })
      const decision = await proposeStep(ctx, agent, [user])
      if (decision.kind !== 'enter') throw new Error('expected enter')
      expect(decision.messages.map(message => message.source)).toEqual([
        { kind: 'user' }, { kind: 'skill-invocation', name: 'nested-skill', form: 'instructions' },
      ])

      await defaultLoader.dispose()
      await isolated.plugin(toolSkill, { scopedCatalogOwner: true })
      await fireStep(ctx, agent, 1, 2)
      expect(catalogMessages(agent.session)[0]?.data.source).toEqual({
        kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'nested-skill', description: 'Nested skill' }],
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([false, true])('leaves nested loader catalogs with their visible owner (isolated skills: %s)', async (isolatedSkills) => {
    const home = await tempDir('tool-nested-catalog')
    const ctx = await setup(home)
    try {
      ctx.skills.register({ name: 'root-skill', description: 'Root description', source: 'runtime', content: 'Root body.' })
      const { agent: middleAgent, scope: middleScope } = await mintAgentScope(ctx, '/workspace/middle')
      const middle = isolatedSkills ? middleScope.ctx.isolate('skills') : middleScope.ctx
      if (isolatedSkills) await middle.plugin(SkillRegistry)
      middle.get('skills')!.register({ name: 'middle-skill', description: 'Middle description', source: 'runtime', content: 'Middle body.' })
      await middle.plugin(toolSkill, { catalogDescriptionMaxLength: 6, scopedCatalogOwner: true })
      const { agent, scope } = await mintAgentScope(middle, '/workspace/nested', middleAgent)
      const nested = isolatedSkills ? scope.ctx.isolate('skills') : scope.ctx
      if (isolatedSkills) await nested.plugin(SkillRegistry)
      nested.get('skills')!.register({ name: 'nested-skill', description: 'Nested description', source: 'runtime', content: 'Nested body.' })
      await nested.plugin(toolSkill, { catalogDescriptionMaxLength: 5, scopedCatalogOwner: true })

      expect(ctx.tools.get('skill', agent)).not.toBe(ctx.tools.get('skill', middleAgent))
      expect(ctx.tools.get('skill', middleAgent)).not.toBe(ctx.tools.get('skill'))
      await fireStep(ctx, agent, 1, 1)
      const catalog = catalogMessages(agent.session)
      expect(catalog).toHaveLength(1)
      expect(catalog[0]?.data.source).toEqual({
        kind: 'skill-catalog', form: 'catalog',
        entries: isolatedSkills
          ? [{ name: 'nested-skill', description: 'Ne...' }]
          : [
            { name: 'middle-skill', description: 'Mi...' },
            { name: 'nested-skill', description: 'Ne...' },
            { name: 'root-skill', description: 'Ro...' },
          ],
      })
      await fireStep(ctx, agent, 1, 2)
      expect(catalogMessages(agent.session)).toHaveLength(1)

      await fireStep(ctx, middleAgent, 1, 1)
      expect(catalogMessages(middleAgent.session)[0]?.data.source).toEqual({
        kind: 'skill-catalog', form: 'catalog',
        entries: isolatedSkills
          ? [{ name: 'middle-skill', description: 'Mid...' }]
          : [
            { name: 'middle-skill', description: 'Mid...' },
            { name: 'root-skill', description: 'Roo...' },
          ],
      })
      const rootAgent = agentForCwd('/workspace/root')
      await fireStep(ctx, rootAgent, 1, 1)
      expect(catalogMessages(rootAgent.session)[0]?.data.source).toEqual({
        kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'root-skill', description: 'Root description' }],
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(['restriction', 'shadow'] as const)('retires a published nested catalog after a %s', async (hiddenBy) => {
    const home = await tempDir('tool-nested-catalog-hidden')
    const ctx = await setup(home)
    try {
      ctx.skills.register({ name: 'root-skill', description: 'Root skill', source: 'runtime', content: 'Root body.' })
      const { agent: ownerAgent, scope } = await mintAgentScope(ctx, '/workspace/nested')
      const isolated = scope.ctx.isolate('skills')
      await isolated.plugin(SkillRegistry)
      isolated.get('skills')!.register({ name: 'nested-skill', description: 'Nested skill', source: 'runtime', content: 'Nested body.' })
      await isolated.plugin(toolSkill, { scopedCatalogOwner: true })
      const { agent, scope: consumerScope } = await mintAgentScope(
        isolated, sessionAgent(ownerAgent.session, 'nested-catalog-reader'), ownerAgent,
      )
      await fireStep(ctx, agent, 1, 1)
      expect(catalogMessages(agent.session)[0]?.data.source).toMatchObject({ entries: [{ name: 'nested-skill' }] })

      let restore: () => void
      if (hiddenBy === 'restriction') restore = consumerScope.ctx.tools.restrict({ deny: ['skill'] })
      else restore = consumerScope.ctx.tools.register(defineContentToolFixture({
        name: 'skill', description: 'Unrelated skill consumer.', parameters: {},
        execute: () => Promise.resolve([{ type: 'text', text: 'shadow' }]),
      }))
      await fireStep(ctx, agent, 1, 2)
      const catalogs = catalogMessages(agent.session)
      expect(catalogs).toHaveLength(2)
      expect(catalogs[1]?.data.source).toEqual({ kind: 'skill-catalog', form: 'catalog', update: true, entries: [] })
      expect(JSON.stringify(catalogs[1]?.data.content)).toContain('Do not use names from earlier skill catalogs')
      await fireStep(ctx, agent, 1, 3)
      expect(catalogMessages(agent.session)).toHaveLength(2)
      const user = createUserMessage({ content: [{ type: 'text', text: '/nested-skill /root-skill' }], source: { kind: 'user' } })
      expect(await proposeStep(ctx, agent, [user])).toEqual({ kind: 'enter', messages: [user] })
      restore()
      await fireStep(ctx, agent, 1, 4)
      expect(catalogMessages(agent.session).at(-1)?.data.source).toMatchObject({ update: true, entries: [{ name: 'nested-skill' }] })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('restores root ownership after loader disposal and publishes fresh isolated catalogs on remount', async () => {
    const home = await tempDir('tool-catalog-owner-remount')
    const ctx = await setup(home)
    try {
      ctx.skills.register({ name: 'root-skill', description: 'Root skill', source: 'runtime', content: 'Root body.' })
      const { agent, scope } = await mintAgentScope(ctx, '/workspace/nested')
      const isolated = scope.ctx.isolate('skills')
      await isolated.plugin(SkillRegistry)
      const removeSkill = isolated.get('skills')!.register({
        name: 'nested-skill', description: 'Nested skill', source: 'runtime', content: 'Nested body.',
      })
      const loader = await isolated.plugin(toolSkill, { scopedCatalogOwner: true })
      const originalTool = ctx.tools.get('skill', agent)
      const rootTool = ctx.tools.get('skill')
      await fireStep(ctx, agent, 1, 1)
      expect(catalogMessages(agent.session)[0]?.data.source).toMatchObject({ entries: [{ name: 'nested-skill' }] })

      await loader.dispose()
      expect(ctx.tools.get('skill', agent)).toBe(rootTool)
      await fireStep(ctx, agent, 1, 2)
      expect(catalogMessages(agent.session)[1]?.data.source).toMatchObject({ update: true, entries: [{ name: 'root-skill' }] })

      await isolated.plugin(toolSkill, { scopedCatalogOwner: true })
      expect(ctx.tools.get('skill', agent)).not.toBe(originalTool)
      expect(ctx.tools.get('skill', agent)).not.toBe(rootTool)
      await fireStep(ctx, agent, 1, 3)
      expect(catalogMessages(agent.session)[2]?.data.source).toMatchObject({ update: true, entries: [{ name: 'nested-skill' }] })
      removeSkill()
      await fireStep(ctx, agent, 1, 4)
      expect(catalogMessages(agent.session)[3]?.data.source).toEqual({
        kind: 'skill-catalog', form: 'catalog', update: true, entries: [],
      })
      await fireStep(ctx, agent, 1, 5)
      expect(catalogMessages(agent.session)).toHaveLength(4)

      await scope.dispose()
      expect(ctx.tools.get('skill', agent)).toBe(rootTool)
      await fireStep(ctx, agent, 1, 6)
      expect(catalogMessages(agent.session)[4]?.data.source).toMatchObject({ update: true, entries: [{ name: 'root-skill' }] })

      const { scope: freshScope } = await mintAgentScope(ctx, agent)
      const fresh = freshScope.ctx.isolate('skills')
      await fresh.plugin(SkillRegistry)
      fresh.get('skills')!.register({ name: 'fresh-skill', description: 'Fresh skill', source: 'runtime', content: 'Fresh body.' })
      await fresh.plugin(toolSkill, { scopedCatalogOwner: true })
      await fireStep(ctx, agent, 1, 7)
      expect(catalogMessages(agent.session)[5]?.data.source).toEqual({
        kind: 'skill-catalog', form: 'catalog', update: true, entries: [{ name: 'fresh-skill', description: 'Fresh skill' }],
      })
      expect(catalogMessages(agent.session)).toHaveLength(6)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not leave a disposed loader definition eligible to own a catalog', async () => {
    const home = await tempDir('tool-catalog-inactive-owner')
    const ctx = await setup(home)
    try {
      ctx.skills.register({ name: 'root-skill', description: 'Root skill', source: 'runtime', content: 'Root body.' })
      const { agent, scope } = await mintAgentScope(ctx, '/workspace/nested')
      const isolated = scope.ctx.isolate('skills')
      await isolated.plugin(SkillRegistry)
      isolated.get('skills')!.register({ name: 'nested-skill', description: 'Nested skill', source: 'runtime', content: 'Nested body.' })
      const loader = await isolated.plugin(toolSkill, { scopedCatalogOwner: true })
      const retiredTool = ctx.tools.get('skill', agent)
      if (retiredTool === undefined) throw new Error('expected scoped loader')
      await fireStep(ctx, agent, 1, 1)
      await loader.dispose()
      scope.ctx.tools.register(retiredTool)

      await fireStep(ctx, agent, 1, 2)
      expect(catalogMessages(agent.session).at(-1)?.data.source).toEqual({
        kind: 'skill-catalog', form: 'catalog', update: true, entries: [],
      })
      const user = createUserMessage({ content: [{ type: 'text', text: '/nested-skill /root-skill' }], source: { kind: 'user' } })
      expect(await proposeStep(ctx, agent, [user])).toEqual({ kind: 'enter', messages: [user] })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(['restriction', 'shadow', 'replacement'] as const)('handles a %s during discovery without publishing a stale catalog', async (change) => {
    const home = await tempDir('tool-catalog-visibility-race')
    const ctx = await setup(home)
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    try {
      ctx.skills.register({ name: 'root-skill', description: 'Root skill', source: 'runtime', content: 'Root body.' })
      const { agent: ownerAgent, scope: ownerScope } = await mintAgentScope(ctx, '/workspace')
      const owner = ownerScope.ctx.isolate('skills')
      await owner.plugin(SkillRegistry)
      owner.get('skills')!.register({ name: 'nested-skill', description: 'Nested skill', source: 'runtime', content: 'Nested body.' })
      await owner.plugin(toolSkill, { scopedCatalogOwner: true })
      const { agent, scope } = await mintAgentScope(owner, sessionAgent(ownerAgent.session, 'racing-catalog-reader'), ownerAgent)
      await fireStep(ctx, agent, 1, 1)
      owner.get('skills')!.registerProvider(() => ({
        name: 'deferred-discovery',
        async list() {
          started.resolve(undefined)
          await release.promise
          return [{
            name: 'racing-skill', description: 'Must not be published after visibility changes.', source: 'runtime',
            provider: 'deferred-discovery', rank: 1, locator: 'racing-skill',
            invocation: { modelInvocable: true, userInvocable: true },
          }]
        },
        get: () => Promise.resolve(undefined),
      }))
      const pending = fireStep(ctx, agent, 1, 2)
      await started.promise
      if (change === 'restriction') scope.ctx.tools.restrict({ deny: ['skill'] })
      else if (change === 'shadow') scope.ctx.tools.register(defineContentToolFixture({
        name: 'skill', description: 'Unrelated skill consumer.', parameters: {},
        execute: () => Promise.resolve([{ type: 'text', text: 'shadow' }]),
      }))
      else {
        const isolated = scope.ctx.isolate('skills')
        await isolated.plugin(SkillRegistry)
        isolated.get('skills')!.register({
          name: 'replacement-skill', description: 'Replacement skill', source: 'runtime', content: 'Replacement body.',
        })
        await isolated.plugin(toolSkill, { scopedCatalogOwner: true })
      }
      release.resolve(undefined)
      await pending

      const catalogs = catalogMessages(agent.session)
      expect(catalogs).toHaveLength(change === 'replacement' ? 1 : 2)
      if (change !== 'replacement') {
        expect(catalogs[1]?.data.source).toEqual({ kind: 'skill-catalog', form: 'catalog', update: true, entries: [] })
      }
      expect(JSON.stringify(catalogs)).not.toContain('racing-skill')
      await fireStep(ctx, agent, 1, 3)
      expect(catalogMessages(agent.session)).toHaveLength(2)
      if (change === 'replacement') {
        expect(catalogMessages(agent.session)[1]?.data.source).toEqual({
          kind: 'skill-catalog', form: 'catalog', update: true,
          entries: [{ name: 'replacement-skill', description: 'Replacement skill' }],
        })
      }
    } finally {
      release.resolve(undefined)
      await ctx.fiber.dispose()
    }
  })

  it('omits catalog guidance when the calling agent restricts away the shipped skill tool', async () => {
    const home = await tempDir('tool-restricted-catalog')
    const ctx = await setup(home)
    ctx.skills.register({ name: 'listed-skill', description: 'Listed', source: 'runtime', content: 'body' })
    const session = Session.create(SessionId('restricted-catalog'))
    const agent = sessionAgent(session)
    openMessageTurn(session)
    const { scope } = await mintAgentScope(ctx, agent)
    scope.ctx.tools.restrict({ deny: ['skill'] })

    expect(ctx.tools.get('skill', agent)).toBeUndefined()
    await composePrefixForAgent(ctx, agent)
    expect(catalogMessages(session)).toEqual([])
    await fireStep(ctx, agent, 1, 1)
    expect(catalogMessages(session)).toEqual([])
    expect(await composePrefix(ctx, '/workspace')).toHaveLength(1)
    await scope.dispose()
  })

  it('does not attach shipped catalog guidance to a scoped same-name tool shadow', async () => {
    const home = await tempDir('tool-shadowed-catalog')
    const ctx = await setup(home)
    ctx.skills.register({ name: 'listed-skill', description: 'Listed', source: 'runtime', content: 'body' })
    const { agent, scope } = await mintAgentScope(ctx, '/workspace')
    scope.ctx.tools.register(defineContentToolFixture({
      name: 'skill',
      description: 'A scoped tool with unrelated semantics.',
      parameters: {},
      execute() {
        return Promise.resolve([{ type: 'text', text: 'shadow' }])
      },
    }))

    expect(ctx.tools.get('skill', agent)).not.toBe(ctx.tools.get('skill'))
    expect(await composePrefixForAgent(ctx, agent)).toEqual([])
    expect(await composePrefix(ctx, '/workspace')).toHaveLength(1)
    await scope.dispose()
  })

  it('validates the catalog description cap', async () => {
    const home = await tempDir('tool-invalid-catalog-cap')
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { dshHome: join(home, '.dsh'), museHome: join(home, '.muse'), agentsHome: join(home, '.agents'), watch: false })

    await expect(ctx.plugin(toolSkill, { catalogDescriptionMaxLength: 2 })).rejects.toThrow('greater than or equal to 3')
  })

  it('loads a skill for the calling agent cwd', async () => {
    const home = await tempDir('tool-load')
    const project = await tempDir('tool-project')
    await mkdir(join(project, '.git'), { recursive: true })
    await writeSkill(join(project, '.dsh/skills'), 'project-skill', 'Project skill', 'Project instructions.')
    const ctx = await setup(home)

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('c1'),
      name: 'skill',
      arguments: { name: 'project-skill' },
      agent: { session: { header: { cwd: project } } } as never,
    })

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected skill success')
    expect(result.value).toEqual({
      name: 'project-skill',
      provider: 'filesystem',
      resourceBase: { kind: 'directory', path: join(project, '.dsh/skills/project-skill') },
      content: 'Project instructions.',
    })
    const block = result.content[0]
    expect(block?.type).toBe('text')
    if (block?.type !== 'text') throw new Error('expected text skill result')
    expect(block.text).toBe([
      '<skill_content name="project-skill">',
      '<skill_resources>',
      `Base directory for this skill: ${join(project, '.dsh/skills/project-skill')}`,
      'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
      '</skill_resources>',
      '',
      '<skill_instructions>',
      'Project instructions.',
      '</skill_instructions>',
      '</skill_content>',
    ].join('\n'))
    expect(block.text).not.toContain('# Skill:')
  })

  it('renders provider-managed resource hints for non-local skills', async () => {
    const home = await tempDir('tool-resource-hints')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'opaque-skill',
      description: 'Opaque skill',
      source: 'runtime',
      provider: 'runtime',
      resourceBase: { kind: 'opaque', description: 'runtime memory' },
      content: 'Opaque instructions.',
    })
    ctx.skills.register({
      name: 'url-skill',
      description: 'URL skill',
      source: 'runtime',
      provider: 'runtime',
      resourceBase: { kind: 'url', url: 'https://skills.example.test/url-skill' },
      content: 'URL instructions.',
    })
    ctx.skills.register({
      name: 'provider-skill',
      description: 'Provider skill',
      source: 'runtime',
      provider: 'runtime',
      content: 'Provider instructions.',
    })

    const opaque = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c2'), name: 'skill', arguments: { name: 'opaque-skill' } })
    const url = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c3'), name: 'skill', arguments: { name: 'url-skill' } })
    const provider = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c4'), name: 'skill', arguments: { name: 'provider-skill' } })

    if (opaque.content[0]?.type !== 'text' || url.content[0]?.type !== 'text' || provider.content[0]?.type !== 'text') {
      throw new Error('expected text tool results')
    }
    expect(opaque.content[0].text).toContain('<skill_resources>\nResources for this skill: runtime memory\nLoad referenced resources only as needed.\n</skill_resources>')
    expect(url.content[0].text).toContain('<skill_resources>\nBase URL for this skill: https://skills.example.test/url-skill\nResolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.\n</skill_resources>')
    expect(provider.content[0].text).toContain('<skill_resources>\nResources for this skill are managed by provider "runtime".\nLoad referenced resources only as needed.\n</skill_resources>')
  })

  it('rejects an unknown resource-base kind at the canonical output boundary', async () => {
    const home = await tempDir('tool-resource-assert-never')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'rogue-resource-skill',
      description: 'Rogue resource skill',
      source: 'runtime',
      provider: 'runtime',
      resourceBase: { kind: 'future' } as never,
      content: 'Rogue instructions.',
    })

    const result = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c5'), name: 'skill', arguments: { name: 'rogue-resource-skill' } })

    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('INVALID_TOOL_OUTPUT')
    const block = result.content[0]
    if (block?.type !== 'text') throw new Error('expected text tool result')
    expect(block.text).toContain('value.resourceBase')
  })

  it('returns isError for unknown, invalid, and model-disabled skills', async () => {
    const home = await tempDir('tool-errors')
    await writeSkill(join(home, '.dsh/skills'), 'hidden-skill', 'Hidden skill', 'Hidden instructions.')
    await writeFile(join(home, '.dsh/skills/hidden-skill/SKILL.md'), '---\nname: hidden-skill\ndescription: Hidden skill\ndisable-model-invocation: true\n---\n\nHidden instructions.\n')
    const ctx = await setup(home)
    ctx.skills.register({
      name: 'model-only-skill',
      description: 'Model-only skill',
      invocation: { modelInvocable: true, userInvocable: false },
      source: 'runtime',
      content: 'Model-only instructions.',
    })

    const unknown = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c1'), name: 'skill', arguments: { name: 'missing' } })
    const invalid = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c2'), name: 'skill', arguments: { name: 'Bad_Name' } })
    const disabled = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c3'), name: 'skill', arguments: { name: 'hidden-skill' } })
    const modelOnly = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c4'), name: 'skill', arguments: { name: 'model-only-skill' } })

    expect(unknown.isError).toBe(true)
    expect(invalid.isError).toBe(true)
    expect(disabled.isError).toBe(true)
    expect(modelOnly.isError).toBe(false)
    const unknownBlock = unknown.content[0]
    if (unknownBlock?.type !== 'text') throw new Error('expected text tool result')
    expect(unknownBlock.text).toContain('skill "missing" is unknown or no longer available')
  })

  it('checks model policy before provider loading and rechecks the loaded definition', async () => {
    const home = await tempDir('tool-policy-before-load')
    const ctx = await setup(home)
    const getCalls: string[] = []
    ctx.skills.registerProvider(() => ({
      name: 'policy-probe',
      async list() {
        return [
          {
            name: 'denied-skill',
            description: 'Denied skill',
            invocation: { modelInvocable: false, userInvocable: true },
            provider: 'policy-probe',
            source: 'test',
            rank: 1,
            locator: 'denied-skill',
          },
          {
            name: 'policy-race-skill',
            description: 'Policy race skill',
            invocation: { modelInvocable: true, userInvocable: true },
            provider: 'policy-probe',
            source: 'test',
            rank: 1,
            locator: 'policy-race-skill',
          },
          {
            name: 'vanishing-skill',
            description: 'Vanishing skill',
            invocation: { modelInvocable: true, userInvocable: true },
            provider: 'policy-probe',
            source: 'test',
            rank: 1,
            locator: 'vanishing-skill',
          },
        ]
      },
      async get(candidate) {
        getCalls.push(candidate.name)
        if (candidate.name === 'vanishing-skill') return undefined
        return {
          ...candidate,
          invocation: { modelInvocable: false, userInvocable: true },
          content: 'Instructions must not be disclosed.',
        }
      },
    }))

    const denied = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c6'), name: 'skill', arguments: { name: 'denied-skill' } })
    const raced = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c7'), name: 'skill', arguments: { name: 'policy-race-skill' } })
    const vanished = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c8'), name: 'skill', arguments: { name: 'vanishing-skill' } })

    expect(denied.isError).toBe(true)
    expect(raced.isError).toBe(true)
    expect(vanished.isError).toBe(true)
    expect(getCalls).toEqual(['policy-race-skill', 'vanishing-skill'])
    for (const result of [denied, raced]) {
      const block = result.content[0]
      if (block?.type !== 'text') throw new Error('expected text tool result')
      expect(block.text).toContain('is not available for model invocation')
      expect(block.text).not.toContain('Instructions must not be disclosed.')
    }
    const vanishedBlock = vanished.content[0]
    if (vanishedBlock?.type !== 'text') throw new Error('expected text tool result')
    expect(vanishedBlock.text).toContain('skill "vanishing-skill" is unknown or no longer available')
  })
})

describe('user-explicit invocation injection', () => {
  async function writePolicySkill(root: string, name: string, description: string, policy: string, body: string): Promise<void> {
    const dir = join(root, name)
    await mkdir(dir, { recursive: true })
    const policyLines = policy === '' ? '' : `${policy}\n`
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n${policyLines}---\n\n${body}\n`)
  }

  function gesture(text: string): UserMessage {
    return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  }

  async function invokeHarness(): Promise<{ ctx: Context; agent: Agent }> {
    const home = await tempDir('invoke')
    const skillsRoot = join(home, '.agents', 'skills')
    await writePolicySkill(skillsRoot, 'hidden-demo', 'User-only demo', 'disable-model-invocation: true', 'Say the magic word: PINEAPPLE.')
    await writePolicySkill(skillsRoot, 'shared-skill', 'Ordinary skill', '', 'Shared instructions.')
    await writePolicySkill(skillsRoot, 'model-only-skill', 'Model only', 'user-invocable: false', 'Model-only instructions.')
    const ctx = await setup(home)
    return { ctx, agent: agentForCwd(home) }
  }

  it('does not inject explicit skills when its exact tool is restricted or shadowed', async () => {
    for (const hiddenBy of ['restriction', 'shadow'] as const) {
      const { ctx, agent } = await invokeHarness()
      try {
        const { scope } = await mintAgentScope(ctx, agent)
        if (hiddenBy === 'restriction') scope.ctx.tools.restrict({ deny: ['skill'] })
        else scope.ctx.tools.register(defineContentToolFixture({
          name: 'skill', description: 'Different skill consumer.', parameters: {},
          execute: () => Promise.resolve([{ type: 'text', text: 'shadow' }]),
        }))
        const first = gesture('/hidden-demo /shared-skill')
        const decision = await proposeStep(ctx, agent, [first])
        expect(decision).toEqual({ kind: 'enter', messages: [first] })
      } finally {
        await ctx.fiber.dispose()
      }
    }
  })

  it('uses only the isolated scoped skill consumer for explicit invocation', async () => {
    const { ctx, agent } = await invokeHarness()
    try {
      ctx.skills.register({
        name: 'authoring-skill', description: 'Host authoring skill.', source: 'runtime',
        content: 'Start a separate authoring agent.',
      })
      const { scope } = await mintAgentScope(ctx, agent)
      const isolated = scope.ctx.isolate('skills')
      await isolated.plugin(SkillRegistry)
      const skills = isolated.get('skills')!
      skills.register({
        name: 'shared-skill', description: 'Scoped shared skill.', source: 'runtime',
        content: 'Scoped source-reading instructions.',
      })
      skills.register({
        name: 'creation-only', description: 'Scoped user-only skill.', source: 'runtime',
        invocation: { modelInvocable: false, userInvocable: true }, content: 'Scoped user-only instructions.',
      })
      await isolated.plugin(toolSkill)
      const decision = await proposeStep(ctx, agent, [gesture('/authoring-skill /hidden-demo /shared-skill /creation-only')])
      if (decision.kind !== 'enter') throw new Error('expected enter')
      const injections = decision.messages.filter(message => message.source.kind === 'skill-invocation')
      expect(injections.map(message => message.source)).toEqual([
        { kind: 'skill-invocation', name: 'shared-skill', form: 'instructions' },
        { kind: 'skill-invocation', name: 'creation-only', form: 'instructions' },
      ])
      const rendered = JSON.stringify(injections)
      expect(rendered).toContain('Scoped source-reading instructions.')
      expect(rendered).toContain('Scoped user-only instructions.')
      expect(rendered).not.toContain('Start a separate authoring agent.')
      expect(rendered).not.toContain('PINEAPPLE')
      expect(rendered).not.toContain('Shared instructions.')
      const globalDecision = await proposeStep(ctx, agentForCwd(agent.session.header.cwd!), [gesture('/authoring-skill')])
      expect(JSON.stringify(globalDecision)).toContain('Start a separate authoring agent.')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('discards an explicit skill load when its tool becomes hidden while loading', async () => {
    const { ctx, agent } = await invokeHarness()
    try {
      const { scope } = await mintAgentScope(ctx, agent)
      ctx.skills.registerProvider(() => ({
        name: 'visibility-race',
        list: () => Promise.resolve([{
          name: 'racing-skill', description: 'Changing visibility.', source: 'runtime', provider: 'visibility-race',
          rank: 1, locator: 'racing-skill', invocation: { modelInvocable: true, userInvocable: true },
        }]),
        get(candidate) {
          scope.ctx.tools.restrict({ deny: ['skill'] })
          return Promise.resolve({ ...candidate, content: 'This body must not be injected.' })
        },
      }))
      const decision = await proposeStep(ctx, agent, [gesture('/racing-skill')])
      if (decision.kind !== 'enter') throw new Error('expected enter')
      expect(decision.messages.some(message => message.source.kind === 'skill-invocation')).toBe(false)
      expect(JSON.stringify(decision)).not.toContain('This body must not be injected.')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('injects a user-invocable skill named by a leading /token, after every other injection', async () => {
    const { ctx, agent } = await invokeHarness()
    const first = gesture('/hidden-demo what does this do')
    const second = gesture('plain follow-up prose')
    const decision = await proposeStep(ctx, agent, [first, second])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    const kinds = decision.messages.map(message => (message.source as { kind: string }).kind)
    // Background injections (the catalog here) sit between the claimed batch
    // and the invoked body: the material the model must act on comes last.
    expect(kinds.slice(0, 2)).toEqual(['user', 'user'])
    expect(kinds.at(-1)).toBe('skill-invocation')
    expect(kinds.indexOf('skill-catalog')).toBeLessThan(kinds.indexOf('skill-invocation'))
    const injection = decision.messages.at(-1)!
    expect(injection.source).toMatchObject({ kind: 'skill-invocation', name: 'hidden-demo', form: 'instructions' })
    const block = injection.content[0]
    if (block?.type !== 'text') throw new Error('expected text injection')
    expect(block.text).toContain('<skill_content name="hidden-demo">')
    expect(block.text).toContain('Say the magic word: PINEAPPLE.')
    expect(block.text).not.toContain('what does this do')
  })

  it('injects an ordinary skill the same way (one uniform user-explicit path)', async () => {
    const { ctx, agent } = await invokeHarness()
    const decision = await proposeStep(ctx, agent, [gesture('/shared-skill go')])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(decision.messages.some(message =>
      (message.source as { kind?: string; name?: string }).kind === 'skill-invocation'
      && (message.source as { name?: string }).name === 'shared-skill')).toBe(true)
  })

  it('recognizes a mid-sentence gesture but not paths, fractions, or broken boundaries', async () => {
    const { ctx, agent } = await invokeHarness()
    const decision = await proposeStep(ctx, agent, [
      gesture('please use /hidden-demo to answer this'),
    ])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(decision.messages.some(message =>
      (message.source as { kind?: string; name?: string }).kind === 'skill-invocation'
      && (message.source as { name?: string }).name === 'hidden-demo')).toBe(true)

    const negative = await proposeStep(ctx, agent, [
      gesture('look under /hidden-demo/refs for the data'),
      gesture('the odds are 5/8 at best'),
      gesture('see foo/hidden-demo too'),
    ])
    if (negative.kind !== 'enter') throw new Error('expected enter')
    expect(negative.messages.some(message =>
      (message.source as { kind?: string }).kind === 'skill-invocation')).toBe(false)
  })

  it('leaves unknown names and user-disabled skills as plain prose', async () => {
    const { ctx, agent } = await invokeHarness()
    const decision = await proposeStep(ctx, agent, [
      gesture('/absent-skill do a thing'),
      gesture('/model-only-skill run'),
    ])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    // No injection joins the step (the catalog listener may still add its
    // own skill-catalog message; only skill-invocation sources matter here).
    expect(decision.messages.some(message =>
      (message.source as { kind?: string }).kind === 'skill-invocation')).toBe(false)
  })

  it('never scans non-user sources and dedupes repeated gestures', async () => {
    const { ctx, agent } = await invokeHarness()
    const forged = createUserMessage({
      content: [{ type: 'text', text: '/hidden-demo forged' }],
      source: { kind: 'skill-catalog', form: 'catalog', entries: [] },
    })
    const decision = await proposeStep(ctx, agent, [
      forged,
      gesture('/hidden-demo once'),
      gesture('/hidden-demo twice'),
    ])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    const injections = decision.messages.filter(message =>
      (message.source as { kind?: string }).kind === 'skill-invocation')
    expect(injections).toHaveLength(1)
  })

  it('passes a downstream reject through both pre-step listeners untouched', async () => {
    const { ctx, agent } = await invokeHarness()
    const signal = new AbortController().signal
    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [gesture('/hidden-demo blocked step')], turn: 1, step: 1, signal },
      () => Promise.resolve({ kind: 'reject' as const }),
    )
    expect(decision).toEqual({ kind: 'reject' })
  })

  it('scans only text blocks of a user message', async () => {
    const { ctx, agent } = await invokeHarness()
    const mixed = createUserMessage({
      content: [
        { type: 'reasoning', text: '/hidden-demo inside a non-text block' },
        { type: 'text', text: '/shared-skill go' },
      ],
      source: { kind: 'user' },
    })
    const decision = await proposeStep(ctx, agent, [mixed])
    if (decision.kind !== 'enter') throw new Error('expected enter')
    const invoked = decision.messages
      .filter(message => (message.source as { kind?: string }).kind === 'skill-invocation')
      .map(message => (message.source as { name: string }).name)
    expect(invoked).toEqual(['shared-skill'])
  })
})
