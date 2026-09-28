/** HTTP adapter for the MUSE account gateway. Credentials stay in request bodies. */

/** Stable failure classes that can cross the authenticated Remote interface. */
export type MuseGatewayFailure =
  | 'invalid-credentials'
  | 'username-taken'
  | 'rate-limited'
  | 'registration-disabled'
  | 'gateway-unavailable'
  | 'gateway-rejected'

/** Gateway failure without response bodies or credential-bearing request data. */
export class MuseGatewayError extends Error {
  constructor(readonly code: MuseGatewayFailure) {
    super(`MUSE account gateway: ${code}`)
    this.name = 'MuseGatewayError'
  }
}

/** Gateway fields the account UI may report. */
export interface MuseAccountIdentity {
  readonly username: string
  readonly environment?: string
  readonly workspaceLabel?: string
}

/** Network operations over one configured MUSE origin. */
export interface MuseAccountGateway {
  signIn(username: string, password: string): Promise<string>
  register(username: string, password: string): Promise<string>
  identity(cookie: string): Promise<MuseAccountIdentity>
  signOut(cookie: string): Promise<void>
}

/**
 * Canonicalize one MUSE gateway origin before any request or session read.
 * @param raw - HTTP(S) origin configured by the Desktop product.
 * @returns Canonical origin without a path.
 */
export function museGatewayOrigin(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('muse-account: baseUrl must be an HTTP(S) URL')
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('muse-account: baseUrl must be an HTTPS or loopback HTTP origin without credentials or a path')
  }
  return url.origin
}

/**
 * Create a gateway client for the configured origin.
 * @param baseUrl - Canonical gateway origin.
 * @param requestTimeoutMs - Validated product request timeout.
 * @param fetcher - Fetch implementation; defaults to Node's global fetch.
 * @returns Sign-in, registration, identity and sign-out operations.
 */
export function createMuseAccountGateway(baseUrl: string, requestTimeoutMs: number, fetcher: typeof fetch = fetch): MuseAccountGateway {
  const origin = museGatewayOrigin(baseUrl)

  async function request(path: string, options: RequestInit): Promise<Response> {
    try {
      return await fetcher(new URL(path, origin), {
        ...options,
        redirect: 'manual',
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
    } catch {
      throw new MuseGatewayError('gateway-unavailable')
    }
  }

  async function post(path: string, body: URLSearchParams, cookie?: string): Promise<Response> {
    return await request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin,
        ...(cookie === undefined ? {} : { cookie }),
      },
      body,
    })
  }

  function issuedCookie(response: Response): string {
    const header = response.headers.getSetCookie().find(value => value.startsWith('__Host-muse='))
    const cookie = header?.split(';', 1)[0]?.trim()
    if (response.status !== 303 || cookie === undefined || !/^__Host-muse=[^;\s]+$/u.test(cookie)) {
      throw new MuseGatewayError('gateway-rejected')
    }
    return cookie
  }

  return {
    async signIn(username, password) {
      const response = await post('/login', new URLSearchParams({ username, password }))
      if (response.status === 401) throw new MuseGatewayError('invalid-credentials')
      if (response.status === 429) throw new MuseGatewayError('rate-limited')
      return issuedCookie(response)
    },
    async register(username, password) {
      const response = await post('/register', new URLSearchParams({ username, password }))
      if (response.status === 429) throw new MuseGatewayError('rate-limited')
      if (response.status === 403) throw new MuseGatewayError('registration-disabled')
      if (response.status === 409) throw new MuseGatewayError('username-taken')
      if (response.status === 400) {
        const body = await response.text().catch(() => '')
        if (/\u7528\u6237\u540d\u5df2\u88ab\u4f7f\u7528/u.test(body)) throw new MuseGatewayError('username-taken')
      }
      return issuedCookie(response)
    },
    async identity(cookie) {
      const response = await request('/api/muse.account', { headers: { cookie, accept: 'application/json' } })
      if (response.status === 303 || response.status === 401) throw new MuseGatewayError('invalid-credentials')
      if (!response.ok) throw new MuseGatewayError('gateway-rejected')
      let value: unknown
      try {
        value = await response.json()
      } catch {
        throw new MuseGatewayError('gateway-rejected')
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new MuseGatewayError('gateway-rejected')
      }
      const fields = value as Record<string, unknown>
      if (typeof fields.username !== 'string' || fields.username.length === 0) {
        throw new MuseGatewayError('gateway-rejected')
      }
      return {
        username: fields.username,
        ...(typeof fields.environment === 'string' ? { environment: fields.environment } : {}),
        ...(typeof fields.workspaceLabel === 'string' ? { workspaceLabel: fields.workspaceLabel } : {}),
      }
    },
    async signOut(cookie) {
      const response = await post('/logout', new URLSearchParams(), cookie)
      if (response.status !== 303 && !response.ok) throw new MuseGatewayError('gateway-rejected')
    },
  }
}
