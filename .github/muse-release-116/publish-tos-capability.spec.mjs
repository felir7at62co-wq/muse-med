/** Offline capability execution, ordering and secret-transport checks; no cloud requests. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import { RELEASE_SEAL, validateCapabilityPlan, publishCapability, curlRequest, binaryRanges, parsePublicHeaders, verifyRangeHeaders } from './publish-tos-capability.mjs'

const NOW = Date.parse('2026-10-19T00:00:00.000Z')
const digest = (bytes, kind = 'sha256', encoding = 'hex') => createHash(kind).update(bytes).digest(encoding)
const BASE = 'https://muse.tos-cn-beijing.volces.com'
const binaryRows = ['mac-arm64/muse-med-1.1.6-mac-arm64.dmg', 'mac-arm64/muse-med-1.1.6-mac-arm64.zip', 'mac-arm64/muse-med-1.1.6-mac-arm64.zip.blockmap', 'win-x64/muse-med-1.1.6-win-x64.exe', 'win-x64/muse-med-1.1.6-win-x64.exe.blockmap']
const feedRows = ['mac-arm64/latest-mac.yml', 'mac-arm64/rc-mac.yml', 'win-x64/latest.yml', 'win-x64/rc.yml']
function signed(key, bytes, immutable) {
  const headers = { 'content-length': String(bytes.length), 'content-type': immutable ? 'application/octet-stream' : 'text/yaml',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache, max-age=0, must-revalidate',
    'content-md5': digest(bytes, 'md5', 'base64'), ...immutable ? { 'if-none-match': '*' } : { 'if-match': '"old-feed"' } }
  const url = new URL(`https://muse.tos-s3-cn-beijing.volces.com/${key}`)
  for (const [name, value] of Object.entries({ 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': 'FAKE/20261019/cn-beijing/s3/aws4_request',
    'X-Amz-Date': '20261019T000000Z', 'X-Amz-Expires': '3600', 'X-Amz-SignedHeaders': ['host', ...Object.keys(headers)].sort().join(';'), 'X-Amz-Signature': 'a'.repeat(64), 'x-id': 'PutObject' })) url.searchParams.set(name, value)
  return { url: url.href, headers }
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'muse-capability-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const assetsDir = join(root, 'assets'); await mkdir(assetsDir)
  const data = new Map(binaryRows.map(row => [row.split('/').at(-1), Buffer.from(`fixture bytes: ${row}`.repeat(2))]))
  for (const row of feedRows) {
    const name = row.split('/').at(-1), target = row.split('/')[0]
    data.set(name, Buffer.from('version: 1.1.6\nfiles:\n' + binaryRows.filter(x => x.startsWith(target) && !x.endsWith('.blockmap')).map(x => `  - url: ${x.split('/').at(-1)}\n`).join('')))
  }
  for (const name of ['muse-desktop-builds.json', 'muse-installer-acceptance.json', 'muse-desktop-SHA256SUMS.txt']) data.set(name, Buffer.from(`sealed fixture ${name}\n`))
  for (const [name, bytes] of data) await writeFile(join(assetsDir, name), bytes)
  const manifest = { schemaVersion: 1, version: RELEASE_SEAL.version, sourceCommit: RELEASE_SEAL.sourceCommit, unsigned: true, assetCount: 12,
    assets: [...data].map(([filename, bytes]) => ({ filename, size: bytes.length, sha256: digest(bytes), sha512: digest(bytes, 'sha512', 'base64') })) }
  const manifestBytes = Buffer.from(JSON.stringify(manifest)), manifestPath = join(root, 'manifest.json')
  await writeFile(manifestPath, manifestBytes)
  const seal = { ...RELEASE_SEAL, manifestSha256: digest(manifestBytes) }
  const artifacts = binaryRows.map(row => {
    const filename = row.split('/').at(-1), bytes = data.get(filename), key = `releases/1.1.6/${row}`
    return { key, filename, size: bytes.length, sha256: digest(bytes), sha512: digest(bytes, 'sha512', 'base64'), ...signed(key, bytes, true) }
  })
  const metadata = feedRows.map(row => {
    let contents = data.get(row.split('/').at(-1)).toString()
    for (const binary of artifacts) contents = contents.replaceAll(binary.filename, `${BASE}/${binary.key}`)
    const bytes = Buffer.from(contents), key = `releases/feeds/${row}`
    return { key, contentsBase64: bytes.toString('base64'), sha256: digest(bytes), ...signed(key, bytes, false) }
  })
  const plan = { version: seal.version, sourceCommit: seal.sourceCommit, manifestSha256: seal.manifestSha256,
    expiresAt: new Date(NOW + 3600000).toISOString(), artifacts, metadata }
  const options = { plan, manifestPath, assetsDir, receiptPath: join(root, 'receipt.json'), execute: true }
  return { root, data, plan, seal, options, manifestBytes, metadataBytes: new Map([...data].filter(([name]) => name.endsWith('.yml'))) }
}
function transport(f, { existing = true, corrupt = false, badRange = false, unknownPut = false, feed412 = false, desiredFeed = false } = {}) {
  const events = [], objects = new Map()
  if (existing) for (const item of f.plan.artifacts) objects.set(item.key, f.data.get(item.filename))
  if (desiredFeed) for (const item of f.plan.metadata) objects.set(item.key, Buffer.from(item.contentsBase64, 'base64'))
  const request = async req => {
    const url = new URL(req.url), privateRequest = url.hostname !== 'muse.tos-cn-beijing.volces.com'
    const key = url.pathname.replace(/^\/(?:muse\/)?/u, '')
    events.push({ method: req.method, key, privateRequest })
    if (req.method === 'PUT') {
      if (unknownPut) throw new Error('transport diagnostic PRIVATE-SIGNATURE ' + req.url)
      if (feed412 && key.includes('/feeds/')) return { status: 412, headers: {} }
      objects.set(key, await readFile(req.bodyPath)); return { status: 200, headers: {} }
    }
    const bytes = objects.get(key)
    if (!bytes) return { status: 404, headers: {} }
    const headers = { 'content-length': String(bytes.length), 'accept-ranges': 'bytes', etag: '"fixture-etag"' }
    if (req.method === 'HEAD') return { status: 200, headers }
    if (req.range) {
      const part = Buffer.from(bytes.subarray(req.range.start, req.range.end + 1))
      if (corrupt && req.range.index === 0) part[0] ^= 1
      await writeFile(req.outputPath, part)
      return { status: badRange ? 200 : 206, headers: { ...headers, 'content-length': String(part.length),
        'content-range': `bytes ${req.range.start}-${req.range.end}/${bytes.length}` } }
    }
    await writeFile(req.outputPath, bytes); return { status: 200, headers }
  }
  return { request, events, objects }
}
test('capability host, bucket, exact key, operation, expiry and immutable signed headers are enforced offline', async t => {
  const f = await fixture(t)
  validateCapabilityPlan(f.plan, f.manifestBytes, { seal: f.seal, now: NOW, metadataBytes: f.metadataBytes })
  const mutate = fn => { const plan = structuredClone(f.plan); fn(plan); return () => validateCapabilityPlan(plan, f.manifestBytes, { seal: f.seal, now: NOW, metadataBytes: f.metadataBytes }) }
  for (const change of [
    p => { p.artifacts[0].url = p.artifacts[0].url.replace('muse.tos-s3-cn-beijing.volces.com', 'evil.example') },
    p => { p.artifacts[0].url = p.artifacts[0].url.replace('https:', 'http:') },
    p => { p.artifacts[0].url = p.artifacts[0].url.replace('/releases/', '/other-bucket/') },
    p => { p.artifacts[0].url += '&uploadId=unrelated' },
    p => { p.artifacts[0].headers['if-none-match'] = 'unsafe' },
    p => { p.artifacts[0].headers['content-length'] = '1' },
    p => { p.artifacts[0].url = p.artifacts[0].url.replace('if-none-match', 'not-signed') },
    p => { p.expiresAt = new Date(NOW - 1).toISOString() },
    p => { p.sourceCommit = '0'.repeat(40) },
    p => { p.metadata[0].key = 'releases/feeds/other/latest.yml' },
  ]) assert.throws(mutate(change))
})
test('all local inputs are sealed and execution needs explicit execute', async t => {
  const f = await fixture(t), wire = transport(f)
  const result = await publishCapability({ ...f.options, execute: false }, { seal: f.seal, now: () => NOW, request: wire.request })
  assert.equal(result.stage, 'validated-no-execution'); assert.equal(wire.events.length, 0)
  await writeFile(join(f.options.assetsDir, 'unexpected-private.json'), 'not in the release')
  await assert.rejects(publishCapability(f.options, { seal: f.seal, now: () => NOW, request: wire.request }), /local-asset-set/u)
  assert.equal(wire.events.length, 0)
})
test('local wrong bytes, content MD5 and altered feed are rejected before network', async t => {
  const f = await fixture(t), wire = transport(f)
  const plan = structuredClone(f.plan); plan.artifacts[0].headers['content-md5'] = 'A'.repeat(22) + '=='
  await assert.rejects(publishCapability({ ...f.options, plan }, { seal: f.seal, now: () => NOW, request: wire.request }), /binary-md5/u)
  const edited = structuredClone(f.plan), contents = Buffer.from('version: 999\n')
  edited.metadata[0] = { ...edited.metadata[0], contentsBase64: contents.toString('base64'), sha256: digest(contents), ...signed(edited.metadata[0].key, contents, false) }
  await assert.rejects(publishCapability({ ...f.options, plan: edited }, { seal: f.seal, now: () => NOW, request: wire.request }), /feed-sealed-content/u)
  await writeFile(join(f.options.assetsDir, f.plan.artifacts[0].filename), 'wrong')
  await assert.rejects(publishCapability(f.options, { seal: f.seal, now: () => NOW, request: wire.request }), /local-asset-hash/u)
  assert.equal(wire.events.length, 0)
})
test('existing binary objects are fully read with eight exact ranges before any feed PUT', async t => {
  const f = await fixture(t), wire = transport(f)
  const receipt = await publishCapability(f.options, { seal: f.seal, now: () => NOW, request: wire.request })
  assert.equal(receipt.stage, 'published-verified'); assert.equal(receipt.binaries.length, 5); assert.equal(receipt.feeds.length, 4)
  assert.equal(wire.events.filter(x => x.method === 'PUT' && !x.key.includes('/feeds/')).length, 0)
  const firstFeed = wire.events.findIndex(x => x.method === 'PUT' && x.key.includes('/feeds/'))
  assert.equal(wire.events.slice(0, firstFeed).filter(x => x.method === 'GET').length, 40)
  const text = await readFile(f.options.receiptPath, 'utf8')
  assert.doesNotMatch(text, /X-Amz|https:|headers|PRIVATE-SIGNATURE/u)
})
test('missing binaries get one conditional PUT each and unknown PUT is never automatically repeated', async t => {
  const f = await fixture(t), wire = transport(f, { existing: false })
  await publishCapability(f.options, { seal: f.seal, now: () => NOW, request: wire.request })
  assert.equal(wire.events.filter(x => x.method === 'PUT' && !x.key.includes('/feeds/')).length, 5)
  const broken = await fixture(t), badWire = transport(broken, { existing: false, unknownPut: true })
  await assert.rejects(publishCapability(broken.options, { seal: broken.seal, now: () => NOW, request: badWire.request }))
  await assert.rejects(publishCapability(broken.options, { seal: broken.seal, now: () => NOW, request: badWire.request }))
  assert.equal(badWire.events.filter(x => x.method === 'PUT').length, 1)
  assert.doesNotMatch(await readFile(broken.options.receiptPath, 'utf8'), /PRIVATE-SIGNATURE|X-Amz|https:/u)
})
for (const mode of [{ corrupt: true }, { badRange: true }]) test(`failed public binary readback never promotes feeds ${JSON.stringify(mode)}`, async t => {
  const f = await fixture(t), wire = transport(f, mode)
  await assert.rejects(publishCapability(f.options, { seal: f.seal, now: () => NOW, request: wire.request }))
  assert.equal(wire.events.filter(x => x.method === 'PUT').length, 0)
})
test('feed conditional conflict succeeds only when exact desired public bytes already exist', async t => {
  const f = await fixture(t), wire = transport(f, { feed412: true, desiredFeed: true })
  assert.equal((await publishCapability(f.options, { seal: f.seal, now: () => NOW, request: wire.request })).stage, 'published-verified')
  const g = await fixture(t), bad = transport(g, { feed412: true, desiredFeed: true })
  bad.objects.set(g.plan.metadata[0].key, Buffer.from('another release'))
  await assert.rejects(publishCapability(g.options, { seal: g.seal, now: () => NOW, request: bad.request }), /feed-public-hash/u)
  assert.equal(bad.events.filter(x => x.method === 'PUT').length, 1)
})
test('range protocol rejects mixed identities and duplicated conflicting headers', () => {
  const ranges = binaryRanges(103); assert.equal(ranges[0].start, 0); assert.equal(ranges.at(-1).end, 102)
  assert.equal(ranges.reduce((sum, range) => sum + range.end - range.start + 1, 0), 103)
  assert.throws(() => parsePublicHeaders('HTTP/1.1 206 OK\r\nContent-Length: 1\r\nContent-Length: 2\r\n'))
  const range = ranges[0], source = { size: 103, etag: '"expected"' }
  assert.throws(() => verifyRangeHeaders({ status: 206, headers: { 'content-range': `bytes 0-${range.end}/103`, 'content-length': String(range.end + 1), etag: '"other"' } }, range, source))
})
test('curl private capability travels only via stdin and is absent from argv, child env and emitted diagnostics', async () => {
  let invocation, input = ''
  const spawnImpl = (command, args, options) => {
    invocation = { command, args, options }
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.kill = () => true
    child.stdin = new Writable({ write(chunk, _encoding, next) { input += chunk.toString(); next() }, final(next) {
      child.stderr.write('PRIVATE-SIGNATURE https://secret.invalid'); child.stdout.write('200'); next(); queueMicrotask(() => child.emit('close', 0))
    } }); return child
  }
  const response = await curlRequest({ url: 'https://muse.tos-s3-cn-beijing.volces.com/key?PRIVATE-SIGNATURE=secret', method: 'PUT', headers: { 'content-md5': 'SECRETMD5' }, bodyPath: '/public/release.bin' },
    { spawnImpl, environment: { PATH: '/bin', MUSE_RELEASE_116_TOS_PLAN: 'PLANSECRET', GH_TOKEN: 'TOKENVALUE' } })
  assert.equal(response.status, 200); assert.deepEqual(invocation.args, ['--disable', '--config', '-'])
  assert.deepEqual(invocation.options.env, { PATH: '/bin' }); assert.match(input, /PRIVATE-SIGNATURE/u)
  assert.doesNotMatch(JSON.stringify(invocation), /PRIVATE-SIGNATURE|PLANSECRET|TOKENVALUE/u)
})
