/** Session-bound Muse models registered beside user-managed providers. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter, resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiProviderProfile, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type {} from '@deepseek-ai/dsh-settings'
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
  })).max(256),
})).max(100) })

/** Product-selected origin and polling limits, with a testable HTTP transport. */
export interface MuseModelsOptions {
  readonly baseUrl: string
  readonly sessionFile: string
  readonly requestTimeoutMs: number
  readonly fetcher?: typeof fetch
  readonly excludedModelPrefixes?: readonly string[]
}

/** Own only Muse registrations; custom provider settings and credentials are never rewritten. */
export class MuseModels {
  private profiles = new Map<string, ResolvedPiAiProviderProfile>()
  private readonly revisions = new WeakMap<ResolvedPiAiProviderProfile, string>()
  private registration: AdapterRegistrationHandle | undefined
  private revision: string | undefined
  private signature: string | undefined
  private queue = Promise.resolve()
  private readonly stop = new AbortController()
  private readonly adapter: PiAiAdapter

  constructor(private readonly ctx: Context, private readonly options: MuseModelsOptions) {
    this.adapter = new PiAiAdapter({
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
    })
  }

  /** Withdraw this instance's models and cancel its pending catalog fetch. */
  dispose(): void {
    this.stop.abort()
    this.registration?.()
    this.registration = undefined
    this.profiles = new Map()
  }

  /**
   * Serialize refreshes, publishing only metadata for the still-current login.
   * @returns Completion after registration and initial default selection.
   */
  refresh(): Promise<void> {
    const operation = this.queue.then(() => this.synchronize())
    this.queue = operation.catch(() => { /* The requesting caller receives the failure. */ })
    return operation
  }

  private clear(): void {
    this.registration?.replace([])
    this.profiles = new Map()
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
    for (const provider of data.providers) {
      const id = `muse-cloud-${provider.id}`
      if (Object.hasOwn(providers, id)) throw new MuseGatewayError('gateway-rejected')
      const allowedModels = provider.models.filter(model => !(this.options.excludedModelPrefixes ?? [])
        .some(prefix => model.id.toLowerCase().split('/').at(-1)?.startsWith(prefix.toLowerCase())))
      if (!allowedModels.length) continue
      providers[id] = {
        displayName: `Muse · ${provider.name}`, api: 'openai-completions',
        baseURL: `${this.options.baseUrl}/api/desktop-models/${provider.id}`,
        headers: { origin: this.options.baseUrl },
        models: allowedModels.map(model => ({ ...model,
          compat: { supportsReasoningEffort: model.reasoningEfforts !== false } })),
        compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens',
          ...(provider.id === 'deepseek-official' ? { thinkingFormat: 'deepseek' as const, requiresReasoningContentOnAssistantMessages: true } : {}) },
      }
    }
    const candidate = resolveProfiles(providers)
    for (const profile of candidate.values()) this.revisions.set(profile, session.revision)
    const previous = this.profiles
    this.profiles = candidate
    try {
      if (this.registration) this.registration.replace([...candidate.keys()])
      else if (candidate.size) this.registration = this.ctx.llm.registerAdapter([...candidate.keys()], this.adapter)
    } catch (error) { this.profiles = previous; throw error }
    this.revision = session.revision
    await this.selectInitialDefault(providers)
    this.signature = signature
  }

  private async selectInitialDefault(providers: Record<string, PiAiProviderProfile>): Promise<void> {
    const settings = this.ctx.get('settings')
    const section = settings?.describe().find(row => String(row.ns) === 'agent-default-model')
    if (!settings || !section) return
    const user = section.user as { provider?: string; model?: string }
    if (user.provider && !user.provider.startsWith('muse-cloud-')) return
    if (user.provider && providers[user.provider]?.models?.some(model => model.id === user.model)) return
    const first = Object.entries(providers)[0]
    const model = first?.[1].models?.[0]
    if (first && model) await settings.replace('agent-default-model', { provider: first[0], model: model.id }, section.revision)
  }
}
