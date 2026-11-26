/** Keyless provider response for a page missing rows within the reported episode total. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'episode-catalog-empty-fixture'

/** @param {import('@deepseek-ai/cordis').Context} ctx - owning snapshot context. */
export function apply(ctx) {
  const receiptPath = join(process.cwd(), 'provider-receipt.json')
  const receipt = { episode_reads: 0, unexpected_requests: 0 }
  const save = () => { writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n') }
  save()
  ctx.effect(() => {
    const original = globalThis.fetch
    /** @type {typeof globalThis.fetch} */
    const fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      if (method !== 'GET' || url.href !== 'https://episode-catalog-empty.invalid/prod-api/aigc/episode/list?scriptId=2708&pageNum=2&pageSize=10') {
        receipt.unexpected_requests++
        save()
        throw new Error('Episode catalogue fixture refuses unexpected provider traffic')
      }
      receipt.episode_reads++
      save()
      return Response.json({ code: 200, data: { total: 13, rows: [] } })
    }
    globalThis.fetch = fetch
    return () => { globalThis.fetch = original }
  })
}
