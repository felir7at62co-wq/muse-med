/** Real Loader, discovery, Agent, and stdio composition without desktop interaction. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import ComputerUse from '@deepseek-ai/dsh-computer-use'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Llm, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Agents from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Projections from '@deepseek-ai/dsh-session-projection'
import Attachments from '@deepseek-ai/dsh-attachment-local'
import * as Discovery from '@deepseek-ai/dsh-tool-discovery'
import * as Provider from '../src/computer-use.ts'


const input = vi.hoisted(() => ({
  state: { available: true, epoch: 0, escapeEpoch: 0, idleMs: 10_000 },
  listeners: new Set<() => void>(),
  samples: 0,
  states: [] as string[],
  activeReady: undefined as Promise<void> | undefined,
}))
vi.mock('../src/computer-input-monitor.ts', () => ({
  createPhysicalInputMonitor: () => ({
    sample: () => { input.samples++; return input.state },
    subscribe(listener: () => void) { input.listeners.add(listener); return () => { input.listeners.delete(listener) } },
    async close() {},
  }),
}))
vi.mock('../src/computer-control.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/computer-control.ts')>(),
  createComputerStatePublisher: () => ({
    async publish(state: string) { input.states.push(state); if (state === 'active') await input.activeReady },
    close() {},
  }),
}))

const TOOL = 'mcp__muse-computer__screenshot'
const MODULE = '@deepseek-ai/dsh-desktop-host/computer-use'
const driver = fileURLToPath(new URL('./fixtures/computer-use/driver.mjs', import.meta.url))

const computerTool = (name: string): string => 'mcp__muse-computer__' + name
const BASIC_TOOLS = ['list_windows', 'launch_app', 'get_window_state', 'click', 'type_text', 'press_key', 'verify_state', 'end_session'].map(computerTool)
const windowList = z.object({ windows: z.array(z.object({ pid: z.number(), window_id: z.number(), app_name: z.string() })) })
const windowSnapshot = z.object({
  pid: z.number(), window_id: z.number(), snapshot_id: z.string(),
  elements: z.array(z.object({ element_index: z.number(), element_token: z.string(), role: z.string(), label: z.string() })),
})

function lastStructuredResult(request: GenerateOptions): unknown {
  const result = request.messages.findLast(message => message.role === 'tool')
  const metadata = result?.content.filter(block => block.type === 'text').at(-1)
  if (metadata?.type !== 'text') throw new Error('Missing model-visible structured result')
  const value: unknown = JSON.parse(metadata.text)
  return value
}

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  input.state = { available: true, epoch: 0, escapeEpoch: 0, idleMs: 10_000 }
  input.states.length = 0
  input.activeReady = undefined
  await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(async root => rm(root, { recursive: true, force: true })))
  vi.unstubAllEnvs()
})

interface ModelCall { name: string; args: Record<string, unknown> }

class DesktopModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly calls: Array<ModelCall | ((request: GenerateOptions) => ModelCall) | undefined> = []

  constructor(private readonly vision: boolean) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: this.vision ? ['text', 'image'] : ['text'] })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const planned = this.calls.shift()
    const call = typeof planned === 'function' ? planned(options) : planned
    if (call) {
      const id = ToolCallId('desktop-call-' + String(this.requests.length))
      const args = JSON.stringify(call.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: call.name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: call.name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Inspected current desktop state.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Inspected current desktop state.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

interface LoadOptions { mode?: 'fail'; vision?: boolean; missing?: boolean; defer?: boolean }

async function load(options: LoadOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'muse-computer-use-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  const model = new DesktopModel(options.vision ?? true)
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-computer-use', ComputerUse],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', Tools],
    ['@deepseek-ai/dsh-llm', Llm],
    ['@deepseek-ai/dsh-session', Sessions],
    ['@deepseek-ai/dsh-agent', Agents],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-session-projection', Projections],
    ['@deepseek-ai/dsh-attachment-local', Attachments],
    ['@deepseek-ai/dsh-tool-discovery', Discovery],
    ['@fixture/model', { inject: ['llm'], apply(inner: Context) { inner.effect(() => inner.llm.registerAdapter(['fixture'], model)) } }],
    [MODULE, Provider],
  ])
  const driverConfig = {
    command: options.missing ? join(root, 'missing-cua-driver') : process.execPath,
    args: [driver, root, ...(options.mode === undefined ? [] : [options.mode])],
  }
  const config = join(root, 'cordis.yml')
  await writeFile(config, JSON.stringify([...modules.keys()]
    .filter(name => !options.defer || name !== MODULE)
    .map(name => ({
      id: name === MODULE ? 'computer-use-driver' : undefined,
      name,
      config: name === MODULE ? driverConfig
        : name === '@deepseek-ai/dsh-attachment-local' ? { dshHome: root }
          : name === '@deepseek-ai/dsh-agent-loop' ? { agents: [] }
            : name === '@deepseek-ai/dsh-tool-discovery' ? {
              alwaysLoad: [],
              keywords: { [TOOL]: ['电脑截图', '屏幕', '桌面'] },
              capabilities: [{ id: 'computer', title: '电脑操作', description: '查看窗口并操作当前电脑。', tools: ['mcp__muse-computer__*'] }],
            } : {},
    }))))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2', loadCache: new Map(),
    register() { throw new Error('Unexpected loader hooks') },
    getOrCreateModuleJob() { throw new Error('Unexpected loader job') },
    resolveSync() { throw new Error('Unexpected loader resolution') },
    load() { throw new Error('Unexpected loader load') },
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error('Unexpected Loader import: ' + specifier)
      return modules.get(specifier)
    },
  }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  for (const row of ctx.loader.entries()) await row.fiber?.await()
  return { ctx, root, model, driverConfig }
}

async function send(agent: Agent): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '查看当前电脑窗口。' }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

interface DriverEvent {
  event: string
  pid: number
  name?: string
  arguments?: unknown
  permissionMode?: string
  telemetryEnabled?: string
}

async function driverEvents(root: string): Promise<DriverEvent[]> {
  return (await readFile(join(root, 'driver.ndjson'), 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line) as DriverEvent)
}

async function createAgent(ctx: Context, id: string): Promise<Agent> {
  return ctx.agentLoop.create(SessionId(id), { provider: 'fixture', model: 'desktop-fixture' })
}

function expectProcessExited(pid: number): void {
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
}

describe('Muse bundled computer tools', () => {
  it('discovers desktop tools in Chinese and passes durable screenshots into the next model request', async () => {
    vi.stubEnv('CUA_DRIVER_PERMISSION_MODE', 'unrestricted')
    vi.stubEnv('CUA_DRIVER_RS_TELEMETRY_ENABLED', 'true')
    const { ctx, root, model } = await load()
    const starts = (await driverEvents(root)).filter(event => event.event === 'start')
    expect(starts.length).toBeGreaterThan(0)
    expect(starts.every(event => event.permissionMode === 'standard')).toBe(true)
    expect(starts.every(event => event.telemetryEnabled === 'false')).toBe(true)
    const agent = await createAgent(ctx, 'muse-computer-vision')
    model.calls.push({ name: 'tool_search', args: { query: '电脑截图', limit: 1 } }, { name: TOOL, args: { display: 0 } })
    await send(agent)
    expect(model.requests).toHaveLength(3)
    expect(model.requests[0]?.tools?.map(tool => tool.name)).not.toContain(TOOL)
    expect(model.requests[1]?.tools?.find(tool => tool.name === TOOL)).toMatchObject({
      description: 'Capture the selected display.',
      parameters: { type: 'object', properties: { display: { type: 'integer', minimum: 0 } }, required: ['display'], additionalProperties: false },
    })
    const prompt = (await ctx.systemPrompt.assemble({ agent, scope: agent })).sections
      .find(section => section.name === 'computer-use:muse')
    expect(prompt?.text).toContain('Do not guess screenshot coordinates')
    expect(prompt?.text).toContain('load the basic tools in one tool_context call')
    expect(prompt?.text).toContain('Never use targetless scope:"desktop" input')
    expect(prompt?.text).toContain('include_accessibility_tree:false')
    expect(prompt?.text).toContain('end_session')
    expect(prompt?.text).toContain('Windows x64')
    expect(prompt?.text).not.toContain('macOS')
    expect(prompt?.text).toMatchSnapshot()
    const result = agent.session.snapshotEvents().findLast(event => event.type === 'tool/result')
    if (result?.type !== 'tool/result') throw new Error('Missing desktop screenshot result')
    expect(result.data.message.content[0]).toEqual({ type: 'text', text: 'Display 0' })
    expect(result.data.message.content.filter(block => block.type === 'image')).toHaveLength(1)
    const image = result.data.message.content.find(block => block.type === 'image')
    if (image?.type !== 'image') throw new Error('Missing durable screenshot')
    expect(await ctx.attachments.readImage(image.attachment)).toMatchObject({ ref: { width: 1, height: 1, mediaType: 'image/png' } })
    expect(JSON.stringify(agent.session.snapshotEvents())).not.toContain('iVBORw0KGgo')
    expect(model.requests[2]?.messages.filter(message => message.role === 'tool').at(-1)).toEqual(result.data.message)
    expect(await driverEvents(root)).toContainEqual(expect.objectContaining({ event: 'call', name: 'screenshot', arguments: { display: 0 } }))
  }, 20_000)


  it('loads the basic group once and forwards snapshot-derived window targets into native input', async () => {
    const { ctx, root, model } = await load()
    const agent = await createAgent(ctx, 'muse-computer-window-input')
    const session = 'window-input-regression'
    model.calls.push(
      { name: 'tool_context', args: { operation: 'load', tools: BASIC_TOOLS } },
      { name: computerTool('list_windows'), args: {} },
      (request) => {
        const listed = windowList.parse(lastStructuredResult(request))
        const window = listed.windows.find(candidate => candidate.app_name === 'Notepad')
        if (window === undefined) throw new Error('Missing Notepad window')
        return { name: computerTool('get_window_state'), args: { pid: window.pid, window_id: window.window_id, session } }
      },
      (request) => {
        const observed = windowSnapshot.parse(lastStructuredResult(request))
        const element = observed.elements.find(candidate => candidate.role === 'Edit' && candidate.label === 'Document')
        if (element === undefined) throw new Error('Missing document element')
        return { name: computerTool('type_text'), args: {
          target: { kind: 'window', pid: observed.pid, window_id: observed.window_id },
          element_token: element.element_token, text: 'Targeted document text', delivery_mode: 'background', session,
        } }
      },
      { name: computerTool('verify_state'), args: {
        pid: 4400, window_id: 5500, expect: [{ element: { selector: { role: 'Edit', label: 'Document' }, value_equals: 'Targeted document text' } }], session,
      } },
      { name: computerTool('end_session'), args: { session } },
    )
    await send(agent)
    expect(model.requests).toHaveLength(7)
    const initial = model.requests[0]?.tools?.map(tool => tool.name).sort()
    expect(initial).toEqual(['tool_context', 'tool_search'])
    const loaded = model.requests[1]?.tools?.map(tool => tool.name).sort()
    expect(loaded).toEqual([...BASIC_TOOLS, 'tool_context', 'tool_search'].sort())
    const toolCalls = agent.session.snapshotEvents().filter(event => event.type === 'tool/call')
    expect(toolCalls.map(event => event.data.name)).toEqual([
      'tool_context', computerTool('list_windows'), computerTool('get_window_state'),
      computerTool('type_text'), computerTool('verify_state'), computerTool('end_session'),
    ])
    const snapshotResult = agent.session.snapshotEvents().find(event =>
      event.type === 'tool/result' && event.data.message.toolCallId === ToolCallId('desktop-call-3'))
    if (snapshotResult?.type !== 'tool/result') throw new Error('Missing logged native window snapshot')
    const snapshotImage = snapshotResult.data.message.content.find(block => block.type === 'image')
    if (snapshotImage?.type !== 'image') throw new Error('Missing native window image')
    expect(await ctx.attachments.readImage(snapshotImage.attachment)).toMatchObject({ ref: { width: 1, height: 1, mediaType: 'image/png' } })
    expect(model.requests[3]?.messages.filter(message => message.role === 'tool').at(-1)).toEqual(snapshotResult.data.message)
    const observed = windowSnapshot.parse(lastStructuredResult(model.requests[3]!))
    expect(observed.snapshot_id).toBe('s00000001')
    expect(observed.elements[0]?.element_token).toBe('notepad-document-s00000001-3')
    expect(JSON.stringify(agent.session.snapshotEvents())).not.toContain('iVBORw0KGgo')
    const calls = (await driverEvents(root)).filter(event => event.event === 'call')
    expect(calls.map(call => call.name)).toEqual(['list_windows', 'get_window_state', 'type_text', 'verify_state', 'end_session'])
    const write = calls.find(call => call.name === 'type_text')
    expect(write?.arguments).toEqual({
      target: { kind: 'window', pid: 4400, window_id: 5500 },
      element_token: 'notepad-document-s00000001-3', text: 'Targeted document text',
      delivery_mode: 'background', session,
    })
    // The fixture observes forwarded arguments; it does not emulate native focus.
    expect({ loaded, snapshot: observed, image: snapshotImage.attachment.mediaType, nativeCalls: calls.map(call => ({
      name: call.name, arguments: call.arguments,
    })) }).toMatchSnapshot()
  }, 20_000)

  it('reports screenshot unavailability to a model that declares text input only', async () => {
    const { ctx, model } = await load({ vision: false })
    const agent = await createAgent(ctx, 'muse-computer-text')
    model.calls.push({ name: 'tool_search', args: { query: TOOL } }, { name: TOOL, args: { display: 0 } })
    await send(agent)
    const result = agent.session.snapshotEvents().findLast(event => event.type === 'tool/result')
    if (result?.type !== 'tool/result') throw new Error('Missing screenshot diagnostic')
    const text = result.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('model "desktop-fixture" does not declare image input')
    expect(result.data.message.content.some(block => block.type === 'image')).toBe(false)
  }, 20_000)

  it.each([{ mode: 'fail' as const }, { missing: true }])('keeps Host registries active when the driver is unavailable: %j', async (options) => {
    const { ctx, model } = await load(options)
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'computer-use-driver')
    expect(entry?.fiber?.state).toBe(FiberState.ACTIVE)
    expect(ctx.tools.get(TOOL)).toBeUndefined()
    expect(ctx.computerUse.providerName).toBe('muse-computer')
    const agent = await createAgent(ctx, 'muse-computer-unavailable')
    await send(agent)
    expect(model.requests).toHaveLength(1)
    const prompt = (await ctx.systemPrompt.assemble({ agent, scope: agent })).sections
      .find(section => section.name === 'computer-use:muse')
    expect(prompt?.text).toContain('report that limitation')
    await entry?.fiber?.dispose()
    expect(ctx.computerUse.providerName).toBeUndefined()
  }, 20_000)

  it('makes tools mounted later discoverable to an existing session', async () => {
    const { ctx, model, driverConfig } = await load({ defer: true })
    const agent = await createAgent(ctx, 'muse-computer-late')
    await send(agent)
    expect(model.requests[0]?.tools?.map(tool => tool.name)).not.toContain(TOOL)
    await ctx.loader.create({ name: MODULE, config: driverConfig })
    await ctx.loader.await()
    model.calls.push({ name: 'tool_search', args: { query: '电脑截图' } }, { name: TOOL, args: { display: 0 } })
    await send(agent)
    expect(model.requests[2]?.tools?.map(tool => tool.name)).toContain(TOOL)
    const result = agent.session.snapshotEvents().findLast(event => event.type === 'tool/result')
    if (result?.type !== 'tool/result') throw new Error('Missing late-mounted screenshot')
    expect(result.data.message.content[0]).toEqual({ type: 'text', text: 'Display 0' })
    expect(result.data.message.content.filter(block => block.type === 'image')).toHaveLength(1)
  }, 20_000)

  it('retains desktop ownership after a disconnect without reconnecting or replaying input', async () => {
    const { ctx, root } = await load()
    const agent = await createAgent(ctx, 'disconnect-test')
    const result = await ctx.tools.execute({ name: 'mcp__muse-computer__disconnect', arguments: {}, agent,
      callId: ToolCallId('disconnect'), signal: new AbortController().signal })
    expect(result.isError).not.toBe(true)
    await vi.waitFor(async () => {
      for (const event of (await driverEvents(root)).filter(event => event.event === 'start')) expectProcessExited(event.pid)
    })
    expect(ctx.computerUse.providerName).toBe('muse-computer')
    expect(() => ctx.computerUse.register(ComputerUseProviderName('replacement'))).toThrow('already registered')
    const retry = await ctx.tools.execute({ name: TOOL, arguments: { display: 0 },
      callId: ToolCallId('disconnected-screenshot'), agent, signal: new AbortController().signal })
    expect(retry.isError).toBe(true)
    const diagnostic = retry.content[0]
    expect(diagnostic?.type).toBe('text')
    if (diagnostic?.type !== 'text') throw new Error('Missing disconnect diagnostic')
    expect(diagnostic.text).toMatch(/connection closed|server is disconnected/iu)
    expect((await driverEvents(root)).filter(event => event.event === 'initialize')).toHaveLength(1)
    expect((await driverEvents(root)).filter(event => event.event === 'call')).toHaveLength(1)
  }, 20_000)

  it('keeps driver error content as a failed tool result', async () => {
    const { ctx } = await load()
    const agent = await createAgent(ctx, 'error-test')
    const result = await ctx.tools.execute({ name: TOOL, arguments: { display: 99 },
      callId: ToolCallId('unavailable-window'), agent, signal: new AbortController().signal })
    expect(result.isError).toBe(true)
    const diagnostic = result.content[0]
    expect(diagnostic?.type).toBe('text')
    if (diagnostic?.type !== 'text') throw new Error('Missing driver error diagnostic')
    expect(diagnostic.text).toContain('The selected window is unavailable.')
  }, 20_000)

  it('unloads tools and guidance, waits for driver exit, and permits a fresh mount', async () => {
    const { ctx, root, driverConfig } = await load()
    const agent = await createAgent(ctx, 'muse-computer-reload')
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'computer-use-driver')
    await entry?.fiber?.dispose()
    expect(ctx.tools.get(TOOL)).toBeUndefined()
    expect(ctx.computerUse.providerName).toBeUndefined()
    expect((await ctx.systemPrompt.assemble({ agent, scope: agent })).sections.some(section => section.name === 'computer-use:muse')).toBe(false)
    for (const event of (await driverEvents(root)).filter(event => event.event === 'start')) expectProcessExited(event.pid)
    const replacement = await ctx.plugin(Provider, driverConfig)
    expect(ctx.tools.get(TOOL)).toBeDefined()
    expect(ctx.computerUse.providerName).toBe('muse-computer')
    await replacement.dispose()
    expect(ctx.computerUse.providerName).toBeUndefined()
  }, 20_000)

  it('rejects malformed executable options before acquiring desktop ownership', () => {
    for (const config of [{}, { command: '' }, { command: '  ' }, { command: 'fixture', toolCallTimeoutMs: 0 }]) {
      expect(() => Provider.Config(config)).toThrow()
    }
    expect(Provider.Config({ command: 'fixture' })).toMatchObject({ command: 'fixture', args: ['mcp'] })
  })
})

it('yields to physical input, refuses model retries and resumes only after a fresh human turn', async () => {
  const { ctx, root, model } = await load()
  const agent = await createAgent(ctx, 'physical-input-test')
  model.calls.push(
    { name: 'tool_context', args: { operation: 'load', tools: BASIC_TOOLS } },
    { name: computerTool('list_windows'), args: {} },
    () => {
      input.state = { available: true, epoch: 1, escapeEpoch: 0, idleMs: 0 }
      for (const listener of input.listeners) listener()
      return { name: computerTool('type_text'), args: {
        target: { kind: 'window', pid: 4400, window_id: 5500 },
        element_token: 'notepad-document-s00000001-3', text: 'Must not be sent', session: 'paused',
      } }
    },
    { name: computerTool('type_text'), args: {
      target: { kind: 'window', pid: 4400, window_id: 5500 },
      element_token: 'notepad-document-s00000001-3', text: 'No automatic retry', session: 'paused',
    } },
  )
  await send(agent)
  expect((await driverEvents(root)).filter(event => event.event === 'call').map(event => event.name)).toEqual(['list_windows'])
  const denied = agent.session.snapshotEvents().filter(event => event.type === 'tool/result' && event.data.message.isError)
  expect(denied).toHaveLength(2)
  expect(JSON.stringify(denied)).toContain('COMPUTER_USE_PAUSED_USER_INPUT')
  expect(input.states).toContain('active')
  expect(input.states).toContain('paused')
  input.state.idleMs = 10_000
  model.calls.push({ name: computerTool('list_windows'), args: {} })
  await send(agent)
  expect((await driverEvents(root)).filter(event => event.event === 'call').map(event => event.name)).toEqual(['list_windows', 'list_windows'])
  expect(input.states.at(-1)).toBe('idle')
})

it('cancels pending input and rejects another Agent without replaying the action', async () => {
  const { ctx } = await load()
  const agent = await createAgent(ctx, 'pending-owner')
  const other = await createAgent(ctx, 'competing-agent')
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  let calls = 0
  let aborted = false
  ctx.effect(() => ctx.tools.register({
    name: computerTool('pending_input'), description: 'Fixture input that settles on cancellation.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'settled' }] },
    async execute(_args, exec) {
      calls++
      started.resolve()
      await new Promise<void>((resolve) => {
        exec.signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true })
      })
      return {}
    },
  }))
  const run = ctx.tools.execute({ name: computerTool('pending_input'), arguments: {}, agent,
    callId: ToolCallId('pending'), signal: new AbortController().signal })
  await started.promise
  const busy = await ctx.tools.execute({ name: computerTool('list_windows'), arguments: {}, agent: other,
    callId: ToolCallId('competing'), signal: new AbortController().signal })
  expect(JSON.stringify(busy)).toContain('COMPUTER_USE_BUSY')
  input.state = { available: true, epoch: 1, escapeEpoch: 0, idleMs: 0 }
  for (const listener of input.listeners) listener()
  const result = await run
  expect(aborted).toBe(true)
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result)).toContain('COMPUTER_USE_PAUSED_USER_INPUT')
  input.state.idleMs = 10_000
  const retry = await ctx.tools.execute({ name: computerTool('pending_input'), arguments: {}, agent,
    callId: ToolCallId('no-replay'), signal: new AbortController().signal })
  expect(JSON.stringify(retry)).toContain('COMPUTER_USE_PAUSED_USER_INPUT')
  expect(calls).toBe(1)
})

it('refuses desktop actions if physical input observation is unavailable', async () => {
  const { ctx, root, model } = await load()
  const agent = await createAgent(ctx, 'missing-observer')
  input.state.available = false
  model.calls.push({ name: 'tool_context', args: { operation: 'load', tools: BASIC_TOOLS } },
    { name: computerTool('list_windows'), args: {} })
  await send(agent)
  expect((await driverEvents(root)).filter(event => event.event === 'call')).toHaveLength(0)
  expect(JSON.stringify(agent.session.snapshotEvents())).toContain('COMPUTER_USE_OBSERVER_UNAVAILABLE')
})


it('holds concurrent tools until the shared blue indicator has been acknowledged', async () => {
  const { ctx, root } = await load()
  const agent = await createAgent(ctx, 'indicator-owner')
  const visible: PromiseWithResolvers<void> = Promise.withResolvers()
  input.activeReady = visible.promise
  const call = (id: string) => ctx.tools.execute({ name: computerTool('list_windows'), arguments: {}, agent,
    callId: ToolCallId(id), signal: new AbortController().signal })
  const runs = [call('indicator-first')]
  try {
    await vi.waitFor(() => { expect(input.states).toContain('active') })
    const samplesBeforeSecond = input.samples
    runs.push(call('indicator-second'))
    // Admission samples twice before waiting for the shared acknowledgement.
    await vi.waitFor(() => { expect(input.samples).toBeGreaterThanOrEqual(samplesBeforeSecond + 2) })
    expect((await driverEvents(root)).filter(event => event.event === 'call')).toHaveLength(0)
  } finally {
    visible.resolve()
    await Promise.allSettled(runs)
  }
  expect(input.states.filter(state => state === 'active')).toHaveLength(1)
  expect((await driverEvents(root)).some(event => event.event === 'call')).toBe(true)
})


it('physical Escape cancels an in-flight action, hides the frame and refuses automatic continuation', async () => {
  const { ctx } = await load()
  const agent = await createAgent(ctx, 'escape-owner')
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  let canceled = false
  ctx.effect(() => ctx.tools.register({
    name: computerTool('escape_pending'), description: 'Fixture pending action.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'done' }] },
    async execute(_args, exec) {
      started.resolve()
      await new Promise<void>((resolve) => { exec.signal.addEventListener('abort', () => { canceled = true; resolve() }, { once: true }) })
      return {}
    },
  }))
  const run = ctx.tools.execute({ name: computerTool('escape_pending'), arguments: {}, agent,
    callId: ToolCallId('escape-pending'), signal: new AbortController().signal })
  await started.promise
  input.state = { available: true, epoch: 1, escapeEpoch: 1, idleMs: 0 }
  for (const listener of input.listeners) listener()
  expect(JSON.stringify(await run)).toContain('COMPUTER_USE_ENDED')
  expect(canceled).toBe(true)
  expect(input.states.at(-1)).toBe('idle')
  input.state.idleMs = 10_000
  const retry = await ctx.tools.execute({ name: computerTool('list_windows'), arguments: {}, agent,
    callId: ToolCallId('escape-retry'), signal: new AbortController().signal })
  expect(JSON.stringify(retry)).toContain('COMPUTER_USE_ENDED')
  expect(input.states.at(-1)).toBe('idle')
})

it.each(['escape', 'end_session', 'human-message'] as const)('dismisses a paused frame through %s without reactivating computer input', async (exit) => {
  const { ctx, root, model } = await load()
  const agent = await createAgent(ctx, 'paused-exit-' + exit)
  model.calls.push(
    { name: 'tool_context', args: { operation: 'load', tools: BASIC_TOOLS } },
    { name: computerTool('list_windows'), args: {} },
    () => {
      input.state = { available: true, epoch: 1, escapeEpoch: 0, idleMs: 0 }
      for (const listener of input.listeners) listener()
      return { name: computerTool('list_windows'), args: {} }
    },
  )
  await send(agent)
  expect(input.states.at(-1)).toBe('paused')
  input.state.idleMs = 10_000
  if (exit === 'escape') {
    input.state.escapeEpoch = 1
    for (const listener of input.listeners) listener()
  } else if (exit === 'end_session') {
    await ctx.tools.execute({ name: computerTool('end_session'), arguments: { session: 'paused' }, agent,
      callId: ToolCallId('paused-end'), signal: new AbortController().signal })
  } else {
    // A normal human follow-up with no computer action must not leave the old frame visible.
    await send(agent)
  }
  expect(input.states.at(-1)).toBe('idle')
  expect((await driverEvents(root)).filter(event => event.event === 'call').map(event => event.name))
    .toEqual(exit === 'end_session' ? ['list_windows', 'end_session'] : ['list_windows'])
  input.state.epoch++
  for (const listener of input.listeners) listener()
  expect(input.states.at(-1)).toBe('idle')
  if (exit === 'escape') {
    model.calls.push({ name: computerTool('list_windows'), args: {} })
    await send(agent)
    expect((await driverEvents(root)).filter(event => event.event === 'call').map(event => event.name)).toEqual(['list_windows', 'list_windows'])
    expect(input.states.at(-1)).toBe('idle')
  }
})
