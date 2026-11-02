/** Qualify real release-candidate downloads through the production Electron updater without publishing a feed. */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { load } from 'js-yaml'
import { gt, valid } from 'semver'
import { isEntry } from '../../../scripts/release/process.ts'
import { desktopTargetBuildPaths, desktopTargetPlatform } from './desktop-build-paths.mjs'
import { readDesktopProductVersion } from './desktop-build-version.mjs'

interface ArtifactIdentity { filename: string; size: number; sha256: string; sha512: string }
interface CandidateOptions { target: 'mac-arm64' | 'win-x64'; version: string; fromVersion: string; sourceCommit: string }
/** Locked build identity and local feed bytes passed to one private Electron process. */
export interface CandidateUpdateSpec extends CandidateOptions {
  artifacts: ArtifactIdentity[]
  payload: ArtifactIdentity
  metadata: { version: string; path: string; sha512: string; files: Array<{ url: string; sha512: string; size: number }> }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Candidate update: expected a JSON object')
  return value as Record<string, unknown>
}

/**
 * Select actual installer hashes from a completed exact-source build and its original update metadata.
 * @param record - Parsed unsigned-build.json from the same candidate build.
 * @param metadata - Parsed original target channel YAML.
 * @param options - Expected target, source and increasing release versions.
 * @returns Bounded artifact identities and publication-equivalent candidate metadata.
 */
export function candidateUpdateSpec(record: unknown, metadata: unknown, options: CandidateOptions): CandidateUpdateSpec {
  const { target, version, fromVersion, sourceCommit } = options
  if (!valid(version) || !valid(fromVersion) || !gt(version, fromVersion) || !/^[a-f0-9]{40}$/u.test(sourceCommit)) {
    throw new Error('Candidate update: increasing versions and exact source commit are required')
  }
  const build = object(record)
  if (build.schemaVersion !== 1 || build.target !== target || build.version !== version
    || build.sourceCommit !== sourceCommit || build.unsigned !== true) throw new Error('Candidate update: another build identity')
  const entries = object(build.artifacts)
  const base = `muse-med-${version}-${target}`
  const primary = `${base}.${target === 'mac-arm64' ? 'zip' : 'exe'}`
  const channel = target === 'mac-arm64' ? 'latest-mac.yml' : 'latest.yml'
  const names = [primary, `${primary}.blockmap`, channel, ...(target === 'mac-arm64' ? [`${base}.dmg`] : [])]
  const artifacts = names.map((filename) => {
    const entry = object(entries[filename])
    if (basename(filename) !== filename || !Number.isSafeInteger(entry.size) || typeof entry.size !== 'number' || entry.size < 1
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256)
      || typeof entry.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(entry.sha512)) {
      throw new Error('Candidate update: invalid recorded artifact')
    }
    return { filename, size: entry.size, sha256: entry.sha256, sha512: entry.sha512 }
  })
  const original = object(metadata)
  if (original.version !== version || original.path !== primary || !Array.isArray(original.files) || original.files.length !== 1) {
    throw new Error('Candidate update: channel differs from the candidate build')
  }
  const first = object(original.files[0])
  const primaryIdentity = artifacts.find(file => file.filename === primary)!
  if (first.url !== primary || first.size !== primaryIdentity.size || first.sha512 !== primaryIdentity.sha512
    || original.sha512 !== primaryIdentity.sha512) throw new Error('Candidate update: channel checksum differs from its payload')
  const payload = artifacts.find(file => file.filename === (target === 'mac-arm64' ? `${base}.dmg` : primary))!
  const files = [primaryIdentity, ...(target === 'mac-arm64' ? [payload] : [])]
    .map(file => ({ url: file.filename, sha512: file.sha512, size: file.size }))
  return { ...options, artifacts, payload, metadata: { version, path: primary, sha512: primaryIdentity.sha512, files } }
}

async function digest(path: string): Promise<{ size: number; sha256: string; sha512: string }> {
  let size = 0
  const sha256 = createHash('sha256'), sha512 = createHash('sha512')
  for await (const bytes of createReadStream(path)) { size += bytes.length; sha256.update(bytes); sha512.update(bytes) }
  return { size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { target: { type: 'string' }, artifacts: { type: 'string' }, output: { type: 'string' },
    'source-commit': { type: 'string' }, 'from-version': { type: 'string', default: '1.2.1' } } })
  const target = values.target ?? process.env.MUSE_RELEASE_TARGET
  assert.ok(target === 'mac-arm64' || target === 'win-x64', 'Candidate update: unsupported target')
  const native = desktopTargetPlatform(target)
  assert.equal(process.platform, native.platform, 'Candidate update requires its native operating system')
  assert.equal(process.arch, native.arch, 'Candidate update requires its native architecture')
  const sourceCommit = values['source-commit'] ?? process.env.GITHUB_SHA
  assert.ok(sourceCommit, 'Candidate update: source commit is required')
  const version = readDesktopProductVersion()
  const paths = desktopTargetBuildPaths(target)
  const artifacts = resolve(values.artifacts ?? paths.unsignedArtifacts)
  const channel = target === 'mac-arm64' ? 'latest-mac.yml' : 'latest.yml'
  const spec = candidateUpdateSpec(JSON.parse(await readFile(join(artifacts, 'unsigned-build.json'), 'utf8')),
    load(await readFile(join(artifacts, channel), 'utf8')), { target, sourceCommit, version, fromVersion: values['from-version']! })
  for (const file of spec.artifacts) {
    const { filename, ...expected } = file
    assert.deepEqual(await digest(join(artifacts, filename)), expected, `Candidate update: changed build artifact ${filename}`)
  }
  const output = values.output === undefined ? await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'muse-candidate-update-')) : resolve(values.output)
  if (values.output !== undefined) await mkdir(output, { recursive: false, mode: 0o700 })
  const root = await mkdtemp(join(tmpdir(), 'muse-candidate-update-private-'))
  let child: ReturnType<typeof spawn> | undefined
  let stopped: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined
  let timedOut = false
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$|^NODE_TLS_REJECT_UNAUTHORIZED$/iu.test(name)))
  try {
    const execute = promisify(execFile)
    await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'key.pem'),
      '-out', join(root, 'certificate.pem'), '-days', '1', '-subj', '/CN=127.0.0.1'], { env: environment, timeout: 30_000 })
    await writeFile(join(root, 'spec.json'), JSON.stringify({ ...spec, artifactsRoot: artifacts, output }), { mode: 0o600 })
    const electron = target === 'mac-arm64' ? join(paths.electron, 'Electron.app', 'Contents', 'MacOS', 'Electron')
      : join(paths.electron, 'electron.exe')
    child = spawn(electron, [resolve(import.meta.dirname, '../tests/fixtures/muse-candidate-update.mjs')], {
      env: { ...environment, MUSE_CANDIDATE_UPDATE_ROOT: root, MUSE_MED_HOME: join(root, 'muse-home') }, stdio: 'inherit', windowsHide: true,
    })
    stopped = new Promise((accept, reject) => {
      child!.once('error', reject)
      child!.once('close', (code, signal) => accept({ code, signal }))
    })
    const timeout = setTimeout(() => { timedOut = true; child!.kill() }, 900_000)
    try {
      const outcome = await stopped
      await writeFile(join(output, 'process.json'), `${JSON.stringify({ timedOut, ...outcome }, null, 2)}\n`)
      assert.equal(timedOut, false, 'Candidate update: Electron exceeded the fifteen-minute deadline')
      assert.equal(outcome.signal, null, 'Candidate update: Electron stopped on a signal')
      assert.equal(outcome.code, 0, 'Candidate update: Electron qualification failed')
      const result = object(JSON.parse(await readFile(join(output, 'result.json'), 'utf8')))
      assert.equal(result.success, true)
    } finally { clearTimeout(timeout) }
    for (const file of spec.artifacts) {
      const { filename, ...expected } = file
      assert.deepEqual(await digest(join(artifacts, filename)), expected, 'Candidate update: source artifacts changed during acceptance')
    }
    console.log(`Muse candidate update accepted: ${output}`)
  } finally {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill()
      await stopped
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

if (isEntry(import.meta.url)) await main()
