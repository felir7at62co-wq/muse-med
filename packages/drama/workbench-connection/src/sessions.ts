/** Host-side sessions of one Muse workbench for the signed-in Muse account. @module */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { MuseAccountService } from '@deepseek-ai/dsh-muse-account'
import type { MuseWorkbenchAudience } from '@deepseek-ai/dsh-muse-account/types'
import { isRecord, requestJson, WorkbenchHttpError } from './http.ts'
import type { WorkbenchLabel, WorkbenchRequest } from './http.ts'

/** Fixed facts of one workbench application, shared by all of its deployments. */
export interface WorkbenchDefinition extends WorkbenchLabel {
  /** Audience registered at the Muse gateway. */
  readonly audience: MuseWorkbenchAudience
  /** Path segment of the workbench when the Muse gateway serves it. */
  readonly mount: string
  /** API root below the deployment, such as `/fwp/v2`. */
  readonly api: string
  /** Field of the exchange response that holds the native credential. */
  readonly credential: string
  /** Read the user object from the current-user route's response. */
  readonly profileUser: (profile: Record<string, unknown>) => unknown
  /** Message of the `<code>_ACCOUNT_CHANGED` failure. */
  readonly changed: string
}

/** One deployment of a workbench. */
export interface WorkbenchDeployment {
  /** Origin already validated with `workbenchOrigin`; one ending in the mount path is served by the Muse gateway. */
  readonly origin: string | undefined
  /** Maximum time in milliseconds for one JSON request, including its response body. */
  readonly timeoutMs: number
  /** Native credential of an isolated loopback test session, read at connection time instead of the Muse login. */
  readonly previewToken?: () => string | undefined
}

/** One verified workbench user for the Muse login it was opened with. */
export interface WorkbenchSession {
  /** Stable digest of the deployment and native user ID. */
  readonly identity: string
  /** Deployment the session belongs to. */
  readonly origin: string
  /** Request a route below the workbench API as this user.
   * @param path - Route relative to the API root.
   * @param options - Method, payload and optional cancellation signal.
   * @returns The parsed service response.
   */
  request(path: string, options?: WorkbenchRequest): Promise<unknown>
  /** Fetch an address of this deployment as this user without checking the login; callers call `check()` around it.
   * @param url - Address on the deployment origin.
   * @param init - Request fields; authorization, redirect and lifetime are added.
   * @returns The raw upstream response.
   */
  fetch(url: URL, init: RequestInit): Promise<Response>
  /** Reject when the Muse login changed or this session was replaced. */
  check(): Promise<void>
}

interface ActiveConnection {
  readonly owner: string
  readonly session: Promise<WorkbenchSession>
}

/** Resolves user grants at execution time, keeping native credentials outside model input and output. */
export class WorkbenchSessions {
  private readonly lifetime = new AbortController()
  private readonly mounted: boolean
  private active: ActiveConnection | undefined

  /**
   * Follow Muse login changes and stop all requests when the owning plugin is disposed.
   * @param ctx - Context of the owning connection service.
   * @param definition - Workbench application.
   * @param deployment - Configured deployment.
   * @param onAccountChange - Called after a Muse login change discarded the active session.
   */
  constructor(private readonly ctx: Context, readonly definition: WorkbenchDefinition,
    private readonly deployment: WorkbenchDeployment, onAccountChange?: () => void) {
    this.mounted = deployment.origin?.endsWith('/' + definition.mount) === true
    if (!deployment.origin) return
    if (!deployment.previewToken) {
      ctx.on('muse-account/session-changed', () => { this.active = undefined; onAccountChange?.() })
    }
    ctx.effect(() => () => { this.active = undefined; this.lifetime.abort() }, definition.audience + ' account lifetime')
  }

  /** Lifetime of the owning service; aborted on disposal. */
  get signal(): AbortSignal { return this.lifetime.signal }

  /**
   * Run an operation of the Muse account service and name its failures for this workbench.
   * @param operation - Account call.
   * @returns The call's result.
   */
  async muse<T>(operation: (account: MuseAccountService) => Promise<T>): Promise<T> {
    const account = this.ctx.get('museAccount')
    const code = this.definition.code
    if (!account) throw new HarnessError('请先在 Muse 的账号设置中登录。', code + '_SIGN_IN_REQUIRED')
    try {
      return await operation(account)
    } catch (error) {
      if (isRecord(error) && error.code === 'invalid-credentials') {
        throw new HarnessError('请在 Muse 的账号设置中重新登录。', code + '_SIGN_IN_REQUIRED', { cause: error })
      }
      throw new HarnessError('无法验证 Muse 登录状态，请检查账号服务后重试。', code + '_MUSE_AUTH_UNAVAILABLE', { cause: error })
    }
  }

  /** Read the login whose session a new connection uses.
   * @returns The private Muse login identifier, or the preview credential.
   */
  async owner(): Promise<string> {
    if (!this.deployment.previewToken) return this.muse(account => account.workbenchIdentity())
    const token = this.deployment.previewToken()
    if (token) return token
    throw new HarnessError(this.definition.name + '本地预览尚未配置测试会话。', this.definition.code + '_SIGN_IN_REQUIRED')
  }

  /** The failure reported when the login or session changed during an operation.
   * @returns A new `<code>_ACCOUNT_CHANGED` error.
   */
  changed(): HarnessError {
    return new HarnessError(this.definition.changed, this.definition.code + '_ACCOUNT_CHANGED')
  }

  private transport(owner: string): (url: URL, init: RequestInit) => Promise<Response> {
    return (url, init) => this.muse(account => account.requestMountedWorkbench(this.definition.audience, owner, url, init))
  }

  private async call(
    origin: string, path: string, options: WorkbenchRequest, headers?: Record<string, string>, mountedOwner?: string,
  ): Promise<unknown> {
    const signal = options.signal === undefined ? this.lifetime.signal : AbortSignal.any([options.signal, this.lifetime.signal])
    return await requestJson(this.definition, origin + this.definition.api, path, this.deployment.timeoutMs, {
      ...options, signal, ...(headers && { headers }), ...(mountedOwner === undefined ? {} : { transport: this.transport(mountedOwner) }),
    })
  }

  /** Run one sign-in request and name a refused or failed sign-in for this workbench. */
  private async signIn(step: () => Promise<unknown>): Promise<unknown> {
    try {
      return await step()
    } catch (error) {
      if (!(error instanceof WorkbenchHttpError)) throw error
      const { name, code } = this.definition
      const message = error.status === 403
        ? name + '未授权当前 Muse 账号，请管理员核对账号绑定和角色。'
        : name + '未能完成 Muse 登录（HTTP ' + String(error.status) + '）。'
      throw new WorkbenchHttpError(error.status, code + '_MUSE_EXCHANGE_FAILED', message)
    }
  }

  private async assertOwner(owner: string): Promise<void> {
    if (owner !== await this.owner()) throw this.changed()
  }

  private async authorize(origin: string, owner: string): Promise<{ token: string; userId: number }> {
    const { name, code, audience, credential } = this.definition
    let token = owner
    let user: unknown
    if (this.mounted) {
      const profile = await this.signIn(() => this.call(origin, '/auth/me', {}, undefined, owner))
      user = isRecord(profile) ? this.definition.profileUser(profile) : undefined
    } else if (this.deployment.previewToken) {
      const profile = await this.signIn(() => this.call(origin, '/auth/me', {}, { authorization: 'Bearer ' + token }))
      user = isRecord(profile) ? this.definition.profileUser(profile) : undefined
    } else {
      const challenge = await this.signIn(() => this.call(origin, '/auth/muse/challenge', { method: 'POST' }))
      if (!isRecord(challenge) || typeof challenge.requestId !== 'string' || !challenge.requestId ||
        typeof challenge.challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(challenge.challenge)) {
        throw new HarnessError(name + '未返回有效的 Muse 登录请求。', code + '_INVALID_CHALLENGE')
      }
      const proof = challenge.challenge
      const grant = await this.muse(account => account.workbenchGrant(audience, proof))
      if (grant.accountId !== owner) throw this.changed()
      await this.assertOwner(owner)
      const body = { requestId: challenge.requestId, code: grant.code }
      const profile = await this.signIn(() => this.call(origin, '/auth/muse/exchange', { method: 'POST', body }))
      if (!isRecord(profile) || typeof profile[credential] !== 'string' || !profile[credential]) {
        throw new HarnessError(name + '未返回有效的工具连接。', code + '_INVALID_ACCOUNT')
      }
      token = profile[credential]
      user = profile.user
    }
    if (!isRecord(user) || typeof user.id !== 'number' || !Number.isSafeInteger(user.id)) {
      throw new HarnessError(name + '未返回有效的登录用户。', code + '_INVALID_ACCOUNT')
    }
    await this.assertOwner(owner)
    return { token, userId: user.id }
  }

  /** Resolve the active account on the configured deployment.
   * @returns A session bound to this Muse login and workbench user; concurrent callers share one sign-in.
   */
  async connection(): Promise<WorkbenchSession> {
    const origin = this.deployment.origin
    const { name, code } = this.definition
    if (!origin) throw new HarnessError('请在 Muse 安装配置中选择' + name + '站点。', code + '_UNCONFIGURED')
    this.lifetime.signal.throwIfAborted()
    const owner = await this.owner()
    if (this.active?.owner === owner) return this.active.session
    const session: Promise<WorkbenchSession> = this.authorize(origin, owner).then(({ token, userId }) => {
      if (this.active?.session !== session) throw this.changed()
      const headers = this.mounted ? undefined : { authorization: 'Bearer ' + token }
      const transport = this.mounted ? this.transport(owner) : fetch
      const check = async () => {
        await this.assertOwner(owner)
        if (this.active?.session !== session) throw this.changed()
      }
      return {
        identity: createHash('sha256').update(origin + '/' + String(userId)).digest('hex'),
        origin,
        check,
        fetch: async (url: URL, init: RequestInit) => {
          const signal = init.signal ? AbortSignal.any([init.signal, this.lifetime.signal]) : this.lifetime.signal
          const merged = new Headers(init.headers)
          if (headers) merged.set('authorization', headers.authorization)
          return await transport(url, { ...init, headers: merged, redirect: 'error', signal })
        },
        request: async (path: string, options: WorkbenchRequest = {}) => {
          await check()
          let response: unknown
          try {
            response = await this.call(origin, path, options, headers, this.mounted ? owner : undefined)
          } catch (error) {
            await check()
            if (error instanceof WorkbenchHttpError && error.status === 401 && this.active?.session === session) this.active = undefined
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

  /**
   * End the active session; the next call signs in again with the current Muse login.
   * A dedicated deployment revokes the native credential first; the Muse gateway owns a mounted deployment's credential.
   * @param signal - Command lifetime.
   */
  async disconnect(signal: AbortSignal): Promise<void> {
    const active = this.active
    if (this.mounted) this.active = undefined
    else if (active && active.owner === await this.owner()) {
      try {
        await (await active.session).request('/auth/logout', { method: 'POST', signal })
      } catch (error) {
        if (!(error instanceof WorkbenchHttpError && error.status === 401)) throw error
      } finally {
        if (this.active === active) this.active = undefined
      }
    }
  }
}
