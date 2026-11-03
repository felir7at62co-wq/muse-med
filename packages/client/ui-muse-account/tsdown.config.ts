import { clientBundle } from '../tsdown.client.ts'
import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundle = clientBundle('@deepseek-ai/dsh-client-ui-muse-account', ['lib/types/index.js'])
const stylesheet = fileURLToPath(new URL('./src/client/MarketCharacter.module.css', import.meta.url)).replaceAll('\\', '/')
const portrait = fileURLToPath(new URL('./src/client/muse-purple-spider.png', import.meta.url))

export default ((options) => bundle(options).map(config => ({
  ...config,
  plugins: [...(config.plugins ?? []), {
    name: 'market-muse-portrait',
    async transform(code: string, id: string) {
      const normalizedId = id.replaceAll('\\', '/')
      if (/\/src\/client\/market-(preset-portrait-urls|stock-art)\.ts$/.test(normalizedId)) {
        // The desktop client plugin is loaded as code, without an adjacent asset directory.
        const assets = [...new Set(code.match(/new URL\('\.\/assets\/[a-z0-9/.-]+\.(?:png|webp)', import\.meta\.url\)\.href/g))]
        const replacements = await Promise.all(assets.map(async expression => {
          const relative = expression.split("'")[1]!
          const file = resolve(dirname(id), relative)
          this.addWatchFile(file)
          const image = await readFile(file)
          const format = relative.endsWith('.png') ? 'png' : 'webp'
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
