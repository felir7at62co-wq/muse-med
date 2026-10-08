/** Session-bound Muse models registered beside user-managed providers. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmError, ReasoningEffortId, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle, LlmCallConfig, LlmResolvedModelInfo, PreparedAdapterCall } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { PiAiAdapter, resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiAdapterOptions, PiAiProviderProfile, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { z } from 'zod'
import { readMuseSession, clearMuseSessionIfUnchanged } from './session.ts'
import { MuseGatewayError } from './gateway.ts'

const metadata = z.object({ providers: z.array(z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), name: z.string().min(1).max(200),
  models: z.array(z.object({
    id: z.string().min(1).max(200), name: z.string().min(1).max(200),
    contextWindow: z.number().int().positive(), maxTokens: z.number().int().positive(),
    input: z.array(z.enum(['text', 'image'])).min(1),
    reasoningEfforts: z.union([z.literal(false), z.record(z.string(), z.string().nullable())]),
    defaultReasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
  }).superRefine((model, context) => {
    const level = model.defaultReasoningEffort
    if (level !== undefined && (model.reasoningEfforts === false
      || typeof model.reasoningEfforts[level] !== 'string' || !model.reasoningEfforts[level].length)) {
      context.addIssue({ code: 'custom', path: ['defaultReasoningEffort'], message: 'Model default effort must be offered' })
    }
  })).max(256),
})).max(100) })
const modelName = (id: string): string => id.slice(id.lastIndexOf('/') + 1)

/** Capture account catalog defaults with the same prepared generation as its request stream. */
class MusePiAiAdapter extends PiAiAdapter {
  constructor(
    options: PiAiAdapterOptions,
    private readonly defaultEffort: (provider: string, model: string) => ReasoningEffortId | undefined,
  ) {
    super(options)
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return (await this.prepareCall(provider, model, signal)).model
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const defaultEffort = this.defaultEffort(provider, model)
    const prepared = await super.prepareCall(provider, model, signal)
    if (defaultEffort === undefined || prepared.model.reasoning === undefined) return prepared
    return { ...prepared, model: { ...prepared.model, reasoning: { ...prepared.model.reasoning, defaultEffort } } }
  }
}

/** Product-selected origin and polling limits, with a testable HTTP transport. */
export interface MuseModelsOptions {
  readonly baseUrl: string
  readonly sessionFile: string
  readonly requestTimeoutMs: number
  readonly fetcher?: typeof fetch
  readonly excludedModelPrefixes?: readonly string[]
  readonly excludedProviderIds?: readonly string[]
}

/** Own Muse registrations and repair defaults whose matching direct route has no credential. */
export class MuseModels {
  private profiles = new Map<string, ResolvedPiAiProviderProfile>()
  private readonly revisions = new WeakMap<ResolvedPiAiProviderProfile, string>()
  private defaultEfforts: ReadonlyMap<string, ReasoningEffortId> = new Map()
  private registration: AdapterRegistrationHandle | undefined
  private revision: string | undefined
  private signature: string | undefined
  private queue = Promise.resolve()
  private readonly stop = new AbortController()
  private readonly adapter: PiAiAdapter
  private readonly disposeRequestRoute: () => void

  constructor(private readonly ctx: Context, private readonly options: MuseModelsOptions) {
    this.adapter = new MusePiAiAdapter({
      profiles: () => this.profiles,
      resolveApiKey: async (_provider, profile) => {
        const session = await readMuseSession(options.sessionFile, options.baseUrl)
        if (this.stop.signal.aborted || !session || session.revision !== this.revisions.get(profile)) {
          throw new LlmError('Please sign in to Muse and refresh the model list', 'MISSING_CREDENTIAL')
        }
        const token = session.cookie.slice(session.cookie.indexOf('=') + 1)
        if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new LlmError('Muse session is invalid', 'MISSING_CREDENTIAL')
        return token
      },
      auth: {
        credentials: {
          read: () => Promise.resolve(undefined), list: () => Promise.resolve([]),
          modify: () => Promise.reject(new Error('Muse credentials are managed by account login')),
          delete: () => Promise.resolve(),
        },
        authContext: { env: () => Promise.resolve(undefined), fileExists: () => Promise.resolve(false) },
      },
      resolveAttachments: () => ctx.get('attachments'),
      resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, () => undefined, ref),
    }, (provider, model) => this.defaultEfforts.get(`${provider}:${model}`))
    this.disposeRequestRoute = ctx.on('agent/request', async ({ agent, signal }, next) => {
      const config = await next()
      return await this.repairRequestRoute(agent, config, signal)
    }, { prepend: true })
  }

  /** Withdraw this instance's models and cancel its pending catalog fetch. */
  dispose(): void {
    this.stop.abort()
    this.disposeRequestRoute()
    this.registration?.()
    this.registration = undefined
    this.profiles = new Map()
    this.defaultEfforts = new Map()
  }

  /**
   * Serialize refreshes, publishing only metadata for the still-current login.
   * @returns Completion after registration and default selection, retaining any concurrently saved choice.
   */
  refresh(): Promise<void> {
    const operation = this.queue.then(() => this.synchronize())
    this.queue = operation.catch(() => { /* The requesting caller receives the failure. */ })
    return operation
  }

  private clear(): void {
    this.registration?.replace([])
    this.profiles = new Map()
    this.defaultEfforts = new Map()
    this.revision = undefined
    this.signature = undefined
  }

  private async synchronize(): Promise<void> {
    if (this.stop.signal.aborted) return
    const session = await readMuseSession(this.options.sessionFile, this.options.baseUrl)
    if (!session) { this.clear(); return }
    if (this.revision !== session.revision) this.clear()
    const response = await (this.options.fetcher ?? fetch)(new URL('/api/desktop-models/providers', this.options.baseUrl), {
      headers: { cookie: session.cookie }, redirect: 'error',
      signal: AbortSignal.any([this.stop.signal, AbortSignal.timeout(this.options.requestTimeoutMs)]),
    }).catch(() => { throw new MuseGatewayError('gateway-unavailable') })
    if (response.status === 401) {
      await clearMuseSessionIfUnchanged(this.options.sessionFile, session)
      this.clear()
      return
    }
    if (!response.ok) throw new MuseGatewayError('gateway-unavailable')
    const text = await response.text()
    if (text.length > 2 * 1024 * 1024) throw new MuseGatewayError('gateway-rejected')
    let data: z.infer<typeof metadata>
    try { data = metadata.parse(JSON.parse(text)) } catch { throw new MuseGatewayError('gateway-rejected') }
    const current = await readMuseSession(this.options.sessionFile, this.options.baseUrl)
    this.stop.signal.throwIfAborted()
    if (current?.revision !== session.revision) { this.clear(); return }
    const signature = JSON.stringify(data)
    if (signature === this.signature && session.revision === this.revision) return
    const providers: Record<string, PiAiProviderProfile> = {}
    const defaults = new Map<string, ReasoningEffortId>()
    for (const provider of data.providers) {
      if (this.options.excludedProviderIds?.includes(provider.id)) continue
      const id = `muse-cloud-${provider.id}`
      if (Object.hasOwn(providers, id)) throw new MuseGatewayError('gateway-rejected')
      const allowedModels = provider.models.filter(model => !(this.options.excludedModelPrefixes ?? [])
        .some(prefix => modelName(model.id).toLowerCase().startsWith(prefix.toLowerCase())))
      if (!allowedModels.length) continue
      for (const model of allowedModels) {
        if (model.defaultReasoningEffort !== undefined) defaults.set(`${id}:${model.id}`, ReasoningEffortId(model.defaultReasoningEffort))
      }
      providers[id] = {
        displayName: `Muse · ${provider.name}`, api: 'openai-completions',
        baseURL: `${this.options.baseUrl}/api/desktop-models/${provider.id}`,
        headers: { origin: this.options.baseUrl },
        models: allowedModels.map(model => ({ ...model,
          compat: { supportsReasoningEffort: model.reasoningEfforts !== false,
            ...(/^glm-5\.3(?:-|$)/i.test(modelName(model.id)) ? {
              thinkingFormat: 'deepseek' as const, requiresReasoningContentOnAssistantMessages: true,
            } : {}) } })),
        compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens',
          ...(provider.id === 'deepseek-official' ? { thinkingFormat: 'deepseek' as const, requiresReasoningContentOnAssistantMessages: true } : {}) },
      }
    }
    const candidate = resolveProfiles(providers)
    for (const profile of candidate.values()) {
      this.revisions.set(profile, session.revision)
    }
    const previous = this.profiles
    const previousDefaults = this.defaultEfforts
    this.profiles = candidate
    this.defaultEfforts = defaults
    try {
      if (this.registration) this.registration.replace([...candidate.keys()])
      else if (candidate.size) this.registration = this.ctx.llm.registerAdapter([...candidate.keys()], this.adapter)
    } catch (error) { this.profiles = previous; this.defaultEfforts = previousDefaults; throw error }
    this.revision = session.revision
    await this.selectInitialDefault(providers, session.revision)
    this.signature = signature
  }

  private async directRouteMissingCredential(provider: string): Promise<boolean> {
    const credentials = this.ctx.get('credentials')
    const settings = this.ctx.get('settings')
    const route = this.ctx.llm.listConfigurableProviders().find(row => row.provider === provider)
    if (!credentials || !settings || !route) return false
    let profile = settings.describe({ redactSecrets: true }).find(row => row.ns === route.settingsNs)?.value
    for (const key of route.settingsPath) {
      profile = typeof profile === 'object' && profile !== null ? Reflect.get(profile, key) : undefined
    }
    if (typeof profile !== 'object' || profile === null) return false
    const ref: unknown = Reflect.get(profile, 'apiKeyEnv')
    return typeof ref === 'string' && ref.length > 0 && !(await credentials.describe(credentialRef(ref))).configured
  }

  /** Repair a missing-key request only while its assembled route and effort remain the current user choice. */
  private async repairRequestRoute(agent: Agent, config: LlmCallConfig, signal: AbortSignal): Promise<LlmCallConfig> {
    const controller = this.ctx.get('sessionController')
    const provider = `muse-cloud-${config.provider}`
    const profile = this.profiles.get(provider)
    const revision = this.revision
    if (!controller || !profile || !this.catalogCurrent(provider, profile) || signal.aborted) return config
    const state = this.ctx.sessionProjections.stateOf(agent.session, 'modelSelection')
    const header = agent.session.requestHeader()
    const expected = state?.pending ?? (header ? {
      provider: header.config.provider, model: header.config.model,
      ...(header.config.reasoningEffort === undefined || header.adapterDefaults?.reasoningEffort === true
        ? {} : { reasoningEffort: header.config.reasoningEffort }),
    } : this.ctx.agentDefaultModel.currentSelection())
    if (expected.provider !== config.provider || expected.model !== config.model
      || expected.reasoningEffort !== config.reasoningEffort) return config
    if (!await this.directRouteMissingCredential(config.provider)) return config
    if (!this.catalogCurrent(provider, profile)) return config
    const advertised = (await this.ctx.llm.listModels(provider)).some(model => model.id === config.model)
    const current = await readMuseSession(this.options.sessionFile, this.options.baseUrl)
    signal.throwIfAborted()
    if (!this.catalogCurrent(provider, profile) || current?.revision !== revision) return config
    if (!advertised) throw new LlmError('The saved direct model is not in the Muse catalog. Select an available Muse model in the conversation model picker.', 'UNKNOWN_MODEL')
    const result = await controller.selectModelIfCurrent({
      sessionId: agent.id, provider, model: config.model,
      ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    }, expected)
    const resolved = result?.selected ?? await this.ctx.llm.resolveCallConfig({ ...config, provider })
    signal.throwIfAborted()
    const { reasoningEffort: _directEffort, ...withoutDirectEffort } = config
    return { ...withoutDirectEffort, provider: resolved.provider, model: resolved.model,
      ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(resolved.reasoningEffort) }) }
  }

  private catalogCurrent(provider: string, profile: ResolvedPiAiProviderProfile): boolean {
    return !this.stop.signal.aborted && this.profiles.get(provider) === profile
  }

  private async selectInitialDefault(providers: Record<string, PiAiProviderProfile>, revision: string): Promise<void> {
    const settings = this.ctx.get('settings')
    const section = settings?.describe().find(row => String(row.ns) === 'agent-default-model')
    if (!settings || !section) return
    const user = section.user as { provider?: string; model?: string }
    const matchingCloud = user.provider ? `muse-cloud-${user.provider}` : undefined
    if (user.provider && !user.provider.startsWith('muse-cloud-')
      && (!matchingCloud || !providers[matchingCloud] || !await this.directRouteMissingCredential(user.provider))) return
    if (user.provider && providers[user.provider]?.models?.some(model => model.id === user.model)) return
    const first = matchingCloud && providers[matchingCloud]
      ? [matchingCloud, providers[matchingCloud]] as const : Object.entries(providers)[0]
    const model = first?.[1].models?.find(model => model.id === user.model) ?? first?.[1].models?.[0]
    const current = await readMuseSession(this.options.sessionFile, this.options.baseUrl)
    if (this.stop.signal.aborted || current?.revision !== revision) return
    if (first && model) {
      try { await settings.replace('agent-default-model', { provider: first[0], model: model.id }, section.revision) }
      catch (error) { if (!(error instanceof SettingsConflictError)) throw error }
    }
  }
}
