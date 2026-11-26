/** Provider fixture for free card creation with one saved response lost. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'storyboard-create-readback-fixture'

/** @param {import('@deepseek-ai/cordis').Context} ctx - Owning snapshot context. */
export function apply(ctx) {
  const receipt = { free_creations: 0, inventory_reads: 0, detail_reads: 0, generation_requests: 0 }
  const cards = []
  const save = () => writeFileSync(join(process.cwd(), 'provider-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  save()
  ctx.effect(() => {
    const original = globalThis.fetch
    /** @type {typeof globalThis.fetch} */
    const fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      if (url.origin !== 'https://storyboard-create-readback.invalid') throw new Error('Fixture refuses external traffic')
      if (method === 'PUT' || /generate|submit|task/iu.test(url.pathname)) {
        receipt.generation_requests++; save()
        throw new Error('Fixture does not support generation')
      }
      let data
      if (method === 'POST' && url.pathname.endsWith('/aigc/storyboard')) {
        const body = JSON.parse(String(init?.body))
        if (body.isGenerate !== 0 || body.scriptId !== 2708) throw new Error('Only bound free cards are accepted')
        const id = body.sortOrder + 101
        if (cards.some(card => card.id === id)) throw new Error('Unexpected duplicate free write')
        cards.push({ ...body, id, isGenerate: 1, storyboardMaterialList: [] })
        receipt.free_creations++; save()
        if (id === 102) return new Response('Service unavailable after saving card', { status: 503 })
        data = id
      } else if (method === 'GET' && url.pathname.endsWith('/aigc/storyboard/list') && url.searchParams.get('scriptId') === '2708') {
        receipt.inventory_reads++
        data = { total: cards.length, rows: cards }
      } else if (method === 'GET' && /\/aigc\/storyboard\/10[12]$/u.test(url.pathname)) {
        receipt.detail_reads++
        data = cards.find(card => card.id === Number(url.pathname.split('/').at(-1)))
        if (!data) throw new Error('Card was not saved')
      } else throw new Error('Unexpected provider route')
      save()
      return new Response(JSON.stringify({ code: 200, data }))
    }
    globalThis.fetch = fetch
    return () => { globalThis.fetch = original }
  })
}
