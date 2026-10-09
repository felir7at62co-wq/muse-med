/** Manual Actions-only entry for installer transfer and complete draft/public readback. */
import { appendFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createGitHubTransferAdapter } from './gh-adapter.mjs'
import { readbackSealedReleases } from './readback.mjs'
import { transferSealedArtifacts, validateTransferSeal, verifyTransferPreflight } from './transfer.mjs'

const { values } = parseArgs({ options: {
  help: { type: 'boolean' }, mode: { type: 'string' }, manifest: { type: 'string' },
  'artifacts-root': { type: 'string' }, receipt: { type: 'string' },
} })
let receiptContext

async function writeReceipt(receipt) {
  await mkdir(dirname(receiptContext.path), { recursive: true })
  await writeFile(receiptContext.path, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
}

async function main() {
  if (values.help) {
    console.log('Usage: node run.mjs --mode <preflight|transfer|public-readback> --manifest <approved public seal.json> [--artifacts-root <runner-owned originals>] [--receipt <new runner-private JSON>]')
    return
  }
  if (!['preflight', 'transfer', 'public-readback'].includes(values.mode) || !values.manifest) throw new Error('Provide a declared operation and approved manifest')
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
  if (!values.receipt || !isAbsolute(values.receipt) || !process.env.RUNNER_TEMP) throw new Error('Provide a new runner-owned readback receipt')
  const path = resolve(values.receipt), below = relative(resolve(process.env.RUNNER_TEMP), path)
  if (!below || below.startsWith('..') || isAbsolute(below)) throw new Error('Readback receipt must remain inside the runner temporary directory')
  try { await lstat(path); throw new Error('Readback receipt destination already exists') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  receiptContext = { path, version: seal.version, sourceCommit: seal.sourceCommit, sourceRun: seal.sourceRun,
    operation: values.mode === 'transfer' ? 'draft-readback' : 'public-readback' }
  let transfer
  if (values.mode === 'transfer') {
    if (!values['artifacts-root']) throw new Error('Provide the runner-owned artifact directory')
    transfer = await transferSealedArtifacts(seal, resolve(values['artifacts-root']), adapter, event => console.log(JSON.stringify(event)))
  }
  const { parseXml } = values.mode === 'public-readback' ? await import('builder-util-runtime') : {}
  const receipt = await readbackSealedReleases(seal, adapter, {
    mode: values.mode === 'transfer' ? 'draft' : 'public', token: process.env.GITHUB_TOKEN, parseXml,
    onEvent: event => console.log(JSON.stringify(event)),
  })
  if (transfer) receipt.transfer = transfer
  await writeReceipt(receipt)
  console.log(JSON.stringify({ status: 'complete-remote-byte-readback', operation: receipt.operation,
    sourceCommit: seal.sourceCommit, verifiedFiles: 22, published: false }))
}

main().catch(async error => {
  if (receiptContext) {
    const { path, ...identity } = receiptContext
    try { await writeReceipt({ schemaVersion: 1, ...identity, success: false, reason: 'verification-failed' }) }
    catch (receiptError) { console.error('Muse readback failure receipt could not be written') }
  }
  console.error(`Muse artifact transfer: ${error.message}`)
  process.exitCode = 1
})
