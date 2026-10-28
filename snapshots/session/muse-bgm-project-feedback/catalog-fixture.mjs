/** Serve numbered cloud-catalogue metadata without external network access. */
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

export const name = 'bgm-numbered-catalog-fixture'

/** @param {import('@deepseek-ai/cordis').Context} ctx - Recorded-session fixture owner. */
export function apply(ctx) {
  ctx.effect(() => {
    const previous = globalThis.fetch
    globalThis.fetch = async (input, options) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url === 'https://bgm-snapshot.example/bgm/catalog.json') {
        const indexed = JSON.parse(await readFile(join(process.cwd(), 'index.json'), 'utf8'))
        return new Response(JSON.stringify({ version: 1, tracks: indexed.map((row, index) => ({
          ...row, id: row.sha256, name: basename(row.path), object_key: `bgm/tracks/${index + 1}`,
          url: `https://bgm-snapshot.example/bgm/tracks/${index + 1}`,
        })) }))
      }
      if (url.startsWith('https://bgm-snapshot.example/')) throw new Error('Rejected music must not be downloaded')
      return previous(input, options)
    }
    return () => { globalThis.fetch = previous }
  })
}
