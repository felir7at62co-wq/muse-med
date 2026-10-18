/** Catalogue-only video choice and the real shot reviewer for recorded-session tests. */
import { readFile } from 'node:fs/promises'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { defineTool } from '@deepseek-ai/dsh-tools'

const artifact = process.env.DSH_EXAMPLE_MODE === 'lib'
const compiler = await import(new URL(artifact ? '../lib/index.js' : '../src/index.ts', import.meta.url))
const video = await import(artifact ? '@deepseek-ai/dsh-tool-jubian' : '@deepseek-ai/dsh-tool-jubian/src/video-session.ts')
const catalogue = JSON.parse(await readFile(new URL('../../../jubian/jubian-api/tests/fixtures/catalogue-20261016.json', import.meta.url), 'utf8'))

export const Config = compiler.Config

/** Mount normal production owners; only the account transport and menu interaction are fixtures. */
export function apply(ctx, config) {
  const client = new JubianClient({ baseUrl: 'https://catalogue.invalid', credential: async () => 'fixture-token',
    fetch: async (url, init) => {
      const address = new URL(url instanceof Request ? url.url : url.toString())
      if ((init?.method ?? 'GET') !== 'GET' || address.pathname !== '/model/charge/getSelectList' || address.search !== '?taskType=1') {
        throw new Error('The session video snapshot permits catalogue reads only')
      }
      return new Response(JSON.stringify({ code: 200, data: catalogue['1'] }))
    } })
  ctx.plugin(video.JubianVideoSelection, { client, ledger: new JubianLedger({ root: `${process.cwd()}/.snapshot-ledger` }),
    enabled: true, defaultModel: { modelId: 'doubao-seedance-2-5-260628', platformId: 'FANG_ZHOU', resolution: '480p' } })
  ctx.plugin(compiler, config)
  ctx.inject(['jubianVideoSelection', 'tools'], (scope) => {
    scope.tools.register(defineTool({ name: 'fixture_video_choice',
      description: 'Recorded-test menu interaction: select a real catalogue option without creating media or changing a project.',
      parameters: { seconds: { type: 'integer', required: true, enum: [15, 30] } },
      output: { schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, exec) => {
        if (exec.agent === undefined) throw new Error('A recorded-test choice needs a conversation')
        const service = scope.jubianVideoSelection
        const option = (await service.catalogue()).find(option => option.maxDurationSeconds === args.seconds)
        if (option === undefined) throw new Error('The recorded model is not present in the catalogue')
        const selection = await service.select(exec.agent, option.key, service.current(exec.agent)?.revision ?? 0)
        return { selection, paid_requests: 0 }
      } }))
  })
}
