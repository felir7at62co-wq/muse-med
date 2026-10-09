/** Manual Actions-only entry for verified installer transfer; never build, install or publish. */
import { appendFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createGitHubTransferAdapter } from './gh-adapter.mjs'
import { transferSealedArtifacts, validateTransferSeal, verifyTransferPreflight } from './transfer.mjs'

const { values } = parseArgs({ options: {
  help: { type: 'boolean' }, mode: { type: 'string' }, manifest: { type: 'string' },
  'artifacts-root': { type: 'string' },
} })

async function main() {
  if (values.help) {
    console.log('Usage: node run.mjs --mode <preflight|transfer> --manifest <approved public seal.json> [--artifacts-root <runner-owned original downloads>]')
    return
  }
  if (!['preflight', 'transfer'].includes(values.mode) || !values.manifest) throw new Error('Provide a transfer mode and approved manifest')
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || process.env.GITHUB_REPOSITORY !== 'felir7at62co-wq/muse-med'
    || process.env.GITHUB_REF !== 'refs/heads/codex/muse-release-artifact-transfer-105') {
    throw new Error('Transfer is restricted to manual dispatch of the dedicated operator branch')
  }
  const seal = validateTransferSeal(JSON.parse(await readFile(resolve(values.manifest), 'utf8')))
  const adapter = createGitHubTransferAdapter(process.env.GITHUB_TOKEN)
  if (values.mode === 'preflight') {
    await verifyTransferPreflight(seal, adapter)
    if (!process.env.GITHUB_OUTPUT) throw new Error('Missing runner output file')
    await appendFile(process.env.GITHUB_OUTPUT, `source_run=${seal.sourceRun}\nsource_commit=${seal.sourceCommit}\n`)
    console.log(JSON.stringify({ status: 'preflight-passed', version: seal.version, sourceRun: seal.sourceRun, sourceCommit: seal.sourceCommit }))
    return
  }
  if (!values['artifacts-root']) throw new Error('Provide the runner-owned artifact directory')
  const result = await transferSealedArtifacts(seal, resolve(values['artifacts-root']), adapter,
    event => console.log(JSON.stringify(event)))
  console.log(JSON.stringify({ status: 'draft-assets-complete', sourceCommit: seal.sourceCommit, ...result, published: false }))
}

main().catch(error => { console.error(`Muse artifact transfer: ${error.message}`); process.exitCode = 1 })
