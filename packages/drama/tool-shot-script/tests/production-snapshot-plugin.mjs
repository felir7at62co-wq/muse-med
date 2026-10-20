/** Real Muse tool over an authored local plan; remote access is forbidden in this read-only replay. */
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'

const artifact = process.env.DSH_EXAMPLE_MODE === 'lib'
const compiler = await import(new URL(artifact ? '../lib/index.js' : '../src/index.ts', import.meta.url))
const { JubianVideoSelection } = await import('@deepseek-ai/dsh-tool-jubian')

export const Config = compiler.Config

class FixtureCredentials extends CredentialProvider {
  resolve() { return Promise.resolve(undefined) }
}

/** Mount production owners; read never initializes a model or contacts a provider. */
export function apply(ctx, config) {
  ctx.plugin(FixtureCredentials)
  ctx.plugin(JubianVideoSelection, { enabled: true,
    client: new JubianClient({ credential: async () => '', fetch: async () => { throw new Error('Read-only Muse snapshot must not make provider requests') } }),
    ledger: new JubianLedger({ root: `${process.cwd()}/.dsh/production-ledger` }) })
  ctx.plugin(compiler, { ...config, productionPackaging: true })
}
