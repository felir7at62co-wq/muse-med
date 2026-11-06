/** Account-scoped, relay-only HTTP admission for live Muse acceptance. */
import { museGatewayOrigin } from '../src/gateway.ts'

/** Explicit account and model selected for one live gateway acceptance run. */
export interface MuseGatewayLiveConfig {
  readonly baseUrl: string
  readonly username: string
  readonly password: string
  readonly provider: string
  readonly model: string
}

/** Per-scenario network and output budgets; no retry may exceed these limits. */
export const MUSE_LIVE_LIMITS = {
  calls: 3, maxTokens: 1024, requestTimeoutMs: 90_000, scenarioTimeoutMs: 180_000, cleanupTimeoutMs: 30_000,
} as const

/**
 * Require a complete live configuration whenever any live variable is present.
 * @param environment - Operator-provided environment, without logging its values.
 * @returns A validated configuration, or undefined for an entirely keyless run.
 */
export function museGatewayLiveConfig(environment: Readonly<Record<string, string | undefined>>): MuseGatewayLiveConfig | undefined {
  const names = ['BASE_URL', 'USERNAME', 'PASSWORD', 'PROVIDER', 'MODEL'] as const
  if (names.every(name => !environment[`MUSE_E2E_${name}`])) return undefined
  for (const name of names) {
    if (!environment[`MUSE_E2E_${name}`]?.trim()) throw new Error(`MUSE_E2E_${name} is required for live gateway acceptance`)
  }
  const baseUrl = museGatewayOrigin(environment.MUSE_E2E_BASE_URL!)
  if (!baseUrl.startsWith('https://')) throw new Error('MUSE_E2E_BASE_URL must use HTTPS')
  const provider = environment.MUSE_E2E_PROVIDER!
  const model = environment.MUSE_E2E_MODEL!
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(provider)) throw new Error('MUSE_E2E_PROVIDER is invalid')
  if (model.length > 200 || /[\r\n]/u.test(model)) throw new Error('MUSE_E2E_MODEL is invalid')
  return { baseUrl, username: environment.MUSE_E2E_USERNAME!, password: environment.MUSE_E2E_PASSWORD!, provider, model }
}

/**
 * Pass real HTTP through one origin while refusing supplier access and excess inference.
 * @param config - Explicit gateway, account and model for this scenario.
 * @param delegate - Real fetch in the live test; an instance-local transport in unit checks.
 * @param scenarioSignal - Overall scenario deadline, excluding its separate logout cleanup.
 * @returns Fetch, non-sensitive request counts, and the issued cookie for owned cleanup only.
 */
export function museGatewayLiveTransport(config: MuseGatewayLiveConfig, delegate: typeof fetch, scenarioSignal?: AbortSignal) {
  const completionPath = `/api/desktop-models/${config.provider}/chat/completions`
  const allowed = new Set(['/login', '/logout', '/api/muse.account', '/api/muse.activity', '/api/desktop-models/providers', completionPath])
  let calls = 0
  let active = false
  let failed = false
  let terminal = false
  let settled = Promise.resolve()
  let release = (): void => {}
  const stopping = new AbortController()
  const requests = new Set<Promise<Response>>()
  const streams = new Set<() => Promise<void>>()
  let disposal: Promise<void> | undefined
  let cleanupSignal: AbortSignal | undefined
  const dispose = (): Promise<void> => {
    if (disposal) return disposal
    stopping.abort()
    scenarioSignal?.removeEventListener('abort', abort)
    disposal = (async () => {
      await Promise.allSettled([...requests])
      await Promise.allSettled([...streams].map(cancel => cancel()))
    })()
    return disposal
  }
  function abort(): void { void dispose() }
  scenarioSignal?.addEventListener('abort', abort, { once: true })
  let cookie: string | undefined
  const paths: string[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== config.baseUrl || url.search || url.hash || !allowed.has(url.pathname)) {
      throw new Error('Live Muse acceptance refused a request outside its gateway relay routes')
    }
    const headers = new Headers(init?.headers ?? request?.headers)
    for (const name of ['x-muse-model-access', 'x-muse-provider-routing', 'x-muse-zhipu-direct']) headers.delete(name)
    const completion = url.pathname === completionPath
    if (completion) {
      // The SDK may start its next step while terminal-event cancellation settles.
      if (active && terminal) await settled
      if (failed || active || calls >= MUSE_LIVE_LIMITS.calls) throw new Error('Live Muse inference budget is exhausted or a prior request failed')
      if (typeof init?.body !== 'string') throw new Error('Live Muse inference requires an explicit JSON body')
      const body: unknown = JSON.parse(init.body)
      if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('Live Muse inference body is invalid')
      const fields = body as Record<string, unknown>
      const budgets = [fields.max_tokens, fields.max_completion_tokens].filter(value => value !== undefined)
      if (fields.model !== config.model || fields.stream !== true || budgets.length === 0
        || budgets.some(value => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MUSE_LIVE_LIMITS.maxTokens)) {
        throw new Error('Live Muse inference must retain its selected model and bounded output')
      }
      active = true
      terminal = false
      settled = new Promise<void>((resolve) => { release = resolve })
      calls++
    }
    paths.push(url.pathname)
    try {
      const signal = AbortSignal.any([
        AbortSignal.timeout(MUSE_LIVE_LIMITS.requestTimeoutMs),
        ...url.pathname === '/logout'
          ? [cleanupSignal ??= AbortSignal.timeout(MUSE_LIVE_LIMITS.cleanupTimeoutMs)]
          : [stopping.signal, ...scenarioSignal ? [scenarioSignal] : []],
        ...init?.signal ? [init.signal] : request?.signal ? [request.signal] : [],
      ])
      signal.throwIfAborted()
      const pending = delegate(input, { ...init, headers, signal, redirect: 'manual' })
      requests.add(pending)
      let response: Response
      try { response = await pending }
      finally { requests.delete(pending) }
      if (url.pathname === '/login') cookie = response.headers.getSetCookie().find(value => value.startsWith('__Host-muse='))?.split(';', 1)[0]
      if (completion && response.ok && response.body) {
        const reader = response.body.getReader()
        let finished = false
        let cancelling = false
        let cancellation: Promise<void> | undefined
        let outerController!: ReadableStreamDefaultController<Uint8Array>
        let done = false
        let tail = ''
        const decoder = new TextDecoder()
        const finish = (failure: boolean): void => {
          if (finished) return
          if (failure) failed = true
          finished = true
          active = false
          streams.delete(disposeStream)
          reader.releaseLock()
          release()
        }
        function cancelStream(reason?: unknown): Promise<void> {
          if (cancellation) return cancellation
          cancelling = true
          cancellation = (async () => {
            try { await reader.cancel(reason) }
            finally { finish(!done) }
          })()
          return cancellation
        }
        async function disposeStream(): Promise<void> {
          if (finished) return
          outerController.error(new DOMException('Live Muse acceptance stopped its owned response stream', 'AbortError'))
          await cancelStream()
        }
        streams.add(disposeStream)
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { outerController = controller },
          async pull(controller) {
            try {
              const next = await reader.read()
              if (next.done) {
                if (!cancelling) { finish(false); controller.close() }
              }
              else {
                const text = tail + decoder.decode(next.value, { stream: true })
                done ||= /(?:^|[\r\n])data: ?\[DONE\](?:\r\n|\r|\n)(?:\r\n|\r|\n)/u.test(text)
                terminal = done
                tail = text.slice(-64)
                controller.enqueue(next.value)
              }
            } catch (_error) {
              if (finished || cancelling) return
              finish(!done)
              if (done) controller.close()
              else controller.error(new Error('Live Muse gateway stream failed; response data is withheld'))
            }
          },
          // SSE consumers cancel the HTTP body after its explicit [DONE] event.
          cancel: cancelStream,
        }), { status: response.status, statusText: response.statusText, headers: response.headers })
      }
      if (completion) { active = false; release(); if (!response.ok) failed = true }
      return response
    } catch (_error) {
      if (completion) { failed = true; active = false; release() }
      throw new Error('Live Muse gateway request failed; credentials and response data are withheld')
    }
  }
  return {
    fetcher, statistics: () => ({ calls, paths: [...paths], active, terminal, failed }), issuedCookie: () => cookie,
    dispose,
  }
}

/**
 * Check serialized Session data without putting private values in assertion errors.
 * @param text - Serialized Session events or public settings.
 * @param privateValues - Account identity, password and issued session credentials.
 */
export function assertMuseLivePrivacy(text: string, privateValues: readonly string[]): void {
  if (privateValues.some(value => value.length > 0 && text.includes(value))) throw new Error('Live Muse Session data contains private account values')
}
