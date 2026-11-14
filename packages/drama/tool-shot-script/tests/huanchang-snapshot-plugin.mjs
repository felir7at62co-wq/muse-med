/** Real shot-review compiler with the recorded Huanchang catalogue as its only transport. */
import { readFile } from 'node:fs/promises'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'

const artifact = process.env.DSH_EXAMPLE_MODE === 'lib'
const compiler = await import(new URL(artifact ? '../lib/index.js' : '../src/index.ts', import.meta.url))
const video = await import(artifact ? '@deepseek-ai/dsh-tool-jubian' : '@deepseek-ai/dsh-tool-jubian/src/video-session.ts')
const catalogue = JSON.parse(await readFile(new URL('../../../jubian/jubian-api/tests/fixtures/catalogue-huanchang-20261114.json', import.meta.url), 'utf8'))

export const Config = compiler.Config

/** Mount production owners while permitting only the recorded catalogue GET. */
export function apply(ctx, config) {
  const client = new JubianClient({ baseUrl: 'https://catalogue.invalid', credential: async () => 'fixture-token',
    fetch: async (url, init) => {
      const address = new URL(url instanceof Request ? url.url : url.toString())
      if ((init?.method ?? 'GET') !== 'GET' || address.pathname !== '/model/charge/getSelectList' || address.search !== '?taskType=1') {
        throw new Error('The Huanchang compiler snapshot permits catalogue reads only')
      }
      return new Response(JSON.stringify({ code: 200, data: catalogue }))
    } })
  ctx.plugin(video.JubianVideoSelection, { client, ledger: new JubianLedger({ root: `${process.cwd()}/.dsh/huanchang-ledger` }),
    enabled: true, defaultModel: { modelId: 'doubao-seedance-2.5', platformId: 'FZ_HUAN_CHANG', resolution: '480p' } })
  ctx.plugin(compiler, config)
}
