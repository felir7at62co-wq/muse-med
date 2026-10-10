/** Validate the final source producer, sealed TOS plan and bounded publisher events. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'

/** Exact source inputs used by the original publisher; owner-branch producers are never executed. */
export const PUBLISHER_INPUTS = ['apps/desktop/muse-product.json',
  'apps/desktop/scripts/publish-muse-tos.mjs', 'apps/desktop/scripts/muse-release-mirror.mjs',
  'apps/desktop/scripts/desktop-build-version.mjs', 'apps/desktop/scripts/desktop-auto-update-environment.mjs']
const DESTINATION = { MUSE_TOS_BUCKET: 'muse', MUSE_TOS_REGION: 'cn-beijing',
  MUSE_TOS_S3_ENDPOINT: 'https://tos-s3-cn-beijing.volces.com',
  MUSE_TOS_PUBLIC_BASE_URL: 'https://muse.tos-cn-beijing.volces.com', MUSE_TOS_PREFIX: 'releases' }
const CREDENTIALS = ['VOLCENGINE_ACCESS_KEY_ID', 'VOLCENGINE_SECRET_ACCESS_KEY']
const sha256 = value => createHash('sha256').update(value).digest('hex')
const publisherRequire = createRequire(new URL('./tos-deps/package.json', import.meta.url))

/**
 * Parse a private environment file without shell expansion, duplicate names or unrelated secrets.
 * @param contents - The private seven-field environment configuration.
 * @returns The validated destination and credentials, for process memory only.
 */
export function parsePrivateTosEnvironment(contents) {
  assert.equal(typeof contents, 'string', 'Missing private TOS configuration')
  assert.ok(Buffer.byteLength(contents) <= 16384, 'Private TOS configuration exceeds its bound')
  const result = {}
  for (const line of contents.split(/\r?\n/u)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line)
    assert.ok(match && [...Object.keys(DESTINATION), ...CREDENTIALS].includes(match[1]), 'Undeclared private TOS field')
    assert.ok(!Object.hasOwn(result, match[1]), 'Duplicate private TOS field')
    let value = match[2].trim()
    if (value[0] === '"' || value[0] === "'") {
      assert.equal(value.at(-1), value[0], 'Unterminated private TOS value')
      value = value.slice(1, -1)
    }
    assert.ok(value && !/[\r\n\0]/u.test(value) && value.length <= 4096, 'Invalid private TOS value')
    result[match[1]] = value
  }
  assert.equal(Object.keys(result).length, Object.keys(DESTINATION).length + CREDENTIALS.length, 'Incomplete private TOS configuration')
  for (const [name, value] of Object.entries(DESTINATION)) assert.equal(result[name], value, 'Private TOS destination differs')
  return result
}

/**
 * Require the approved checkout HEAD and byte-identical Git blobs for all original producer files.
 * @param seal - Approved source and product version.
 * @param sourceRoot - Separate checkout of that exact final source.
 * @param git - Git byte reader; isolated fixtures can inject recorded blobs.
 * @returns The original publisher entry after every source check passes.
 */
export async function verifyFinalPublisherSource(seal, sourceRoot, git = args => execFileSync('git', ['-C', sourceRoot, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })) {
  assert.match(seal.sourceCommit, /^[a-f0-9]{40}$/u, 'Invalid final publisher source')
  assert.equal(git(['rev-parse', 'HEAD']).toString().trim(), seal.sourceCommit, 'Publisher checkout uses another source')
  for (const name of PUBLISHER_INPUTS) {
    const path = join(sourceRoot, name)
    assert.ok((await lstat(path)).isFile(), 'Publisher source input must be regular')
    assert.deepEqual(await readFile(path), git(['show', `${seal.sourceCommit}:${name}`]), 'Publisher source input differs from its Git blob')
  }
  const product = JSON.parse(await readFile(join(sourceRoot, PUBLISHER_INPUTS[0]), 'utf8'))
  assert.equal(product.version, seal.version, 'Publisher source uses another product version')
  assert.equal(product.legacyRcDiscovery, true, 'Publisher source requires both stable and legacy RC feeds')
  return join(sourceRoot, 'apps/desktop/scripts/publish-muse-tos.mjs')
}

/**
 * Bind the original producer's five binary operations and four channel contents to the publication seal.
 * @param seal - Approved binary and GitHub publication hashes.
 * @param plan - Original final-source producer's upload plan.
 * @param loadYaml - Maintained YAML loader; fixtures may inject a data reader.
 * @returns The unchanged plan after exact object destinations and ZIP-first Mac payloads pass.
 */
export function verifyTosPublicationPlan(seal, plan, loadYaml = value => publisherRequire('js-yaml').load(value)) {
  assert.equal(plan.version, seal.version, 'TOS plan uses another version')
  assert.equal(plan.sourceCommit, seal.sourceCommit, 'TOS plan uses another source')
  const files = seal.files.filter(file => /\.(?:dmg|zip|exe|blockmap)$/u.test(file.filename))
  assert.equal(plan.artifacts.length, 5, 'TOS requires five original binaries')
  assert.deepEqual(plan.artifacts.map(file => file.filename).sort(), files.map(file => file.filename).sort(), 'TOS binary inventory differs')
  for (const file of plan.artifacts) {
    const expected = files.find(value => value.filename === file.filename)
    const target = file.filename.includes('-mac-arm64.') ? 'mac-arm64' : 'win-x64'
    assert.equal(file.key, `releases/${seal.version}/${target}/${file.filename}`, 'TOS binary key differs')
    assert.equal(file.size, expected.size, 'TOS binary size differs')
    assert.equal(file.sha256, expected.sha256, 'TOS binary digest differs')
  }
  const feedNames = ['latest-mac.yml', 'rc-mac.yml', 'latest.yml', 'rc.yml']
  assert.deepEqual(plan.githubMetadata.map(file => file.filename).sort(), [...feedNames].sort(), 'TOS publication feed inventory differs')
  assert.deepEqual(plan.metadata.map(file => file.filename).sort(), [...feedNames].sort(), 'TOS mirror feed inventory differs')
  for (const file of plan.githubMetadata) {
    const expected = seal.files.find(value => value.filename === file.filename)
    assert.equal(Buffer.byteLength(file.contents), expected.size, 'Published feed size differs from the seal')
    assert.equal(sha256(file.contents), expected.sha256, 'Published feed bytes differ from the seal')
  }
  for (const file of plan.metadata) {
    const target = file.filename.includes('-mac') ? 'mac-arm64' : 'win-x64'
    assert.equal(file.key, `releases/feeds/${target}/${file.filename}`, 'TOS feed key differs')
    assert.equal(file.sha256, sha256(file.contents), 'TOS feed content digest differs')
    assert.ok(!plan.artifacts.some(binary => binary.key === file.key), 'TOS feed overlaps immutable binaries')
    const publication = loadYaml(plan.githubMetadata.find(value => value.filename === file.filename).contents)
    const mirrored = loadYaml(file.contents)
    const payloads = target === 'mac-arm64' ? ['zip', 'dmg'] : ['exe']
    assert.equal(publication.version, seal.version, 'Published feed uses another version')
    assert.equal(publication.files.length, payloads.length, 'Published feed payload count differs')
    const expectedFiles = payloads.map(extension => {
      const binary = plan.artifacts.find(value => value.filename === `muse-med-${seal.version}-${target}.${extension}`)
      assert.ok(binary, 'Missing same-batch feed payload')
      return { url: binary.filename, sha512: binary.sha512, size: binary.size }
    })
    assert.deepEqual(publication.files, expectedFiles, 'Published feed payload identity or ZIP-first order differs')
    assert.equal(publication.path, expectedFiles[0].url, 'Published feed primary payload differs')
    assert.equal(publication.sha512, expectedFiles[0].sha512, 'Published feed primary digest differs')
    const mirroredFiles = expectedFiles.map(value => ({ ...value,
      url: `https://muse.tos-cn-beijing.volces.com/releases/${seal.version}/${target}/${value.url}` }))
    assert.deepEqual(mirrored, { ...publication, files: mirroredFiles, path: mirroredFiles[0].url }, 'TOS feed destination or contents differ')
  }
  return plan
}

/**
 * Admit only fixed safe diagnostics and the original publisher's five-then-four verified event sequence.
 * @param plan - Validated original publication plan.
 * @param onEvent - Safe JSON event sink, without raw publisher messages.
 * @returns A bounded line observer and a completion check requiring all nine public byte proofs.
 */
export function createTosPublisherObserver(plan, onEvent = () => {}) {
  const binaries = [], feeds = []
  let published = false, failed = false
  const keys = new Set([...plan.artifacts, ...plan.metadata].map(file => file.key))
  const allowedCodes = new Set(['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ABORT_ERR'])
  function observe(line) {
    assert.ok(Buffer.byteLength(line) <= 16384, 'Publisher log exceeds its bound')
    const event = JSON.parse(line)
    assert.ok(event && typeof event === 'object' && !Array.isArray(event), 'Invalid publisher event')
    if (['sdk-request-started', 'sdk-request-completed', 'sdk-request-failed', 'sdk-log'].includes(event.stage)) {
      assert.ok(keys.has(event.key), 'SDK diagnostic uses another object')
      const safe = { stage: event.stage, key: event.key }
      for (const name of ['elapsedMs', 'contentLength', 'sourceBytesRead', 'status', 'attempts', 'totalRetryDelayMs']) {
        if (Number.isSafeInteger(event[name]) && event[name] >= 0) safe[name] = event[name]
      }
      if (allowedCodes.has(event.code)) safe.code = event.code
      if (['read', 'write', 'connect', 'getaddrinfo'].includes(event.syscall)) safe.syscall = event.syscall
      if (event.level === 'warn' || event.level === 'error') safe.level = event.level
      onEvent(safe)
      return
    }
    if (event.stage === 'failed') { failed = true; onEvent({ stage: 'failed', detail: 'Original publisher reported failure.' }); return }
    assert.equal(failed, false, 'Publisher continued after failure')
    assert.equal(published, false, 'Publisher continued after completion')
    if (event.stage === 'binary-verified') {
      assert.equal(feeds.length, 0, 'Publisher verified a binary after channel promotion')
      const expected = plan.artifacts[binaries.length]
      assert.ok(expected, 'Unexpected binary verification')
      assert.equal(event.key, expected.key, 'Publisher binary verification order differs')
      assert.equal(event.size, expected.size, 'Publisher verified another binary size')
      assert.equal(event.sha256, expected.sha256, 'Publisher verified another binary digest')
      binaries.push({ key: expected.key, size: expected.size, sha256: expected.sha256 })
      onEvent({ stage: 'binary-verified', ...binaries.at(-1) })
    } else if (event.stage === 'feed-verified') {
      assert.equal(binaries.length, 5, 'Channel promotion preceded full binary verification')
      const expected = plan.metadata[feeds.length]
      assert.ok(expected, 'Unexpected feed verification')
      assert.equal(event.key, expected.key, 'Publisher feed verification order differs')
      assert.equal(event.sha256, expected.sha256, 'Publisher verified another feed digest')
      feeds.push({ key: expected.key, sha256: expected.sha256 })
      onEvent({ stage: 'feed-verified', ...feeds.at(-1) })
    } else if (event.stage === 'published') {
      assert.equal(binaries.length, 5, 'Missing complete binary proof')
      assert.equal(feeds.length, 4, 'Missing complete feed proof')
      assert.equal(event.version, plan.version, 'Publisher completed another version')
      assert.equal(event.sourceCommit, plan.sourceCommit, 'Publisher completed another source')
      assert.equal(event.binaries, 5, 'Publisher binary completion count differs')
      assert.equal(event.feeds, 4, 'Publisher feed completion count differs')
      published = true
      onEvent({ stage: 'published', version: plan.version, sourceCommit: plan.sourceCommit, binaries: 5, feeds: 4 })
    } else assert.fail('Undeclared publisher event')
  }
  return { observe, complete(exitCode) {
    assert.equal(exitCode, 0, 'Original TOS publisher failed')
    assert.equal(failed, false, 'Original TOS publisher reported failure')
    assert.equal(published, true, 'Missing original publisher completion')
    return { binaries, feeds }
  } }
}
