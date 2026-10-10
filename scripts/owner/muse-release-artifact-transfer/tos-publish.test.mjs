import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { createTosPublisherObserver, parsePrivateTosEnvironment, PUBLISHER_INPUTS, verifyFinalPublisherSource, verifyTosPublicationPlan } from './tos-publish.mjs'

const sourceCommit = 'a'.repeat(40)
const hash = (value, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(value).digest(encoding)
const env = {
  MUSE_TOS_BUCKET: 'muse', MUSE_TOS_REGION: 'cn-beijing', MUSE_TOS_S3_ENDPOINT: 'https://tos-s3-cn-beijing.volces.com',
  MUSE_TOS_PUBLIC_BASE_URL: 'https://muse.tos-cn-beijing.volces.com', MUSE_TOS_PREFIX: 'releases',
  VOLCENGINE_ACCESS_KEY_ID: 'synthetic-only-key', VOLCENGINE_SECRET_ACCESS_KEY: 'synthetic-only-secret',
}
const envText = value => Object.entries(value).map(([name, content]) => `${name}=${content}`).join('\n')

test('parses only the private destination and credentials without shell interpolation', () => {
  const content = `# private synthetic fixture\n\n${envText(env).replace('VOLCENGINE_ACCESS_KEY_ID=', 'export VOLCENGINE_ACCESS_KEY_ID=')}\n`
  assert.deepEqual(parsePrivateTosEnvironment(content), env)
  const literal = { ...env, VOLCENGINE_SECRET_ACCESS_KEY: '$(synthetic-command) `synthetic` $HOME # literal' }
  assert.deepEqual(parsePrivateTosEnvironment(envText(literal).replace(`=${literal.VOLCENGINE_SECRET_ACCESS_KEY}`, `='${literal.VOLCENGINE_SECRET_ACCESS_KEY}'`)), literal)
  assert.deepEqual(parsePrivateTosEnvironment(envText({ ...env, VOLCENGINE_ACCESS_KEY_ID: '"synthetic-only-key"' }).replace(/\n/gu, '\r\n')), env)
})

for (const bad of ['bucket', 'region', 'endpoint', 'public endpoint', 'prefix', 'missing credential', 'duplicate', 'undeclared secret', 'unterminated quote',
  'empty', 'NUL', 'oversize value', 'oversize file', 'non-string']) test(`rejects private configuration ${bad}`, () => {
  const value = { ...env }
  let contents
  if (bad === 'bucket') value.MUSE_TOS_BUCKET = 'other'
  if (bad === 'region') value.MUSE_TOS_REGION = 'cn-shanghai'
  if (bad === 'endpoint') value.MUSE_TOS_S3_ENDPOINT = 'http://tos-s3-cn-beijing.volces.com'
  if (bad === 'public endpoint') value.MUSE_TOS_PUBLIC_BASE_URL = 'https://another.invalid'
  if (bad === 'prefix') value.MUSE_TOS_PREFIX = 'other'
  if (bad === 'missing credential') delete value.VOLCENGINE_SECRET_ACCESS_KEY
  if (bad === 'empty') value.VOLCENGINE_SECRET_ACCESS_KEY = ''
  if (bad === 'NUL') value.VOLCENGINE_SECRET_ACCESS_KEY = 'synthetic\0invalid'
  if (bad === 'oversize value') value.VOLCENGINE_SECRET_ACCESS_KEY = 's'.repeat(4097)
  contents = envText(value)
  if (bad === 'duplicate') contents += '\nMUSE_TOS_BUCKET=muse'
  if (bad === 'undeclared secret') contents += '\nUNRELATED_SECRET=synthetic'
  if (bad === 'unterminated quote') contents = contents.replace('synthetic-only-secret', '"unterminated')
  if (bad === 'oversize file') contents = '#'.repeat(16385)
  if (bad === 'non-string') contents = undefined
  assert.throws(() => parsePrivateTosEnvironment(contents))
})

async function sourceFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'muse-tos-original-source-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const files = new Map(PUBLISHER_INPUTS.map(name => [name, Buffer.from(name.endsWith('muse-product.json')
    ? JSON.stringify({ version: '1.0.5', legacyRcDiscovery: true }) : `// original synthetic producer ${name}\n`)]))
  for (const [name, bytes] of files) { await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), bytes) }
  const calls = [], f = { root, files, calls, head: sourceCommit, seal: { sourceCommit, version: '1.0.5' } }
  f.git = args => { calls.push(args); if (args[0] === 'rev-parse') return Buffer.from(`${f.head}\n`)
    assert.equal(args[0], 'show'); return files.get(args[1].slice(sourceCommit.length + 1)) }
  f.run = () => verifyFinalPublisherSource(f.seal, root, f.git)
  return f
}

test('requires exact source HEAD and byte-identical declared original producer blobs', async t => {
  const f = await sourceFixture(t)
  assert.equal(await f.run(), join(f.root, 'apps/desktop/scripts/publish-muse-tos.mjs'))
  assert.deepEqual(f.calls, [['rev-parse', 'HEAD'], ...PUBLISHER_INPUTS.map(name => ['show', `${sourceCommit}:${name}`])])
  assert.deepEqual(await readFile(join(f.root, PUBLISHER_INPUTS[1])), f.files.get(PUBLISHER_INPUTS[1]))
})

for (const change of ['invalid source', 'head', 'changed blob', 'missing file', 'directory', 'product version', 'legacy channel'])
  test(`refuses producer source ${change}`, async t => {
    const f = await sourceFixture(t), path = join(f.root, PUBLISHER_INPUTS[1])
    if (change === 'invalid source') f.seal.sourceCommit = 'invalid'
    if (change === 'head') f.head = 'b'.repeat(40)
    if (change === 'changed blob') await writeFile(path, 'changed source')
    if (change === 'missing file') await unlink(path)
    if (change === 'directory') { await unlink(path); await mkdir(path) }
    if (change === 'product version' || change === 'legacy channel') {
      const bytes = Buffer.from(JSON.stringify({ version: change === 'product version' ? '1.0.4' : '1.0.5', legacyRcDiscovery: change !== 'legacy channel' }))
      f.files.set(PUBLISHER_INPUTS[0], bytes); await writeFile(join(f.root, PUBLISHER_INPUTS[0]), bytes)
    }
    await assert.rejects(f.run())
  })

test('refuses a producer symlink even if it points to identical bytes', { skip: process.platform === 'win32' ? 'Requires POSIX symlink creation privileges' : false }, async t => {
  const f = await sourceFixture(t), path = join(f.root, PUBLISHER_INPUTS[1]), target = join(f.root, 'same-bytes')
  await writeFile(target, f.files.get(PUBLISHER_INPUTS[1])); await unlink(path); await symlink(target, path)
  await assert.rejects(f.run(), /must be regular/u)
})

function planFixture() {
  const version = '1.0.5', artifacts = []
  for (const [target, extensions] of [['mac-arm64', ['dmg', 'zip', 'zip.blockmap']], ['win-x64', ['exe', 'exe.blockmap']]]) {
    for (const extension of extensions) {
      const filename = `muse-med-${version}-${target}.${extension}`, bytes = Buffer.from(`synthetic binary ${filename}`)
      artifacts.push({ filename, path: `/synthetic/${target}/${filename}`, key: `releases/${version}/${target}/${filename}`,
        size: bytes.length, sha256: hash(bytes), sha512: hash(bytes, 'sha512', 'base64') })
    }
  }
  const githubMetadata = [], metadata = []
  for (const [target, names, payloads] of [['mac-arm64', ['latest-mac.yml', 'rc-mac.yml'], ['zip', 'dmg']],
    ['win-x64', ['latest.yml', 'rc.yml'], ['exe']]]) {
    const files = payloads.map(extension => {
      const binary = artifacts.find(file => file.filename === `muse-med-${version}-${target}.${extension}`)
      return { url: binary.filename, sha512: binary.sha512, size: binary.size }
    })
    const publication = { version, files, path: files[0].url, sha512: files[0].sha512, releaseDate: 'synthetic-date' }
    const mirrorFiles = files.map(file => ({ ...file, url: `https://muse.tos-cn-beijing.volces.com/releases/${version}/${target}/${file.url}` }))
    for (const filename of names) {
      githubMetadata.push({ filename, contents: JSON.stringify(publication) })
      const contents = JSON.stringify({ ...publication, files: mirrorFiles, path: mirrorFiles[0].url })
      metadata.push({ filename, key: `releases/feeds/${target}/${filename}`, contents, sha256: hash(contents) })
    }
  }
  const files = [...artifacts.map(({ filename, size, sha256 }) => ({ filename, size, sha256 })),
    ...githubMetadata.map(file => ({ filename: file.filename, size: Buffer.byteLength(file.contents), sha256: hash(file.contents) })),
    ...['muse-desktop-builds.json', 'muse-desktop-SHA256SUMS.txt'].map(filename => ({ filename, size: 1, sha256: hash('x') }))]
  return { plan: { version, sourceCommit, artifacts, githubMetadata, metadata }, seal: { version, sourceCommit, files } }
}

test('binds five sealed original binaries and four ZIP-first stable/RC TOS feeds', () => {
  const f = planFixture()
  assert.equal(verifyTosPublicationPlan(f.seal, f.plan, JSON.parse), f.plan)
})

for (const change of ['version', 'source', 'binary count', 'binary name', 'binary key', 'binary size', 'binary hash', 'github count', 'tos count',
  'github bytes', 'tos key', 'tos hash', 'tos destination', 'payload count', 'ZIP-first order', 'primary path', 'primary hash', 'wrong payload hash', 'wrong payload size'])
  test(`rejects unsealed publication plan ${change}`, () => {
    const f = planFixture()
    if (change === 'version') f.plan.version = '1.0.4'
    if (change === 'source') f.plan.sourceCommit = 'b'.repeat(40)
    if (change === 'binary count') f.plan.artifacts.pop()
    if (change === 'binary name') f.plan.artifacts[0].filename = 'another-binary.dmg'
    if (change === 'binary key') f.plan.artifacts[0].key = 'releases/other/file.dmg'
    if (change === 'binary size') f.plan.artifacts[0].size++
    if (change === 'binary hash') f.plan.artifacts[0].sha256 = 'b'.repeat(64)
    if (change === 'github count') f.plan.githubMetadata.pop()
    if (change === 'tos count') f.plan.metadata.pop()
    if (change === 'github bytes') f.plan.githubMetadata[0].contents += ' '
    if (change === 'tos key') f.plan.metadata[0].key = 'other-channel'
    if (change === 'tos hash') f.plan.metadata[0].sha256 = 'b'.repeat(64)
    if (['tos destination', 'payload count', 'ZIP-first order', 'primary path', 'primary hash', 'wrong payload hash', 'wrong payload size'].includes(change)) {
      const publication = JSON.parse(f.plan.githubMetadata[0].contents), mirrored = JSON.parse(f.plan.metadata[0].contents)
      if (change === 'tos destination') mirrored.files[0].url = 'https://other.invalid/file.zip'
      if (change === 'payload count') publication.files.pop()
      if (change === 'ZIP-first order') publication.files.reverse()
      if (change === 'primary path') publication.path = publication.files[1].url
      if (change === 'primary hash') publication.sha512 = 'synthetic-other-hash'
      if (change === 'wrong payload hash') publication.files[0].sha512 = 'synthetic-other-hash'
      if (change === 'wrong payload size') publication.files[0].size++
      f.plan.githubMetadata[0].contents = JSON.stringify(publication)
      const recorded = f.seal.files.find(file => file.filename === f.plan.githubMetadata[0].filename)
      recorded.size = Buffer.byteLength(f.plan.githubMetadata[0].contents); recorded.sha256 = hash(f.plan.githubMetadata[0].contents)
      f.plan.metadata[0].contents = JSON.stringify(mirrored); f.plan.metadata[0].sha256 = hash(f.plan.metadata[0].contents)
    }
    assert.throws(() => verifyTosPublicationPlan(f.seal, f.plan, JSON.parse))
  })

function publisherEvents(plan) {
  return [...plan.artifacts.map(({ key, size, sha256 }) => ({ stage: 'binary-verified', key, size, sha256 })),
    ...plan.metadata.map(({ key, sha256 }) => ({ stage: 'feed-verified', key, sha256 })),
    { stage: 'published', version: plan.version, sourceCommit: plan.sourceCommit, binaries: 5, feeds: 4 }]
}

test('accepts only five verified binaries followed by four verified feeds and final completion', () => {
  const { plan } = planFixture(), observed = [], observer = createTosPublisherObserver(plan, event => observed.push(event))
  for (const event of publisherEvents(plan)) observer.observe(JSON.stringify(event))
  const receipt = observer.complete(0)
  assert.equal(receipt.binaries.length, 5); assert.equal(receipt.feeds.length, 4)
  assert.deepEqual(observed.at(-1), { stage: 'published', version: plan.version, sourceCommit, binaries: 5, feeds: 4 })
})

test('projects SDK diagnostics without forwarding secret fields or wire messages', () => {
  const { plan } = planFixture(), events = [], observer = createTosPublisherObserver(plan, event => events.push(event))
  observer.observe(JSON.stringify({ stage: 'sdk-request-failed', key: plan.artifacts[0].key, code: 'EPIPE', syscall: 'write', elapsedMs: 12,
    status: null, attempts: 1, message: 'synthetic token signed URL', credentials: 'synthetic-secret' }))
  observer.observe(JSON.stringify({ stage: 'sdk-log', key: plan.artifacts[0].key, level: 'error', message: 'synthetic-secret', sourceBytesRead: -1 }))
  assert.deepEqual(events, [{ stage: 'sdk-request-failed', key: plan.artifacts[0].key, elapsedMs: 12, attempts: 1, code: 'EPIPE', syscall: 'write' },
    { stage: 'sdk-log', key: plan.artifacts[0].key, level: 'error' }])
  assert.ok(!JSON.stringify(events).includes('synthetic-secret'))
  assert.ok(!JSON.stringify(events).includes('signed URL'))
})

for (const change of ['feed first', 'binary order', 'binary size', 'binary hash', 'feed order', 'feed hash', 'no published', 'partial binaries',
  'partial feeds', 'wrong version', 'wrong source', 'wrong counts', 'after published', 'after failure', 'exit failed', 'unknown stage', 'foreign diagnostic', 'non JSON', 'oversize log'])
  test(`rejects incomplete or invalid publisher events ${change}`, () => {
    const { plan } = planFixture(), events = publisherEvents(plan), observer = createTosPublisherObserver(plan)
    if (change === 'feed first') events.unshift(events[5])
    if (change === 'binary order') [events[0], events[1]] = [events[1], events[0]]
    if (change === 'binary size') events[0].size++
    if (change === 'binary hash') events[0].sha256 = 'b'.repeat(64)
    if (change === 'feed order') [events[5], events[6]] = [events[6], events[5]]
    if (change === 'feed hash') events[5].sha256 = 'b'.repeat(64)
    if (change === 'no published') events.pop()
    if (change === 'partial binaries') events.splice(4, 1)
    if (change === 'partial feeds') events.splice(8, 1)
    if (change === 'wrong version') events.at(-1).version = '1.0.4'
    if (change === 'wrong source') events.at(-1).sourceCommit = 'b'.repeat(40)
    if (change === 'wrong counts') events.at(-1).binaries = 4
    if (change === 'after published') events.push(events[0])
    if (change === 'after failure') events.unshift({ stage: 'failed', message: 'synthetic-secret' })
    if (change === 'unknown stage') events.unshift({ stage: 'unknown-secret-log' })
    if (change === 'foreign diagnostic') events.unshift({ stage: 'sdk-log', key: 'https://signed-secret.invalid' })
    assert.throws(() => {
      if (change === 'non JSON') observer.observe('synthetic secret non-JSON log')
      if (change === 'oversize log') observer.observe('x'.repeat(16385))
      for (const event of events) observer.observe(JSON.stringify(event))
      observer.complete(change === 'exit failed' ? 1 : 0)
    })
  })
