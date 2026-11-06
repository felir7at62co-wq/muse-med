/** Negative controls for the live account gateway's request and credential limits. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { assertMuseLivePrivacy, MUSE_LIVE_LIMITS, museGatewayLiveConfig, museGatewayLiveTransport } from './muse-gateway-live-fixture.ts'

const environment = {
  MUSE_E2E_BASE_URL: 'https://muse.test', MUSE_E2E_USERNAME: 'fixture-user', MUSE_E2E_PASSWORD: 'fixture-password',
  MUSE_E2E_PROVIDER: 'deepseek-official', MUSE_E2E_MODEL: 'fixture-model',
}
const config = museGatewayLiveConfig(environment)!
const completion = `${config.baseUrl}/api/desktop-models/${config.provider}/chat/completions`
const body = JSON.stringify({ model: config.model, stream: true, max_tokens: MUSE_LIVE_LIMITS.maxTokens })

describe('Muse live gateway admission', () => {
  it('skips only an entirely unconfigured run and requires every configured field', () => {
    expect(museGatewayLiveConfig({})).toBeUndefined()
    expect(museGatewayLiveConfig(environment)).toEqual(config)
    for (const name of Object.keys(environment)) expect(() => museGatewayLiveConfig({ ...environment, [name]: '' })).toThrow(`${name} is required`)
  })

  it.each(['https://muse.test/path', 'https://fixture-user:fixture-password@muse.test', 'http://127.0.0.1', 'https://muse.test?token=fixture-password'])(
    'rejects an origin with unsafe routing or credentials: %s', (baseUrl) => {
      expect(() => museGatewayLiveConfig({ ...environment, MUSE_E2E_BASE_URL: baseUrl })).toThrow()
    },
  )

  it.each(['PROVIDER', 'MODEL'])('rejects invalid %s without echoing its value', (field) => {
    const invalid = 'fixture-password\n'
    let message = ''
    try { museGatewayLiveConfig({ ...environment, [`MUSE_E2E_${field}`]: invalid }) } catch (error) { message = String(error) }
    expect(message).toContain('is invalid')
    expect(message).not.toContain(invalid)
  })

  it.each(['https://supplier.test/v1/chat/completions', 'https://muse.test/api/desktop-models/access', 'https://muse.test/register', 'https://muse.test/api/muse.account?token=fixture-password'])(
    'refuses forbidden network route %s before sending a request', async (url) => {
      const delegate = vi.fn<typeof fetch>()
      await expect(museGatewayLiveTransport(config, delegate).fetcher(url)).rejects.toThrow('refused a request')
      expect(delegate).not.toHaveBeenCalled()
    },
  )

  it('strips direct negotiation and never follows login redirects', async () => {
    const delegate = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 303, headers: { 'set-cookie': '__Host-muse=fixture-session; Path=/; HttpOnly' } }))
    const transport = museGatewayLiveTransport(config, delegate)
    await transport.fetcher(`${config.baseUrl}/login`, { method: 'POST', headers: {
      'x-muse-model-access': 'direct-v1', 'x-muse-provider-routing': 'mixed-v1', 'x-muse-zhipu-direct': 'leased-v1', origin: config.baseUrl,
    } })
    const sent = delegate.mock.calls[0]![1]!
    expect(sent.redirect).toBe('manual')
    expect([...new Headers(sent.headers).keys()]).toEqual(['origin'])
    expect(transport.issuedCookie()).toBe('__Host-muse=fixture-session')
    expect(transport.statistics()).toMatchObject({ calls: 0, paths: ['/login'] })
  })

  it.each([
    { max_tokens: undefined }, { max_tokens: 1025 }, { max_tokens: 0 }, { max_tokens: 1.5 },
    { max_tokens: 1, max_completion_tokens: 1025 }, { max_tokens: undefined, max_completion_tokens: 0 },
    { model: 'another-model' }, { stream: false },
  ])('refuses an inference without the exact model and both bounded token fields: %j', async (override) => {
    const delegate = vi.fn<typeof fetch>()
    const transport = museGatewayLiveTransport(config, delegate)
    const requestBody = JSON.stringify({ model: config.model, stream: true, max_tokens: 1024, ...override })
    await expect(transport.fetcher(completion, { body: requestBody }))
      .rejects.toThrow('selected model and bounded output')
    expect(delegate).not.toHaveBeenCalled()
  })

  it('bounds inference requests and treats a failed response as terminal', async () => {
    const delegate = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 200 }))
    const transport = museGatewayLiveTransport(config, delegate)
    for (let index = 0; index < MUSE_LIVE_LIMITS.calls; index++) await transport.fetcher(completion, { body })
    await expect(transport.fetcher(completion, { body })).rejects.toThrow('budget')
    expect(delegate).toHaveBeenCalledTimes(MUSE_LIVE_LIMITS.calls)
    const failedDelegate = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }))
    const failed = museGatewayLiveTransport(config, failedDelegate)
    await failed.fetcher(completion, { body })
    await expect(failed.fetcher(completion, { body })).rejects.toThrow('prior request failed')
    expect(failedDelegate).toHaveBeenCalledOnce()
  })

  it('holds the single-stream admission until EOF and refuses overlapping inference', async () => {
    const delegate = vi.fn<typeof fetch>().mockImplementation(async () => new Response('data: completed\n\n'))
    const transport = museGatewayLiveTransport(config, delegate)
    const first = await transport.fetcher(completion, { body })
    await expect(transport.fetcher(completion, { body })).rejects.toThrow('budget')
    expect(await first.text()).toBe('data: completed\n\n')
    const second = await transport.fetcher(completion, { body })
    expect(await second.text()).toBe('data: completed\n\n')
    expect(delegate).toHaveBeenCalledTimes(2)
  })

  it('cancels its owned stream before refusing further inference', async () => {
    const cancelled = vi.fn()
    const delegate = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel: cancelled })))
    const transport = museGatewayLiveTransport(config, delegate)
    const response = await transport.fetcher(completion, { body })
    await response.body!.cancel()
    expect(cancelled).toHaveBeenCalledOnce()
    await expect(transport.fetcher(completion, { body })).rejects.toThrow('prior request failed')
    expect(delegate).toHaveBeenCalledOnce()
  })

  it('allows the next inference after the client consumes a split SSE done marker and cancels', async () => {
    const encoder = new TextEncoder()
    const cancelled = vi.fn()
    const delegate = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: [DO'))
        controller.enqueue(encoder.encode('NE]\n\n'))
      },
      cancel: cancelled,
    })))
    const transport = museGatewayLiveTransport(config, delegate)
    const response = await transport.fetcher(completion, { body })
    const reader = response.body!.getReader()
    await reader.read()
    await reader.read()
    await reader.cancel()
    expect(cancelled).toHaveBeenCalledOnce()
    const next = await transport.fetcher(completion, { body })
    await next.body!.cancel()
    expect(delegate).toHaveBeenCalledTimes(2)
  })

  it('waits for terminal-event cancellation before admitting its next request', async () => {
    const encoder = new TextEncoder()
    let finishCancel!: () => void
    const barrier = new Promise<void>((resolve) => { finishCancel = resolve })
    const delegate = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode('data: [DONE]\n\n')) },
      cancel: () => barrier,
    }))).mockResolvedValue(new Response(null))
    const transport = museGatewayLiveTransport(config, delegate)
    const first = await transport.fetcher(completion, { body })
    const reader = first.body!.getReader()
    await reader.read()
    const cancelling = reader.cancel()
    const next = transport.fetcher(completion, { body })
    expect(delegate).toHaveBeenCalledOnce()
    finishCancel()
    await cancelling
    await next
    expect(delegate).toHaveBeenCalledTimes(2)
  })

  it('keeps a completed SSE response successful when its request aborts during teardown', async () => {
    const request = new AbortController()
    const encoder = new TextEncoder()
    const delegate = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        request.signal.addEventListener('abort', () => { controller.error(new Error('Consumer stopped after completion')) }, { once: true })
      },
    }))).mockResolvedValue(new Response(null))
    const transport = museGatewayLiveTransport(config, delegate)
    const first = await transport.fetcher(completion, { body, signal: request.signal })
    const reader = first.body!.getReader()
    await reader.read()
    request.abort()
    await reader.read()
    await transport.fetcher(completion, { body })
    expect(transport.statistics()).toMatchObject({ calls: 2, failed: false })
  })

  it('aborts its scenario and waits for owned stream teardown before allowing logout cleanup', async () => {
    const scenario = new AbortController()
    const cancelled = vi.fn()
    const delegate = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new ReadableStream({ cancel: cancelled })))
      .mockResolvedValue(new Response(null, { status: 303 }))
    const transport = museGatewayLiveTransport(config, delegate, scenario.signal)
    await transport.fetcher(completion, { body })
    scenario.abort()
    await transport.dispose()
    expect(cancelled).toHaveBeenCalledOnce()
    await expect(transport.fetcher(`${config.baseUrl}/api/muse.account`)).rejects.toThrow('credentials and response data are withheld')
    await transport.fetcher(`${config.baseUrl}/logout`, { method: 'POST' })
    const logoutSignal = delegate.mock.calls[1]![1]!.signal
    expect(logoutSignal?.aborted).toBe(false)
    expect(delegate).toHaveBeenCalledTimes(2)
  })

  it.each(['dispose', 'scenario-abort'])('settles the external reader and awaits inner cancellation during %s', async (mode) => {
    const scenario = new AbortController()
    const entered = Promise.withResolvers<undefined>()
    const released = Promise.withResolvers<undefined>()
    const delegate = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({
      async cancel() { entered.resolve(undefined); await released.promise },
    })))
    const transport = museGatewayLiveTransport(config, delegate, scenario.signal)
    const response = await transport.fetcher(completion, { body })
    const reader = response.body!.getReader()
    const observed = vi.fn()
    const read = reader.read().then((value) => { observed({ done: value.done }) }, (error: unknown) => {
      observed(error instanceof Error ? { name: error.name, message: error.message } : { name: 'unknown' })
    })
    onTestFinished(async () => {
      released.resolve(undefined)
      await Promise.allSettled([reader.cancel(), read, transport.dispose()])
    })
    if (mode === 'scenario-abort') scenario.abort()
    let disposed = false
    const disposing = transport.dispose().then(() => { disposed = true })
    await entered.promise
    expect(disposed).toBe(false)
    released.resolve(undefined)
    await disposing
    await Promise.resolve()
    expect(observed).toHaveBeenCalledOnce()
    expect(observed).toHaveBeenCalledWith({ name: 'AbortError', message: 'Live Muse acceptance stopped its owned response stream' })
    await read
  })

  it('withholds stream errors and refuses a retry after an interrupted stream', async () => {
    const delegate = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.error(new Error('fixture-password fixture-session')) },
    })))
    const transport = museGatewayLiveTransport(config, delegate)
    const response = await transport.fetcher(completion, { body })
    await expect(response.text()).rejects.toThrow('response data is withheld')
    await expect(transport.fetcher(completion, { body })).rejects.toThrow('prior request failed')
    expect(delegate).toHaveBeenCalledOnce()
  })

  it('does not disclose account or response values when transport fails or Session privacy fails', async () => {
    const delegate = vi.fn<typeof fetch>().mockRejectedValue(new Error('fixture-password fixture-session'))
    const transport = museGatewayLiveTransport(config, delegate)
    await expect(transport.fetcher(completion, { body })).rejects.toThrow('credentials and response data are withheld')
    expect(() => { assertMuseLivePrivacy('public Session', ['fixture-password']) }).not.toThrow()
    expect(() => { assertMuseLivePrivacy('fixture-password', ['fixture-password']) }).toThrow('contains private account values')
  })
})
