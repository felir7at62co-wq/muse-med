/** Actions-only TOS fallback: execute the approved original publisher after complete native-input checks. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createGitHubTransferAdapter } from './gh-adapter.mjs'
import { validateTransferSeal, verifyDownloadedInputs, verifyTransferPreflight } from './transfer.mjs'
import { createTosPublisherObserver, parsePrivateTosEnvironment, verifyFinalPublisherSource, verifyTosPublicationPlan } from './tos-publish.mjs'

const { values } = parseArgs({ options: { manifest: { type: 'string' }, 'artifacts-root': { type: 'string' },
  'publisher-root': { type: 'string' }, receipt: { type: 'string' } } })
const ownerRoot = fileURLToPath(new URL('.', import.meta.url))
let receiptContext
const emit = event => console.log(JSON.stringify(event))

async function receipt(value) {
  await mkdir(dirname(receiptContext.path), { recursive: true })
  await writeFile(receiptContext.path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
}

function executePublisher(entry, env, args, observer) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ['--import', join(ownerRoot, 'tos-publisher-preload.mjs'), entry, ...args],
      { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let failed, buffers = ['', '']
    const stop = () => child.kill('SIGTERM')
    const line = value => {
      if (!value.trim() || failed) return
      try { observer.observe(value) }
      catch (_error) { failed = new Error('Original publisher output validation failed'); stop() }
    }
    for (const [index, stream] of [child.stdout, child.stderr].entries()) {
      stream.setEncoding('utf8')
      stream.on('data', value => {
        buffers[index] += value
        let end
        while ((end = buffers[index].indexOf('\n')) !== -1) {
          const next = buffers[index].slice(0, end); buffers[index] = buffers[index].slice(end + 1); line(next)
        }
        if (Buffer.byteLength(buffers[index]) > 16384) { failed = new Error('Original publisher log exceeded its bound'); stop() }
      })
    }
    child.on('error', () => { failed = new Error('Original publisher process failed to start') })
    child.on('close', code => {
      for (const value of buffers) line(value)
      if (failed) { rejectRun(failed); return }
      try { resolveRun(observer.complete(code)) } catch (_error) { rejectRun(new Error('Original publisher did not complete verified TOS publication')) }
    })
  })
}

async function main() {
  assert.ok(process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    && process.env.GITHUB_REPOSITORY === 'felir7at62co-wq/muse-med'
    && process.env.GITHUB_REF === 'refs/heads/codex/muse-release-artifact-transfer-105', 'TOS publication requires manual operator dispatch')
  assert.ok(values.manifest && values['artifacts-root'] && values['publisher-root'] && values.receipt && process.env.RUNNER_TEMP, 'Missing approved TOS publication paths')
  assert.ok(isAbsolute(values.receipt), 'TOS receipt must be absolute')
  const root = resolve(process.env.RUNNER_TEMP), output = resolve(values.receipt), below = relative(root, output)
  assert.ok(below && !below.startsWith('..') && !isAbsolute(below), 'TOS receipt must remain runner-private')
  const artifactsRoot = resolve(values['artifacts-root']), artifactsBelow = relative(root, artifactsRoot)
  assert.ok(artifactsBelow && !artifactsBelow.startsWith('..') && !isAbsolute(artifactsBelow), 'TOS originals must remain runner-private')
  try { await lstat(output); throw new Error('TOS receipt already exists') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const seal = validateTransferSeal(JSON.parse(await readFile(resolve(values.manifest), 'utf8')))
  receiptContext = { path: output, schemaVersion: 1, operation: 'tos-publish', version: seal.version, sourceCommit: seal.sourceCommit, sourceRun: seal.sourceRun }
  const adapter = createGitHubTransferAdapter(process.env.GITHUB_TOKEN)
  await verifyTransferPreflight(seal, adapter)
  await verifyDownloadedInputs(seal, artifactsRoot)
  const sourceRoot = resolve(values['publisher-root'])
  const entry = await verifyFinalPublisherSource(seal, sourceRoot)
  const dependencyRoot = join(ownerRoot, 'tos-deps', 'node_modules'), link = join(sourceRoot, 'apps', 'desktop', 'node_modules')
  assert.ok((await lstat(dependencyRoot)).isDirectory(), 'Missing pinned publisher dependencies')
  let linked = false, secretDirectory, result
  try {
    await symlink(dependencyRoot, link, 'dir'); linked = true
    const { createMuseMirrorPlan } = await import(pathToFileURL(join(sourceRoot, 'apps/desktop/scripts/muse-release-mirror.mjs')))
    const plan = verifyTosPublicationPlan(seal, await createMuseMirrorPlan({ version: seal.version, sourceCommit: seal.sourceCommit,
      artifactDirectories: { 'mac-arm64': join(artifactsRoot, 'mac-arm64'), 'win-x64': join(artifactsRoot, 'win-x64') }, legacyRcDiscovery: true }))
    await verifyTransferPreflight(seal, adapter)
    const privateContents = process.env.MUSE_TOS_PUBLISH_ENV_105_20261010
    delete process.env.MUSE_TOS_PUBLISH_ENV_105_20261010
    const privateEnv = parsePrivateTosEnvironment(privateContents)
    secretDirectory = await mkdtemp(join(root, 'muse-tos-private-'))
    await writeFile(join(secretDirectory, 'publish.env'), privateContents, { flag: 'wx', mode: 0o600 })
    const childEnv = { ...privateEnv, MUSE_TOS_APPROVED_PUBLISHER: entry }
    for (const name of ['PATH', 'HOME', 'LANG', 'TMPDIR']) if (process.env[name]) childEnv[name] = process.env[name]
    const observer = createTosPublisherObserver(plan, emit)
    emit({ stage: 'tos-publisher-inputs-verified', sourceCommit: seal.sourceCommit, sourceRun: seal.sourceRun, binaries: 5, feeds: 4 })
    result = await executePublisher(entry, childEnv, ['--version', seal.version, '--commit', seal.sourceCommit,
      '--mac-arm64', join(artifactsRoot, 'mac-arm64'), '--win-x64', join(artifactsRoot, 'win-x64')], observer)
    await verifyFinalPublisherSource(seal, sourceRoot)
    await verifyTransferPreflight(seal, adapter)
  } finally {
    if (secretDirectory) await rm(secretDirectory, { recursive: true, force: false })
    if (linked) await rm(link)
    delete process.env.MUSE_TOS_PUBLISH_ENV_105_20261010
  }
  const { path, ...identity } = receiptContext
  await receipt({ ...identity, success: true, publicBinaryBytesVerified: true, ...result,
    githubPublished: false, originalSourceChanged: false, rebuilt: false, privateConfigurationRemoved: true })
}

main().catch(async _error => {
  if (receiptContext) {
    const { path, ...identity } = receiptContext
    try { await receipt({ ...identity, success: false, reason: 'tos-publication-did-not-complete', reconcileObjectsBeforeRetry: true }) }
    catch (_receiptError) { emit({ stage: 'tos-failure-receipt-unavailable' }) }
  }
  emit({ stage: 'failed', detail: 'Reconcile objects and channel metadata before retrying.' })
  process.exitCode = 1
})
