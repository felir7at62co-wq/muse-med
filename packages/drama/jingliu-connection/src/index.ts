/** Authenticated access to the ShotFlow project and workflow gateway. */
import { createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialKey, type CredentialKey } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-commands'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { isRecord, JingliuHttpError, requestJson, studioOrigin } from './http.ts'
import type { JingliuRequest } from './http.ts'

export { JingliuHttpError }
export type { JingliuRequest }

declare module '@deepseek-ai/cordis' {
  interface Context {
    jingliuConnection: JingliuConnection
  }
}

/** Limits and server address for this installation. */
export interface Config {
  /** HTTPS studio origin or HTTP loopback origin used for the ShotFlow API. */
  studioOrigin?: string
  /** Maximum time in milliseconds for one JSON request, including its response body. */
  timeoutMs?: number
  /** Read the isolated test session from the Host environment on a loopback deployment. */
  localPreviewToken?: boolean
}

/** One verified user of a specific Jingliu deployment. */
export interface JingliuSession {
  readonly identity: string
  /** Request a service route as the same user.
   * @param path - Route relative to the deployment's V2 API.
   * @param options - Method, payload and optional cancellation signal.
   * @returns The parsed service response.
   */
  request(path: string, options?: JingliuRequest): Promise<unknown>
}

interface LoginAttempt {
  owner: string
  ticket: string
  claim: string
  expires: number
}

/** Resolves user grants at execution time, keeping tokens outside model input and output. */
export class JingliuConnection extends Service {
  static inject = ['credentials', 'commands']
  static Config = z.object({
    studioOrigin: z.string(),
    timeoutMs: z.number().min(1).max(120000).step(1).default(30000),
    localPreviewToken: z.boolean().default(false),
  })

  private readonly origin: string | undefined
  private readonly key?: CredentialKey
  private readonly lifetime = new AbortController()
  private readonly preview: boolean
  private readonly timeout: number
  private pending: LoginAttempt | undefined
  private changing = false

  /** @param ctx - Muse host context.
   * @param config - Jingliu deployment and transport configuration.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'jingliuConnection')
    this.origin = config.studioOrigin ? studioOrigin(config.studioOrigin) : undefined
    this.preview = config.localPreviewToken === true
    this.timeout = config.timeoutMs ?? 30_000
    if (this.preview && (!this.origin || !['127.0.0.1', '[::1]'].includes(new URL(this.origin).hostname))) {
      throw new HarnessError('本机预览凭据只能用于回环服务。', 'JINGLIU_PREVIEW_ORIGIN_INVALID')
    }
    if (!this.origin) return
    this.key = credentialKey('jingliu-connection', 'user-' + this.digest(this.origin))
    const register = (name: string, description: string, action: (owner: string, signal: AbortSignal) => Promise<string>): void => {
      ctx.effect(() => ctx.commands.register({
        name, description, definitionId: CommandDefinitionId('@deepseek-ai/dsh-jingliu-connection/' + name), recordInput: false,
        handler: async (invocation) => {
          if (invocation.rawInput.trim()) return { kind: 'error', text: '该命令无需输入参数。' }
          if (this.changing) return { kind: 'error', text: '镜流正在处理上一次账号操作，请稍后重试。' }
          this.changing = true
          try {
            return { kind: 'success', text: await action(invocation.agent.session.id, invocation.signal) }
          } finally {
            this.changing = false
          }
        },
      }), name)
    }
    if (!this.preview) {
      register('jingliu-login', '用飞书授权 Muse 调用镜流工具', (owner, signal) => this.login(owner, signal))
      register('jingliu-logout', '退出 Muse 工具使用的镜流账号', (_owner, signal) => this.logout(signal))
    }
    ctx.effect(() => () => { this.lifetime.abort(); this.pending = undefined }, 'jingliu account lifetime')
  }

  private digest(text: string): string {
    return createHash('sha256').update(text).digest('hex')
  }

  private async token(): Promise<string> {
    if (!this.key) throw new HarnessError('请在 Muse 安装配置中选择镜流站点。', 'JINGLIU_UNCONFIGURED')
    if (this.preview) {
      const token = process.env.MUSE_JINGLIU_SESSION_TOKEN
      if (token) return token
      throw new HarnessError('镜流本地预览尚未配置测试会话。', 'JINGLIU_SIGN_IN_REQUIRED')
    }
    const stored = await this.ctx.credentials.readRecord(this.key)
    if (stored?.kind === 'grant' && isRecord(stored.payload) && stored.payload.origin === this.origin &&
      typeof stored.payload.token === 'string' && stored.payload.token) return stored.payload.token
    throw new HarnessError('请使用 /jingliu-login 登录镜流。', 'JINGLIU_SIGN_IN_REQUIRED')
  }

  private async call(path: string, options: JingliuRequest, headers?: Record<string, string>): Promise<unknown> {
    const signal = options.signal === undefined ? this.lifetime.signal : AbortSignal.any([options.signal, this.lifetime.signal])
    if (!this.origin) throw new HarnessError('尚未配置镜流站点。', 'JINGLIU_UNCONFIGURED')
    return await requestJson(this.origin, path, this.timeout, { ...options, signal, ...(headers && { headers }) })
  }

  /** Resolve the active account on the selected deployment.
   * @returns A transport which stops if the session grant changes.
   */
  async connection(): Promise<JingliuSession> {
    const token = await this.token()
    const headers = { authorization: 'Bearer ' + token }
    const profile = await this.call('/auth/me', {}, headers)
    if (!isRecord(profile) || !isRecord(profile.user) || !Number.isSafeInteger(profile.user.id)) {
      throw new HarnessError('镜流未返回有效的登录用户。', 'JINGLIU_INVALID_ACCOUNT')
    }
    return {
      identity: this.digest(this.origin + '/' + String(profile.user.id)),
      request: async (path, options = {}) => {
        if (token !== await this.token()) throw new HarnessError('镜流账户发生变化，请重新选择项目。', 'JINGLIU_ACCOUNT_CHANGED')
        return await this.call(path, options, headers)
      },
    }
  }

  private async login(owner: string, signal: AbortSignal): Promise<string> {
    if (this.pending && this.pending.expires <= Date.now()) this.pending = undefined
    if (!this.pending) {
      const value = await this.call('/auth/feishu/start?mode=desktop', { method: 'POST', signal })
      if (!isRecord(value) || typeof value.ticket !== 'string' || !value.ticket || typeof value.claim_secret !== 'string'
        || !value.claim_secret || typeof value.authorize_url !== 'string') throw new HarnessError('镜流未返回完整的授权票据。', 'JINGLIU_INVALID_TICKET')
      const page = new URL(value.authorize_url)
      if (page.protocol !== 'https:' || page.username || page.password || page.port ||
        !['open.feishu.cn', 'accounts.feishu.cn', 'open.larksuite.com', 'accounts.larksuite.com'].includes(page.hostname)) {
        throw new HarnessError('镜流返回的授权地址不属于飞书。', 'JINGLIU_INVALID_TICKET')
      }
      this.pending = { owner, ticket: value.ticket, claim: value.claim_secret, expires: Date.now() + 600_000 }
      return '请本人打开飞书授权链接，在原会话再次运行 /jingliu-login 完成连接。\n' + page.href
    }
    if (owner !== this.pending.owner) throw new HarnessError('请回到发起登录的 Muse 会话完成授权。', 'JINGLIU_LOGIN_IN_PROGRESS')
    const result = await this.call('/auth/feishu/poll?' + new URLSearchParams({ ticket: this.pending.ticket }).toString(),
      { signal }, { 'x-fw-claim': this.pending.claim })
    if (isRecord(result) && result.status === 'pending') return '飞书授权仍在等待。完成授权后再次运行 /jingliu-login。'
    this.pending = undefined
    if (!isRecord(result) || result.status !== 'ok' || typeof result.token !== 'string' || !result.token || !this.key) {
      throw new HarnessError('授权票据已过期，请重新运行 /jingliu-login。', 'JINGLIU_LOGIN_EXPIRED')
    }
    const token = result.token
    await this.ctx.credentials.modifyRecord(this.key, async () => ({ kind: 'grant', payload: { origin: this.origin, token } }))
    return '已连接镜流。'
  }

  private async logout(signal: AbortSignal): Promise<string> {
    this.pending = undefined
    if (!this.key) throw new HarnessError('尚未配置镜流站点。', 'JINGLIU_UNCONFIGURED')
    const stored = await this.ctx.credentials.readRecord(this.key)
    if (stored?.kind === 'grant' && isRecord(stored.payload) && typeof stored.payload.token === 'string') {
      const token = stored.payload.token
      try {
        await this.call('/auth/logout', { method: 'POST', signal }, { authorization: 'Bearer ' + token })
      } catch (error) {
        if (!(error instanceof JingliuHttpError && error.status === 401)) throw error
      }
      await this.ctx.credentials.modifyRecord(this.key, async current => current?.kind === 'grant' &&
        isRecord(current.payload) && current.payload.token === token ? { kind: 'grant', payload: null } : undefined)
    }
    return '已断开镜流工具账号。'
  }
}

export default JingliuConnection
