/** Authenticated access to the ShotFlow project and workflow gateway. */
import { createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { MuseAccountService } from '@deepseek-ai/dsh-muse-account'
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

interface ActiveConnection {
  readonly owner: string
  readonly session: Promise<JingliuSession>
}

/** Resolves user grants at execution time, keeping tokens outside model input and output. */
export class JingliuConnection extends Service {
  static inject = ['commands']
  static Config = z.object({
    studioOrigin: z.string(),
    timeoutMs: z.number().min(1).max(120000).step(1).default(30000),
    localPreviewToken: z.boolean().default(false),
  })

  private readonly origin: string | undefined
  private readonly lifetime = new AbortController()
  private readonly preview: boolean
  private readonly timeout: number
  private active: ActiveConnection | undefined

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
    if (!this.preview) {
      ctx.on('muse-account/session-changed', () => { this.active = undefined })
      const command = (name: string, description: string, run: (signal: AbortSignal) => Promise<string>) => {
        ctx.effect(() => ctx.commands.register({
          name, description, definitionId: CommandDefinitionId('@deepseek-ai/dsh-jingliu-connection/' + name), recordInput: false,
          handler: async ({ rawInput, signal }) => {
            if (rawInput.trim()) return { kind: 'error', text: '该命令无需输入参数。' }
            signal.throwIfAborted()
            return { kind: 'success', text: await run(signal) }
          },
        }), name)
      }
      command('jingliu-login', '检查当前 Muse 账号的镜流连接', async (signal) => {
        await this.connection()
        signal.throwIfAborted()
        return '已使用当前 Muse 账号连接镜流。'
      })
      command('jingliu-logout', '结束当前镜流工具连接', signal => this.disconnect(signal))
    }
    ctx.effect(() => () => { this.active = undefined; this.lifetime.abort() }, 'jingliu account lifetime')
  }

  private async muse<T>(operation: (account: MuseAccountService) => Promise<T>): Promise<T> {
    const account = this.ctx.get('museAccount')
    if (!account) throw new HarnessError('请先在 Muse 的账号设置中登录。', 'JINGLIU_SIGN_IN_REQUIRED')
    try {
      return await operation(account)
    } catch (error) {
      if (isRecord(error) && error.code === 'invalid-credentials') {
        throw new HarnessError('请在 Muse 的账号设置中重新登录。', 'JINGLIU_SIGN_IN_REQUIRED', { cause: error })
      }
      throw new HarnessError('无法验证 Muse 登录状态，请检查账号服务后重试。', 'JINGLIU_MUSE_AUTH_UNAVAILABLE', { cause: error })
    }
  }

  private async owner(): Promise<string> {
    if (!this.preview) return this.muse(account => account.workbenchIdentity())
    const token = process.env.MUSE_JINGLIU_SESSION_TOKEN
    if (token) return token
    throw new HarnessError('镜流本地预览尚未配置测试会话。', 'JINGLIU_SIGN_IN_REQUIRED')
  }

  private async call(path: string, options: JingliuRequest, headers?: Record<string, string>): Promise<unknown> {
    const signal = options.signal === undefined ? this.lifetime.signal : AbortSignal.any([options.signal, this.lifetime.signal])
    if (!this.origin) throw new HarnessError('尚未配置镜流站点。', 'JINGLIU_UNCONFIGURED')
    return await requestJson(this.origin, path, this.timeout, { ...options, signal, ...(headers && { headers }) })
  }

  private async exchange(path: '/auth/muse/challenge' | '/auth/muse/exchange', body?: { requestId: string; code: string }): Promise<unknown> {
    try {
      return await this.call(path, { method: 'POST', body })
    } catch (error) {
      if (!(error instanceof JingliuHttpError)) throw error
      const message = error.status === 403
        ? '镜流未授权当前 Muse 账号，请管理员核对账号绑定和角色。'
        : '镜流未能完成 Muse 登录（HTTP ' + String(error.status) + '）。'
      throw new JingliuHttpError(error.status, 'JINGLIU_MUSE_EXCHANGE_FAILED', message)
    }
  }

  private async assertOwner(owner: string): Promise<void> {
    if (owner !== await this.owner()) throw this.changed()
  }

  private changed(): HarnessError {
    return new HarnessError('镜流工具连接已变更。请核对原账号下已提交的操作，并重新选择项目。', 'JINGLIU_ACCOUNT_CHANGED')
  }

  private async authorize(owner: string): Promise<{ token: string; userId: number }> {
    let token = owner
    let profile: unknown
    if (this.preview) {
      profile = await this.call('/auth/me', {}, { authorization: 'Bearer ' + token })
    } else {
      const challenge = await this.exchange('/auth/muse/challenge')
      if (!isRecord(challenge) || typeof challenge.requestId !== 'string' || !challenge.requestId ||
        typeof challenge.challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(challenge.challenge)) {
        throw new HarnessError('镜流未返回有效的 Muse 登录请求。', 'JINGLIU_INVALID_CHALLENGE')
      }
      const proof = challenge.challenge
      const grant = await this.muse(account => account.workbenchGrant('jingliu', proof))
      if (grant.accountId !== owner) throw this.changed()
      await this.assertOwner(owner)
      profile = await this.exchange('/auth/muse/exchange', { requestId: challenge.requestId, code: grant.code })
      if (!isRecord(profile) || typeof profile.token !== 'string' || !profile.token) {
        throw new HarnessError('镜流未返回有效的工具连接。', 'JINGLIU_INVALID_ACCOUNT')
      }
      token = profile.token
    }
    if (!isRecord(profile) || !isRecord(profile.user) || typeof profile.user.id !== 'number' || !Number.isSafeInteger(profile.user.id)) {
      throw new HarnessError('镜流未返回有效的登录用户。', 'JINGLIU_INVALID_ACCOUNT')
    }
    await this.assertOwner(owner)
    return { token, userId: profile.user.id }
  }

  /** Resolve the active account on the selected deployment.
   * @returns A transport bound to this Muse login and Jingliu user.
   */
  async connection(): Promise<JingliuSession> {
    const origin = this.origin
    if (!origin) throw new HarnessError('请在 Muse 安装配置中选择镜流站点。', 'JINGLIU_UNCONFIGURED')
    this.lifetime.signal.throwIfAborted()
    const owner = await this.owner()
    if (this.active?.owner === owner) return this.active.session
    const session: Promise<JingliuSession> = this.authorize(owner).then(({ token, userId }) => {
      if (this.active?.session !== session) throw this.changed()
      const headers = { authorization: 'Bearer ' + token }
      const check = async () => {
        await this.assertOwner(owner)
        if (this.active?.session !== session) throw this.changed()
      }
      return {
        identity: createHash('sha256').update(origin + '/' + String(userId)).digest('hex'),
        request: async (path: string, options: JingliuRequest = {}) => {
          await check()
          let response: unknown
          try {
            response = await this.call(path, options, headers)
          } catch (error) {
            await check()
            if (error instanceof JingliuHttpError && error.status === 401 && this.active?.session === session) this.active = undefined
            throw error
          }
          await check()
          return response
        },
      }
    })
    const active = { owner, session }
    this.active = active
    try {
      return await session
    } catch (error) {
      if (this.active === active) this.active = undefined
      throw error
    }
  }

  private async disconnect(signal: AbortSignal): Promise<string> {
    const active = this.active
    if (active && active.owner === await this.owner()) {
      try {
        await (await active.session).request('/auth/logout', { method: 'POST', signal })
      } catch (error) {
        if (!(error instanceof JingliuHttpError && error.status === 401)) throw error
      } finally {
        if (this.active === active) this.active = undefined
      }
    }
    return '本次镜流工具连接已结束。下次调用会使用当前 Muse 账号。'
  }
}

export default JingliuConnection
