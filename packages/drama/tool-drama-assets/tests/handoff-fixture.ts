/** In-memory provider for exercising existing selection tools; no network fallback. */
import { JubianClient } from '@deepseek-ai/dsh-jubian'
import { card, reuseProvider } from './reuse-fixture.ts'

/** Simulate only project reads and free saves to two authored storyboard IDs. */
export function handoffProvider(options: Parameters<typeof reuseProvider>[0] = {}) {
  const reads = reuseProvider(options)
  const boards = new Map([901, 902].map(id => [id, card(id)]))
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const method = init?.method ?? 'GET'
    const call: (typeof calls)[number] = { method, path: url.pathname + url.search }
    calls.push(call)
    if (!['match-preview.invalid', 'web.jubianai.net'].includes(url.hostname)) throw new Error('Unexpected test origin')
    if (method === 'PUT' && url.pathname === '/prod-api/aigc/storyboard') {
      if (typeof init?.body !== 'string') throw new Error('Missing JSON request')
      const parsed: unknown = JSON.parse(init.body)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid request')
      const body = parsed as Record<string, unknown>
      if (body.isGenerate !== 0 || body.scriptId !== 2708 || typeof body.id !== 'number' || !boards.has(body.id)) {
        throw new Error('Only exact fixture cards and free saves are allowed')
      }
      call.body = structuredClone(body)
      boards.set(body.id, structuredClone(body))
      return new Response(JSON.stringify({ code: 200, data: body.id }), { status: 200 })
    }
    if (method !== 'GET') throw new Error('Paid or unsupported write rejected')
    if (url.pathname === '/prod-api/admin/aigc/video/task/list') {
      return new Response(JSON.stringify({ code: 200, data: { total: 0, rows: [] } }), { status: 200 })
    }
    if (url.pathname.startsWith('/prod-api/aigc/storyboard/')) {
      const id = Number(url.pathname.split('/').at(-1))
      return new Response(JSON.stringify({ code: 200, data: boards.get(id) }), { status: 200 })
    }
    return reads.fetch(input, init)
  }
  return { calls, boards, fetch: fetcher,
    client: new JubianClient({ credential: async () => 'offline-test-token', fetch: fetcher }) }
}
