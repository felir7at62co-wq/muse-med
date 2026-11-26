/** Keyless provider sentinel: a stale project must fail before provider traffic. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'storyboard-project-binding-fixture'

/** @param {import('@deepseek-ai/cordis').Context} ctx - owning snapshot context. */
export function apply(ctx) {
  const receiptPath = join(process.cwd(), 'provider-receipt.json')
  const receipt = { requests: 0, storyboard_writes: 0, generation_requests: 0 }
  const save = () => { writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n') }
  save()
  ctx.effect(() => {
    const original = globalThis.fetch
    /** @type {typeof globalThis.fetch} */
    const fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      receipt.requests++
      if ((init?.method ?? (input instanceof Request ? input.method : 'GET')) === 'POST'
        && url.pathname.endsWith('/aigc/storyboard')) receipt.storyboard_writes++
      if (/generate|submit|task/iu.test(url.pathname)) receipt.generation_requests++
      save()
      if (url.origin !== 'https://storyboard-project-binding.invalid') {
        throw new Error('Project-binding fixture refuses external traffic')
      }
      throw new Error('A mismatched project must be rejected before any provider request')
    }
    globalThis.fetch = fetch
    return () => { globalThis.fetch = original }
  })
}
