/** On-demand tool discovery with session-derived loading and unchanged execution permissions. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-projection'
import { ToolSearchIndex } from './search.ts'
import { capabilityMemberships, capabilitySummaries } from './capabilities.ts'
import type { CapabilitySummary } from './capabilities.ts'
import { discoveryGuidance } from './guidance.ts'
import { ToolDiscoveryRuntime } from './residency.ts'

export { ToolDiscoveryRuntime } from './residency.ts'
export type { ToolContextState, ToolResidencyProvider } from './residency.ts'

/** Cordis plugin name. */
export const name = 'tool-discovery'
/** Services used for authorized lookup, agent lifetime and durable loading state. */
export const inject = ['tools', 'agents', 'sessionProjections']

/** Deployment choices for tool discovery. */
export interface Config {
  /** Names whose definitions are available before a search; providers may register later. */
  alwaysLoad: string[]
  /** Maximum definitions loaded by one search. */
  maxResults?: number
  /** Maximum Unicode characters of each result description. */
  maxDescriptionChars?: number
  /** BM25 term frequency saturation. */
  k1?: number
  /** BM25 document-length normalization, between zero and one. */
  b?: number
  /** Additional searchable phrases keyed by exact registered tool name. */
  keywords?: Record<string, string[]>
  /** Overlapping capability groups; member patterns are exact names or trailing-star prefixes. */
  capabilities?: Array<{
    /** Unique capability id used by directory and filtered search requests. */
    id: string
    /** Short capability title included in directory entries and search metadata. */
    title: string
    /** Capability purpose shown in the directory. */
    description: string
    /** Exact tool names or prefixes with one trailing star; groups may overlap. */
    tools: string[]
  }>
  /** Maximum characters of the complete serialized search result. */
  maxResultChars?: number
  /** Maximum characters of the initial authorized capability directory, excluding fixed guidance. */
  maxDirectoryChars?: number
}

/** Loader-validated discovery settings. */
export const Config: z<Config> = z.object({
  alwaysLoad: z.array(z.string()).required(),
  maxResults: z.natural().min(1).max(32).default(8),
  maxDescriptionChars: z.natural().min(1).max(2048).default(320),
  k1: z.number().min(0.01).max(10).default(1.2),
  b: z.number().min(0).max(1).default(0.75),
  keywords: z.dict(z.array(z.string())).default({}),
  capabilities: z.array(z.object({ id: z.string().required(), title: z.string().required(),
    description: z.string().required(), tools: z.array(z.string()).required() })).default([]),
  maxResultChars: z.natural().min(256).max(65536).default(6000),
  maxDirectoryChars: z.natural().min(256).max(16384).default(2000),
})

const loadedTool = zod.object({ name: zod.string(), description: zod.string() })
const receipt = zod.object({ loaded: zod.array(loadedTool), matched: zod.number() })
const contextReceipt = zod.object({ operation: zod.enum(['status', 'load', 'pin', 'release', 'unpin']), tools: zod.array(zod.string()), retained: zod.array(zod.string()) })
const stateSchema = zod.object({ loaded: zod.array(zod.string()), pinned: zod.array(zod.string()),
  pending: zod.array(zod.string()), pendingContext: zod.array(zod.string()) })
type DiscoveryState = zod.infer<typeof stateSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Names loaded by successful discovery results, independent of current authorization. */
    toolDiscovery: DiscoveryState
  }
}

/** Parse a successful tool receipt without retaining descriptions or parameters. */
function resultValue(content: readonly { type: string; text?: string }[]): unknown {
  const text = content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
  try { return JSON.parse(text) }
  catch (_error) { return undefined }
}

/** Apply names recorded in a successful search or context-management result. */
function learn(state: DiscoveryState, content: readonly { type: string; text?: string }[], context = false): DiscoveryState {
  const value = resultValue(content)
  if (context) {
    const parsed = contextReceipt.safeParse(value)
    if (!parsed.success || parsed.data.operation === 'status') return state
    const { operation, tools, retained } = parsed.data
    const loaded = operation === 'release' ? state.loaded.filter(name => !tools.includes(name))
      : operation === 'unpin' ? [...new Set([...state.loaded, ...retained])].sort() : [...new Set([...state.loaded, ...tools])].sort()
    const pinned = operation === 'pin' ? [...new Set([...state.pinned, ...tools])].sort()
      : operation === 'release' || operation === 'unpin' ? state.pinned.filter(name => !tools.includes(name)) : state.pinned
    return { ...state, loaded, pinned }
  }
  const parsed = receipt.safeParse(value)
  if (!parsed.success) return state
  const names = parsed.data.loaded.map(tool => tool.name)
  if (!names.some(value => !state.loaded.includes(value))) return state
  return { ...state, loaded: [...new Set([...state.loaded, ...names])].sort() }
}

interface LoadedTool { name: string; description: string; capabilities: string[] }
interface SearchResult {
  loaded: LoadedTool[]
  capabilities: CapabilitySummary[]
  matched: number
  omitted: number
  omitted_capabilities: number
}

/** Keep each name and category intact and account for JSON wrappers in the complete result. */
function boundedResult(loaded: LoadedTool[], capabilities: CapabilitySummary[], matched: number, budget: number): SearchResult {
  const result: SearchResult = { loaded: [], capabilities: [], matched, omitted: matched, omitted_capabilities: capabilities.length }
  for (const capability of capabilities) {
    result.capabilities.push(capability)
    result.omitted_capabilities--
    if (JSON.stringify(result).length <= budget) continue
    result.capabilities[result.capabilities.length - 1] = { ...capability, description: '' }
    if (JSON.stringify(result).length <= budget) continue
    result.capabilities.pop()
    result.omitted_capabilities++
  }
  for (const tool of loaded) {
    result.loaded.push(tool)
    result.omitted--
    if (JSON.stringify(result).length <= budget) continue
    result.loaded[result.loaded.length - 1] = { ...tool, description: '' }
    if (JSON.stringify(result).length <= budget) continue
    result.loaded.pop()
    result.omitted++
  }
  return result
}

/** Register the search tool and its scoped model presentation.
 * @param ctx - Composition owning the discovery tool and agent listeners.
 * @param config - Constant core tools, search bounds and indexing metadata.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const settings = Config(config)
  const maxResults = settings.maxResults ?? 8
  const maxDescriptionChars = settings.maxDescriptionChars ?? 320
  const ranking = { k1: settings.k1 ?? 1.2, b: settings.b ?? 0.75 }
  const keywords = settings.keywords ?? {}
  const capabilities = settings.capabilities ?? []
  const maxResultChars = settings.maxResultChars ?? 6000
  const maxDirectoryChars = settings.maxDirectoryChars ?? 2000
  const capabilityIds = new Set<string>()
  for (const capability of capabilities) {
    if (!capability.id.trim() || capabilityIds.has(capability.id)) throw new Error('Capability ids must be nonempty and unique')
    capabilityIds.add(capability.id)
    if (capability.tools.some(pattern => !pattern || pattern.slice(0, -1).includes('*'))) {
      throw new Error(`Capability ${capability.id} members must be exact names or trailing-star prefixes`)
    }
  }
  const core = new Set([...settings.alwaysLoad, 'tool_search', 'tool_context'])
  ctx.sessionProjections.register({
    key: 'toolDiscovery', stateSchema, stateVersion: 2,
    init: () => ({ loaded: [], pinned: [], pending: [], pendingContext: [] }),
    apply: (state, event) => {
      if (event.type === 'tool/call') {
        if (event.data.name === 'tool_search') return { ...state, pending: [...state.pending, event.data.callId] }
        if (event.data.name === 'tool_context') return { ...state, pendingContext: [...state.pendingContext, event.data.callId] }
      }
      if (event.type === 'tool/result') {
        const callId = event.data.message.toolCallId
        const context = state.pendingContext.includes(callId)
        if (!context && !state.pending.includes(callId)) return state
        const next = { ...state, pending: state.pending.filter(id => id !== callId),
          pendingContext: state.pendingContext.filter(id => id !== callId) }
        return event.data.message.isError ? next : learn(next, event.data.message.content, context)
      }
      if (event.type === 'tool/ptc-dispatch' && !event.data.isError) {
        if (event.data.name === 'tool_search') return learn(state, event.data.content)
        if (event.data.name === 'tool_context') return learn(state, event.data.content, true)
      }
      return state
    },
  })
  const runtime = new ToolDiscoveryRuntime(ctx, (agent) => {
    const state = ctx.sessionProjections.stateOf(agent.session, 'toolDiscovery')
    return { loaded: state?.loaded ?? [], pinned: state?.pinned ?? [] }
  }, core)
  let cached: { fingerprint: string; index: ToolSearchIndex } | undefined
  const indexFor = (tools: ToolSchema[]): ToolSearchIndex => {
    const fingerprint = JSON.stringify(tools)
    if (cached?.fingerprint === fingerprint) return cached.index
    const index = new ToolSearchIndex(tools.map(tool => ({ ...tool,
      keywords: [...(keywords[tool.name] ?? []), ...capabilities.filter(capability =>
        capabilityMemberships(tool.name, [capability]).length > 0).flatMap(capability => [capability.id, capability.title])],
    })), ranking)
    cached = { fingerprint, index }
    return index
  }
  const definition = defineTool({
    name: 'tool_search',
    description: 'Find authorized tools not loaded upfront by task or exact name; matching full definitions load next step. With no arguments, list capability groups without loading tools. Supply capability alone to browse and load a group, or combine it with query to narrow a search. If results are omitted, narrow the query. Search does not execute tools.',
    parameters: {
      query: { type: 'string', description: 'Task description or exact tool name; supports Chinese and English. Omit both query and capability to list capabilities.' },
      capability: { type: 'string', description: 'Optional capability id from the directory. Omit to search across groups.' },
      limit: { type: 'integer', description: `Maximum matching tools to load, from 1 to ${maxResults}; defaults to ${maxResults}.` },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        loaded: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          name: { type: 'string', required: true }, description: { type: 'string', required: true },
          capabilities: { type: 'array', required: true, items: { type: 'string' } },
        } } },
        capabilities: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          id: { type: 'string', required: true }, title: { type: 'string', required: true },
          description: { type: 'string', required: true }, tool_count: { type: 'integer', required: true },
        } } },
        matched: { type: 'integer', required: true },
        omitted: { type: 'integer', required: true }, omitted_capabilities: { type: 'integer', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: args => ({ card: 'generic', title: 'Discover tools', rawInput: args.query ?? args.capability ?? '' }),
    execute: (args, exec) => {
      if (!exec.agent) throw new Error('tool_search requires an agent session')
      const query = args.query?.trim() ?? ''
      const capability = args.capability?.trim()
      const limit = args.limit ?? maxResults
      if (limit < 1 || limit > maxResults) throw new Error(`limit must be between 1 and ${maxResults}`)
      const tools = ctx.tools.schemas(exec.agent).filter(tool => tool.name !== 'tool_search' && tool.name !== 'tool_context' && tool.name !== 'run_code')
      const summaries = capabilitySummaries(capabilities, tools.map(tool => tool.name))
      const available = capability ? tools.filter(tool => capabilityMemberships(tool.name, capabilities).includes(capability)) : tools
      if ((!query && !capability) || (capability && !capabilityIds.has(capability))) {
        return Promise.resolve(boundedResult([], summaries, 0, maxResultChars))
      }
      const matches = query ? indexFor(available).search(query, available.length)
        : available.map(tool => ({ name: tool.name, score: 0 }))
      const loaded = matches.slice(0, limit).flatMap((match) => {
        const tool = tools.find(item => item.name === match.name)
        return tool ? [{ name: tool.name, description: Array.from(tool.description).slice(0, maxDescriptionChars).join(''),
          capabilities: capabilityMemberships(tool.name, capabilities) }] : []
      })
      return Promise.resolve(boundedResult(loaded, [], matches.length, maxResultChars))
    },
  })
  ctx.tools.register(definition)
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    if (ctx.tools.get('tool_search', context.scope) !== definition) return assembly
    const authorized = ctx.tools.schemas(context.scope).map(tool => tool.name)
    const summaries = capabilitySummaries(capabilities, authorized)
    return { ...assembly, sections: [...assembly.sections, { name: 'tools:discovery',
      text: discoveryGuidance(summaries, maxDirectoryChars, maxDescriptionChars), interpolate: false }] }
  })
  ctx.tools.register(defineTool({
    name: 'tool_context',
    description: 'Manage your own tool definitions. status lists loaded and pinned tools. load exposes exact tools for this session. pin also saves them for future sessions of your Bot when supported. release removes session loading and the pin; unpin removes only the future-session preference and keeps currently loaded tools. Constant base tools, tool_search and tool_context cannot be released. Changes apply to your next model request; historical definitions and results remain in conversation history. Search can load a released tool again. This does not grant permissions or change other Bots.',
    parameters: {
      operation: { type: 'string', required: true, enum: ['status', 'load', 'pin', 'release', 'unpin'],
        description: 'Read status, load for this session, pin for future sessions, release, or cancel a pin.' },
      tools: { type: 'array', items: { type: 'string' }, description: 'Exact tool names; required for changes. Use tool_search to find names.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        operation: { type: 'string', required: true, enum: ['status', 'load', 'pin', 'release', 'unpin'] },
        tools: { type: 'array', required: true, items: { type: 'string' } },
        retained: { type: 'array', required: true, items: { type: 'string' } },
        loaded: { type: 'array', required: true, items: { type: 'string' } },
        pinned: { type: 'array', required: true, items: { type: 'string' } },
        omitted_loaded: { type: 'integer', required: true }, omitted_pinned: { type: 'integer', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    presentCall: args => ({ card: 'generic', title: 'Manage tool context', rawInput: args.operation }),
    execute: async (args, exec) => {
      if (!exec.agent) throw new Error('tool_context requires an agent session')
      const agent = exec.agent
      const names = [...new Set(args.tools ?? [])].sort()
      if (args.operation === 'status' && names.length) throw new Error('status does not accept tool names')
      if (args.operation !== 'status' && names.length === 0) throw new Error('Tool changes require exact tool names')
      if (names.some(name => !name.trim())) throw new Error('Tool names must be nonempty')
      if (args.operation !== 'status' && names.some(name => core.has(name) || name === 'run_code')) {
        throw new Error('Constant tools already remain available and cannot be changed')
      }
      const current = runtime.state(agent)
      const authorized = new Set(ctx.tools.schemas(agent).map(tool => tool.name))
      if ((args.operation === 'load' || args.operation === 'pin') && names.some(name => !authorized.has(name))) {
        throw new Error('A named tool is unavailable to this agent; search the current capability catalog')
      }
      const retained = args.operation === 'unpin' ? names.filter(name => current.loaded.includes(name)) : []
      const next = {
        loaded: args.operation === 'release' ? current.loaded.filter(name => !names.includes(name))
          : args.operation === 'load' || args.operation === 'pin' ? [...new Set([...current.loaded, ...names])].sort() : current.loaded,
        pinned: args.operation === 'pin' ? [...new Set([...current.pinned, ...names])].sort()
          : args.operation === 'release' || args.operation === 'unpin' ? current.pinned.filter(name => !names.includes(name)) : current.pinned,
      }
      const result = { operation: args.operation, tools: names, retained,
        loaded: next.loaded, pinned: next.pinned, omitted_loaded: 0, omitted_pinned: 0 }
      while (JSON.stringify(result).length > maxResultChars && (result.loaded.length || result.pinned.length)) {
        if (result.loaded.length >= result.pinned.length) { result.loaded.pop(); result.omitted_loaded++ }
        else { result.pinned.pop(); result.omitted_pinned++ }
      }
      if (JSON.stringify(result).length > maxResultChars) throw new Error('Tool change receipt exceeds the result budget; change fewer tools')
      if (args.operation === 'pin' || args.operation === 'release' || args.operation === 'unpin') {
        await runtime.save(agent, args.operation, names)
      }
      return result
    },
  }))
  const attached = new Map<Agent, () => void>()
  const attach = async (agent: Agent) => {
    if (attached.has(agent) || ctx.tools.get('tool_search', agent) !== definition) return
    await runtime.refresh(agent)
    attached.set(agent, agent.ctx.tools.presentOnly((tool, viewer) => viewer !== agent || core.has(tool)
      || runtime.selected(agent, tool)))
  }
  ctx.on('agent/created', async ({ agent }) => { await attach(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    attached.get(agent)?.()
    attached.delete(agent)
  })
  ctx.effect(() => () => {
    for (const dispose of attached.values()) dispose()
    attached.clear()
  })
  for (const agent of ctx.agents.list()) await attach(agent)
}
