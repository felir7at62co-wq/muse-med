import { clientBundle } from '../tsdown.client.ts'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundle = clientBundle('@deepseek-ai/dsh-client-ui-muse-account', ['lib/types/index.js'])
const clientSources = fileURLToPath(new URL('./src/client/', import.meta.url))
const stylesheet = fileURLToPath(new URL('./src/client/MarketCharacter.module.css', import.meta.url)).replaceAll('\\', '/')
const portrait = fileURLToPath(new URL('./src/client/muse-purple-spider.png', import.meta.url))

export default ((options) => bundle(options).map(config => ({
  ...config,
  plugins: [...(config.plugins ?? []), {
    name: 'market-muse-portrait',
    async transform(code: string, id: string) {
      const normalizedId = id.replaceAll('\\', '/')
      if (/\/(?:src|lib\/types)\/client\/(?:market-preset-portrait-urls|market-stock-art|MarketCatalogArtwork)\.[jt]sx?$/.test(normalizedId)) {
        // Both source and tsc output resolve assets from the source tree before bundling.
        const urls = new Map([...code.matchAll(/new URL\((['"])(\.\/assets\/[a-z0-9/.-]+\.(png|webp))\1, import\.meta\.url\)\.href/g)]
          .map(match => [match[0], { relative: match[2], format: match[3] }]))
        const replacements = await Promise.all([...urls].map(async ([expression, { relative, format }]) => {
          const file = resolve(clientSources, relative)
          this.addWatchFile(file)
          const image = await readFile(file)
          return [expression, JSON.stringify(`data:image/${format};base64,${image.toString('base64')}`)] as const
        }))
        for (const [expression, uri] of replacements) code = code.replaceAll(expression, () => uri)
        return { code, map: null }
      }
      if (id.replaceAll('\\', '/') !== `\0dsh-css:${stylesheet}.mjs`) return null
      const imageUrl = './muse-purple-spider.png'
      if (!code.includes(imageUrl)) return null
      this.addWatchFile(portrait)
      const image = await readFile(portrait)
      return { code: code.replaceAll(imageUrl, `data:image/png;base64,${image.toString('base64')}`), map: null }
    },
  }],
}))) satisfies typeof bundle
