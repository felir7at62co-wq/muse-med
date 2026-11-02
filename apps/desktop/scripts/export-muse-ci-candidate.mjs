/** Export one verified Windows CI candidate as private authenticated ciphertext, without publishing updater feeds. */
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { constants, createReadStream, createWriteStream, openAsBlob } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { create } from 'tar'
import { readDesktopProductConfig } from './desktop-build-version.mjs'
import { createMuseMirrorPlan } from './muse-release-mirror.mjs'

const REPOSITORY = 'felir7at62co-wq/muse-med'
const EVIDENCE_EXTENSIONS = new Set(['.json', '.jsonl', '.log', '.txt', '.xml'])
const EXCLUDED_DIRECTORIES = new Set(['node_modules', '.git', 'payload', 'installed', 'installation', 'resources', 'credentials', 'profiles'])
class ExportFailure extends Error {}
const requireExport = (condition, message) => { if (!condition) throw new ExportFailure(`Muse candidate export: ${message}`) }

function uploadObject(value, key, contentType) {
  requireExport(value?.key === key && value.method === 'PUT', 'invalid object destination')
  const url = new URL(value.url)
  requireExport(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash,
    'invalid upload URL')
  requireExport((url.hostname === 'muse.tos-s3-cn-beijing.volces.com' && url.pathname === `/${key}`)
    || (url.hostname === 'tos-s3-cn-beijing.volces.com' && url.pathname === `/muse/${key}`), 'invalid upload destination')
  const query = url.searchParams
  requireExport(query.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256'
    && /^[a-f0-9]{64}$/u.test(query.get('X-Amz-Signature') ?? '')
    && Boolean(query.get('X-Amz-Credential')) && Boolean(query.get('X-Amz-Date'))
    && /^[1-9]\d*$/u.test(query.get('X-Amz-Expires') ?? ''), 'missing upload signature')
  const headers = value.headers
  requireExport(headers && Object.keys(headers).length === 3
    && headers['content-type'] === contentType && headers['if-none-match'] === '*'
    && headers['x-amz-acl'] === 'private', 'invalid private upload headers')
  const signed = new Set((query.get('X-Amz-SignedHeaders') ?? '').split(';'))
  requireExport(Object.keys(headers).every(name => signed.has(name)), 'unsigned upload headers')
  return value
}

function configuration(environment, platform, version, now) {
  requireExport(platform === 'win32' && environment.GITHUB_EVENT_NAME === 'workflow_dispatch'
    && environment.GITHUB_REPOSITORY === REPOSITORY && environment.MUSE_RELEASE_TARGET === 'win-x64', 'unsupported CI context')
  requireExport(/^[a-f0-9]{40}$/u.test(environment.GITHUB_SHA ?? '')
    && /^[1-9]\d*$/u.test(environment.GITHUB_RUN_ID ?? ''), 'invalid workflow identity')
  const config = JSON.parse(environment.MUSE_CI_TOS_CANDIDATE_UPLOAD ?? '')
  requireExport(config?.schemaVersion === 1 && config.version === version && /^\d+\.\d+\.\d+$/u.test(version)
    && config.target === 'win-x64' && config.expectedCommit === environment.GITHUB_SHA
    && /^[a-f0-9]{32}$/u.test(config.exportId ?? '') && /^[a-f0-9]{64}$/u.test(config.encryptionKeyHex ?? ''), 'invalid export identity')
  requireExport(typeof config.expiresAtUtc === 'string' && config.expiresAtUtc.endsWith('Z')
    && Number.isFinite(Date.parse(config.expiresAtUtc)) && Date.parse(config.expiresAtUtc) > now, 'export authorization expired')
  const prefix = `ci-candidates/${version}/${config.exportId}/win-x64`
  requireExport(config.prefix === prefix, 'invalid export prefix')
  uploadObject(config.objects?.candidate, `${prefix}/candidate.tar.enc`, 'application/octet-stream')
  uploadObject(config.objects?.transfer, `${prefix}/transfer.json`, 'application/json')
  return config
}

async function regular(path, directory = false) {
  const entry = await lstat(path)
  requireExport(!entry.isSymbolicLink() && (directory ? entry.isDirectory() : entry.isFile()), 'unsafe input file')
}

async function ownedDirectory(path, root) {
  const child = relative(root, path)
  requireExport(child !== '..' && !child.startsWith(`..${sep}`), 'input outside its owned root')
  for (let current = path; current !== root; current = dirname(current)) await regular(current, true)
}

async function copyEvidence(source, destination, recursive) {
  const entry = await lstat(source)
  requireExport(!entry.isSymbolicLink(), 'linked evidence refused')
  const name = source.split(sep).at(-1)
  requireExport(!name.toLowerCase().startsWith('.env'), 'environment file refused')
  if (entry.isDirectory()) {
    if (!recursive || EXCLUDED_DIRECTORIES.has(name.toLowerCase())) return 0
    let count = 0
    for (const child of await readdir(source)) count += await copyEvidence(join(source, child), join(destination, child), true)
    return count
  }
  requireExport(entry.isFile(), 'special evidence file refused')
  if (!EVIDENCE_EXTENSIONS.has(extname(name).toLowerCase())) return 0
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await copyFile(source, destination, constants.COPYFILE_EXCL)
  await chmod(destination, 0o600)
  return 1
}

async function stageEvidence(root, runner, stage, identity) {
  let installers = 0
  const updates = new Set()
  const accepted = report => report.success === true && report.target === 'win-x64'
    && report.version === identity.version && report.sourceCommit === identity.expectedCommit
  for (const name of await readdir(runner)) {
    const source = join(runner, name), destination = join(stage, 'evidence', 'runner', name)
    if (name.startsWith('muse-installer-acceptance-')) {
      await regular(source, true)
      const acceptance = join(source, 'acceptance.json')
      const report = JSON.parse(await readFile(acceptance, 'utf8'))
      requireExport(accepted(report), 'installer acceptance did not succeed')
      await copyEvidence(acceptance, join(destination, 'acceptance.json'), false)
      for (const child of ['processes', 'cleanup-processes']) {
        const path = join(source, child)
        try { await lstat(path) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
        await copyEvidence(path, join(destination, child), true)
      }
      installers++
    } else if (name.startsWith('muse-candidate-update-')) {
      await regular(source, true)
      const report = JSON.parse(await readFile(join(source, 'result.json'), 'utf8'))
      requireExport(accepted(report) && typeof report.fromVersion === 'string', 'candidate update acceptance did not succeed')
      for (const child of await readdir(source)) await copyEvidence(join(source, child), join(destination, child), false)
      updates.add(report.fromVersion)
    }
  }
  requireExport(installers > 0 && ['1.2.2', '1.2.5', '1.2.6'].every(version => updates.has(version)), 'missing native acceptance evidence')
  const build = join(root, 'apps', 'desktop', '.desktop-build')
  await ownedDirectory(build, root)
  for (const name of ['installer-tests', 'packaging-runs']) {
    await copyEvidence(join(build, name), join(stage, 'evidence', 'desktop', name), true)
  }
  const qualification = join(build, 'qualification')
  await regular(qualification, true)
  let updater = 0
  for (const name of await readdir(qualification)) if (name.startsWith('local-updater-')) {
    updater += await copyEvidence(join(qualification, name), join(stage, 'evidence', 'desktop', 'qualification', name), true)
  }
  requireExport(updater > 0, 'missing updater UI evidence')
}

async function auditTextEvidence(directory, secrets) {
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    const entry = await lstat(path)
    if (entry.isDirectory()) { await auditTextEvidence(path, secrets); continue }
    const text = await readFile(path, 'utf8')
    requireExport(!secrets.some(value => text.includes(value))
      && !/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|X-(?:Amz|Tos)-Signature=|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}|\bsk-[A-Za-z0-9_-]{20,}|\bBearer\s+[A-Za-z0-9._~+/-]{8,}/iu.test(text),
    'evidence contains secret data')
  }
}

async function put(object, body, fetchImpl, now, expiry) {
  requireExport(now() < expiry, 'export authorization expired')
  let response
  try {
    response = await fetchImpl(object.url, { method: 'PUT', headers: object.headers, body,
      redirect: 'error', signal: AbortSignal.timeout(15 * 60_000) })
  } catch { throw new ExportFailure('Muse candidate export: upload transport failed') }
  const status = response.status
  await response.body?.cancel()
  requireExport(response.ok, `upload failed (HTTP ${status})`)
}

/** Encrypt the exact candidate and text-only native acceptance evidence after rejecting known secrets and credential patterns.
 * @param {{root?: string, environment?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, fetchImpl?: typeof fetch, now?: () => number}} options - Build roots and isolated adapters for offline qualification.
 * @returns {Promise<{version: string, target: string, commit: string, runId: string, exportId: string, encryptedBytes: number, encryptedSha256: string, ivHex: string, authTagHex: string}>} Non-secret transfer metadata after both private objects upload.
 */
export async function exportMuseCiCandidate({ root = resolve(import.meta.dirname, '../../..'), environment = process.env,
  platform = process.platform, fetchImpl = fetch, now = Date.now } = {}) {
  let temporary
  try {
    const version = readDesktopProductConfig(join(root, 'apps', 'desktop')).version
    const config = configuration(environment, platform, version, now())
    const runner = resolve(environment.RUNNER_TEMP ?? '')
    requireExport(Boolean(environment.RUNNER_TEMP), 'runner temporary directory required')
    await regular(root, true)
    await regular(runner, true)
    const artifacts = join(root, 'apps', 'desktop', '.desktop-build', 'targets', 'win-x64', 'unsigned-artifacts')
    const names = [`muse-med-${version}-win-x64.exe`, `muse-med-${version}-win-x64.exe.blockmap`, 'latest.yml', 'unsigned-build.json']
    await regular(artifacts, true)
    await ownedDirectory(artifacts, root)
    for (const name of names) await regular(join(artifacts, name))
    temporary = await mkdtemp(join(runner, 'muse-ci-export-'))
    await chmod(temporary, 0o700)
    const stage = join(temporary, 'archive')
    await mkdir(join(stage, 'candidate'), { recursive: true, mode: 0o700 })
    for (const name of names) {
      await copyFile(join(artifacts, name), join(stage, 'candidate', name), constants.COPYFILE_EXCL)
      await chmod(join(stage, 'candidate', name), 0o600)
    }
    await createMuseMirrorPlan({ version, sourceCommit: config.expectedCommit, targets: ['win-x64'],
      artifactDirectories: { 'win-x64': join(stage, 'candidate') } })
    await stageEvidence(root, runner, stage, config)
    const secrets = [config.encryptionKeyHex, config.objects.candidate.url, config.objects.transfer.url,
      ...Object.entries(environment).flatMap(([name, value]) => /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/iu.test(name)
        && typeof value === 'string' && value.length >= 8 ? [value] : [])]
    await auditTextEvidence(join(stage, 'evidence'), secrets)
    const key = Buffer.from(config.encryptionKeyHex, 'hex'), iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    key.fill(0)
    const encrypted = join(temporary, 'candidate.tar.enc')
    await pipeline(create({ cwd: stage, portable: true, follow: false }, ['candidate', 'evidence']), cipher,
      createWriteStream(encrypted, { flags: 'wx', mode: 0o600 }))
    const sha256 = createHash('sha256')
    let encryptedBytes = 0
    for await (const chunk of createReadStream(encrypted)) { encryptedBytes += chunk.length; sha256.update(chunk) }
    const transfer = { version, target: 'win-x64', commit: config.expectedCommit, runId: environment.GITHUB_RUN_ID,
      exportId: config.exportId, encryptedBytes, encryptedSha256: sha256.digest('hex'), ivHex: iv.toString('hex'), authTagHex: cipher.getAuthTag().toString('hex') }
    await put(config.objects.candidate, await openAsBlob(encrypted), fetchImpl, now, Date.parse(config.expiresAtUtc))
    await put(config.objects.transfer, JSON.stringify(transfer), fetchImpl, now, Date.parse(config.expiresAtUtc))
    return transfer
  } catch (error) {
    if (error instanceof ExportFailure) throw error
    throw new ExportFailure('Muse candidate export: validation or encryption failed')
  } finally {
    if (temporary !== undefined) {
      try { await rm(temporary, { recursive: true, force: true }) }
      catch { throw new ExportFailure('Muse candidate export: temporary cleanup failed') }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await exportMuseCiCandidate(); console.log('Muse candidate export: encrypted candidate and transfer uploaded') }
  catch (error) {
    console.error(error instanceof ExportFailure ? error.message : 'Muse candidate export: operation failed')
    process.exitCode = 1
  }
}
