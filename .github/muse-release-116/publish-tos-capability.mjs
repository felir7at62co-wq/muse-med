/** Execute one sealed, expiring TOS PUT capability without possessing release credentials. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export const RELEASE_SEAL = Object.freeze({ version: '1.1.6', sourceCommit: '0064a968241e80645892ee7268167cc7f4a7cd4c',
  manifestSha256: 'b919499215f77bbecbb7dfc4f5da17a11bfd9b1ff0ffbafef1a067e6f979cf15' })
const BASE = 'https://muse.tos-cn-beijing.volces.com'
const BINARY_ROWS = ['mac-arm64/muse-med-1.1.6-mac-arm64.dmg', 'mac-arm64/muse-med-1.1.6-mac-arm64.zip',
  'mac-arm64/muse-med-1.1.6-mac-arm64.zip.blockmap', 'win-x64/muse-med-1.1.6-win-x64.exe', 'win-x64/muse-med-1.1.6-win-x64.exe.blockmap']
const FEED_ROWS = ['mac-arm64/latest-mac.yml', 'mac-arm64/rc-mac.yml', 'win-x64/latest.yml', 'win-x64/rc.yml']
const PUBLIC_NAMES = [...BINARY_ROWS.map(row => row.split('/').at(-1)), ...FEED_ROWS.map(row => row.split('/').at(-1)),
  'muse-desktop-builds.json', 'muse-installer-acceptance.json', 'muse-desktop-SHA256SUMS.txt'].sort()
class CapabilityError extends Error { constructor(code) { super(code); this.code = code } }
function check(value, code) { if (!value) throw new CapabilityError(code) }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function object(value) { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function exactKeys(value, keys) { return object(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|') }
function decodeJson(text) { try { return JSON.parse(text) } catch { throw new CapabilityError('invalid-json') } }

/** Parse the final HTTP block, including proxy CONNECT responses, as the tested ranged publisher does. */
export function parsePublicHeaders(text) {
  let response = null
  for (const line of text.split(/\r?\n/u)) {
    const status = /^HTTP\/\S+\s+(\d{3})(?:\s|$)/u.exec(line)
    if (status) { response = { status: Number(status[1]), headers: {} }; continue }
    if (!response || line === '') continue
    const colon = line.indexOf(':'); if (colon < 1) continue
    const key = line.slice(0, colon).trim().toLowerCase(), value = line.slice(colon + 1).trim()
    if (['content-length', 'content-range', 'etag', 'content-encoding', 'accept-ranges'].includes(key)) {
      check(response.headers[key] === undefined || response.headers[key] === value, 'conflicting-public-headers')
    }
    response.headers[key] = value
  }
  check(response !== null, 'missing-public-status'); return response
}
/** Eight adjacent inclusive ranges cover every byte exactly once. */
export function binaryRanges(size) {
  check(Number.isSafeInteger(size) && size >= 8, 'invalid-binary-size')
  return Array.from({ length: 8 }, (_, index) => ({ index, start: Math.floor(size * index / 8), end: Math.floor(size * (index + 1) / 8) - 1 }))
}
/** Require the exact unencoded range and strong object identity, without accepting a full-file fallback. */
export function verifyRangeHeaders(response, range, source) {
  check(response.status === 206, 'range-status')
  check(response.headers['content-range'] === `bytes ${range.start}-${range.end}/${source.size}`, 'range-content-range')
  check(response.headers.etag === source.etag, 'range-etag')
  check(response.headers['content-length'] === String(range.end - range.start + 1), 'range-content-length')
  check(response.headers['content-encoding'] === undefined || response.headers['content-encoding'] === 'identity', 'encoded-range')
}

function signedPut(item, size, immutable, expiresAt, now) {
  check(typeof item.url === 'string' && !/[\s\\\u0000-\u001f\u007f]/u.test(item.url), 'invalid-signed-url')
  let url; try { url = new URL(item.url) } catch { throw new CapabilityError('invalid-signed-url') }
  check(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash, 'signed-url-origin')
  const virtual = url.hostname === 'muse.tos-s3-cn-beijing.volces.com'
  const pathStyle = url.hostname === 'tos-s3-cn-beijing.volces.com'
  check(virtual || pathStyle, 'signed-url-host')
  check(url.pathname === `${pathStyle ? '/muse' : ''}/${item.key}`, 'signed-url-key')
  const queryNames = new Set(['X-Amz-Algorithm', 'X-Amz-Credential', 'X-Amz-Date', 'X-Amz-Expires', 'X-Amz-SignedHeaders', 'X-Amz-Signature', 'X-Amz-Security-Token', 'X-Amz-Content-Sha256', 'x-id'])
  check([...url.searchParams.keys()].every(name => queryNames.has(name)) && (!url.searchParams.has('x-id') || url.searchParams.get('x-id') === 'PutObject'), 'signed-url-operation')
  for (const name of ['X-Amz-Algorithm', 'X-Amz-Credential', 'X-Amz-Date', 'X-Amz-Expires', 'X-Amz-SignedHeaders', 'X-Amz-Signature']) {
    check(url.searchParams.getAll(name).length === 1, 'signed-url-parameters')
  }
  check(url.searchParams.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256', 'signed-url-algorithm')
  const date = url.searchParams.get('X-Amz-Date')
  check(/^\d{8}T\d{6}Z$/u.test(date), 'signed-url-date')
  const signedAt = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`)
  const seconds = Number(url.searchParams.get('X-Amz-Expires'))
  check(Number.isInteger(seconds) && seconds > 0 && seconds <= 7200 && signedAt <= now + 60000
    && signedAt + seconds * 1000 > now && signedAt + seconds * 1000 <= expiresAt, 'signed-url-expiry')
  check(url.searchParams.get('X-Amz-Credential').endsWith(`/${date.slice(0, 8)}/cn-beijing/s3/aws4_request`), 'signed-url-scope')
  check(/^[a-f0-9]{64}$/u.test(url.searchParams.get('X-Amz-Signature')), 'signed-url-signature')
  check(object(item.headers), 'signed-headers')
  const headers = {}
  const allowed = new Set(['host', 'content-length', 'content-type', 'content-md5', 'cache-control', 'if-none-match', 'if-match', 'x-amz-content-sha256', 'x-amz-checksum-sha256'])
  for (const [key, value] of Object.entries(item.headers)) {
    const lower = key.toLowerCase()
    check(allowed.has(lower) && headers[lower] === undefined && typeof value === 'string'
      && value.length <= 4096 && !/[\r\n\u0000]/u.test(value), 'signed-header-value')
    headers[lower] = value
  }
  check(headers['content-length'] === String(size), 'signed-content-length')
  check(/^[A-Za-z0-9+/]{22}==$/u.test(headers['content-md5'] ?? ''), 'signed-content-md5')
  check(headers.host === undefined || headers.host === url.host, 'signed-host-header')
  const signed = url.searchParams.get('X-Amz-SignedHeaders').split(';')
  check(signed.includes('host') && signed.includes('content-length'), 'unsigned-required-header')
  check(Object.keys(headers).every(name => signed.includes(name)), 'unsigned-provided-header')
  if (immutable) check(headers['if-none-match'] === '*' && signed.includes('if-none-match'), 'immutable-precondition')
  else check(/^"[^"\r\n]+"$/u.test(headers['if-match'] ?? '') && signed.includes('if-match'), 'feed-precondition')
  return { url: url.href, headers }
}

/** Validate an expiring capability against the exact sealed manifest; no network or mutation occurs here. */
export function validateCapabilityPlan(plan, manifestBytes, { seal = RELEASE_SEAL, now = Date.now(), metadataBytes, md5ByName } = {}) {
  check(exactKeys(plan, ['version', 'sourceCommit', 'manifestSha256', 'expiresAt', 'artifacts', 'metadata']), 'plan-fields')
  check(plan.version === seal.version && plan.sourceCommit === seal.sourceCommit && plan.manifestSha256 === seal.manifestSha256, 'plan-identity')
  check(sha256(manifestBytes) === seal.manifestSha256, 'manifest-seal')
  const manifest = decodeJson(manifestBytes.toString('utf8'))
  check(manifest.schemaVersion === 1 && manifest.version === seal.version && manifest.sourceCommit === seal.sourceCommit
    && manifest.unsigned === true && manifest.assetCount === 12 && Array.isArray(manifest.assets)
    && manifest.assets.length === 12 && manifest.assets.map(row => row.filename).sort().join('|') === PUBLIC_NAMES.join('|'), 'manifest-identity')
  const expiresAt = Date.parse(plan.expiresAt)
  check(Number.isFinite(expiresAt) && expiresAt > now && expiresAt <= now + 7260000, 'plan-expiry')
  check(Array.isArray(plan.artifacts) && plan.artifacts.length === 5 && Array.isArray(plan.metadata) && plan.metadata.length === 4, 'plan-counts')
  const artifacts = BINARY_ROWS.map(row => {
    const key = `releases/${seal.version}/${row}`, filename = row.split('/').at(-1)
    const found = plan.artifacts.filter(item => item.key === key)
    check(found.length === 1, 'binary-key-set'); const item = found[0]
    check(exactKeys(item, ['key', 'filename', 'size', 'sha256', 'sha512', 'url', 'headers']), 'binary-fields')
    const expected = manifest.assets.find(asset => asset.filename === filename)
    check(item.filename === filename && Number.isSafeInteger(item.size) && item.size >= 8
      && item.size === expected.size && item.sha256 === expected.sha256 && item.sha512 === expected.sha512, 'binary-identity')
    if (md5ByName !== undefined) check(item.headers['content-md5'] === md5ByName.get(filename), 'binary-md5')
    return { ...item, ...signedPut(item, item.size, true, expiresAt, now) }
  })
  const metadata = FEED_ROWS.map(row => {
    const key = `releases/feeds/${row}`, found = plan.metadata.filter(item => item.key === key)
    check(found.length === 1, 'feed-key-set'); const item = found[0]
    check(exactKeys(item, ['key', 'contentsBase64', 'sha256', 'url', 'headers']), 'feed-fields')
    check(typeof item.contentsBase64 === 'string' && item.contentsBase64.length <= 65536, 'feed-base64')
    const contents = Buffer.from(item.contentsBase64, 'base64')
    check(contents.toString('base64') === item.contentsBase64 && sha256(contents) === item.sha256, 'feed-hash')
    check(item.headers['content-md5'] === createHash('md5').update(contents).digest('base64'), 'feed-md5')
    if (metadataBytes !== undefined) {
      const filename = row.split('/').at(-1)
      let expected = metadataBytes.get(filename).toString('utf8')
      for (const binary of artifacts) expected = expected.replaceAll(binary.filename, `${BASE}/${binary.key}`)
      check(contents.equals(Buffer.from(expected)), 'feed-sealed-content')
    }
    return { key, contents, sha256: item.sha256, ...signedPut(item, contents.length, false, expiresAt, now) }
  })
  return { artifacts, metadata, manifest, expiresAt }
}

async function hashFile(path) {
  const h256 = createHash('sha256'), h512 = createHash('sha512'), md5 = createHash('md5'); let size = 0
  for await (const bytes of createReadStream(path)) { size += bytes.length; h256.update(bytes); h512.update(bytes); md5.update(bytes) }
  return { size, sha256: h256.digest('hex'), sha512: h512.digest('base64'), md5: md5.digest('base64') }
}
function quote(value) { check(!/[\r\n\u0000]/u.test(String(value)), 'curl-config-value'); return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` }
/** Curl sees private URLs and headers only on stdin, with no user curlrc, redirects or automatic retries. */
export async function curlRequest(request, { spawnImpl = spawn, environment = process.env } = {}) {
  const lines = ['silent', 'http1.1', 'proto = "=https"', 'connect-timeout = 20', 'max-time = 1800', 'retry = 0',
    'speed-limit = 2048', 'speed-time = 90', `url = ${quote(request.url)}`, `request = ${quote(request.method)}`,
    `output = ${quote(request.outputPath ?? (process.platform === 'win32' ? 'NUL' : '/dev/null'))}`, 'write-out = "%{http_code}"']
  if (request.method === 'HEAD') lines.push('head')
  if (request.headerPath) lines.push(`dump-header = ${quote(request.headerPath)}`)
  if (request.bodyPath) lines.push(`upload-file = ${quote(request.bodyPath)}`)
  if (request.maxBytes) lines.push(`max-filesize = ${request.maxBytes}`)
  if (request.range) lines.push(`range = ${quote(`${request.range.start}-${request.range.end}`)}`)
  for (const [name, value] of Object.entries(request.headers ?? {})) lines.push(`header = ${quote(`${name}: ${value}`)}`)
  const env = Object.fromEntries(Object.entries(environment).filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD|MUSE_RELEASE_116_TOS_PLAN/iu.test(name)))
  const status = await new Promise((resolveRun, reject) => {
    const child = spawnImpl('curl', ['--disable', '--config', '-'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', failed = false
    const abort = () => child.kill('SIGTERM')
    request.signal?.addEventListener('abort', abort, { once: true })
    child.on('error', () => { failed = true })
    child.stdin.on('error', () => { failed = true })
    child.stderr.on('data', () => {})
    child.stdout.on('data', bytes => { if (stdout.length < 16) stdout += bytes.toString() })
    child.once('close', code => {
      request.signal?.removeEventListener('abort', abort)
      if (code !== 0 || failed || request.signal?.aborted || !/^\d{3}$/u.test(stdout)) reject(new CapabilityError('transport-incomplete-no-retry'))
      else resolveRun(Number(stdout))
    })
    child.stdin.end(lines.join('\n') + '\n')
    if (request.signal?.aborted) abort()
  })
  if (!request.headerPath) return { status, headers: {} }
  const response = parsePublicHeaders(await readFile(request.headerPath, 'utf8'))
  check(response.status === status, 'transport-status-mismatch'); return response
}

/** Validate all local bytes, then execute one ordered binary-before-feed publication when explicitly enabled. */
export async function publishCapability(options, { seal = RELEASE_SEAL, now = Date.now, request = curlRequest } = {}) {
  const assets = await realpath(options.assetsDir), manifestBytes = await readFile(options.manifestPath)
  const metadataBytes = new Map(), md5ByName = new Map()
  const validated = validateCapabilityPlan(options.plan, manifestBytes, { seal, now: now() })
  check((await readdir(assets)).sort().join('|') === PUBLIC_NAMES.join('|'), 'local-asset-set')
  for (const asset of validated.manifest.assets) {
    const path = join(assets, asset.filename), details = await lstat(path)
    check(details.isFile() && !details.isSymbolicLink(), 'local-asset-type')
    const actual = await hashFile(path)
    check(actual.size === asset.size && actual.sha256 === asset.sha256 && actual.sha512 === asset.sha512, 'local-asset-hash')
    md5ByName.set(asset.filename, actual.md5)
    if (asset.filename.endsWith('.yml')) metadataBytes.set(asset.filename, await readFile(path))
  }
  const plan = validateCapabilityPlan(options.plan, manifestBytes, { seal, now: now(), metadataBytes, md5ByName })
  const receipt = { version: seal.version, sourceCommit: seal.sourceCommit, manifestSha256: seal.manifestSha256,
    stage: options.execute ? 'executing' : 'validated-no-execution', binaries: [], feeds: [] }
  await mkdir(dirname(resolve(options.receiptPath)), { recursive: true })
  const save = () => writeFile(options.receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
  await save()
  if (!options.execute) return receipt
  const temporary = await mkdtemp(join(tmpdir(), 'muse-tos-capability-'))
  const attempts = options.receiptPath + '.attempts'; await mkdir(attempts, { recursive: true, mode: 0o700 })
  let sequence = 0
  const call = params => request({ ...params, signal: options.signal })
  const readPublic = (key, extra = {}) => call({ url: `${BASE}/${key}`, method: 'GET', headerPath: join(temporary, `headers-${sequence++}`), ...extra })
  const putOnce = async (item, bodyPath) => {
    check(now() < plan.expiresAt, 'capability-expired-before-put')
    await writeFile(join(attempts, sha256(item.key) + '.json'), JSON.stringify({ key: item.key, sha256: item.sha256, status: 'put-attempted' }) + '\n', { flag: 'wx', mode: 0o600 })
    return call({ url: item.url, headers: item.headers, method: 'PUT', bodyPath })
  }
  try {
    for (const file of plan.artifacts) {
      receipt.active = { key: file.key, sha256: file.sha256, status: 'verifying-binary' }; await save()
      let head = await call({ url: `${BASE}/${file.key}`, method: 'HEAD', headerPath: join(temporary, `headers-${sequence++}`) })
      if (head.status === 404) {
        const uploaded = await putOnce(file, join(assets, file.filename))
        check([200, 201, 204, 412].includes(uploaded.status), 'binary-put-status')
        head = await call({ url: `${BASE}/${file.key}`, method: 'HEAD', headerPath: join(temporary, `headers-${sequence++}`) })
      }
      check(head.status === 200 && head.headers['content-length'] === String(file.size), 'binary-head-size')
      check(/^"[^"\r\n]+"$/u.test(head.headers.etag ?? '') && head.headers['accept-ranges']?.toLowerCase() === 'bytes', 'binary-head-identity')
      const source = { size: file.size, etag: head.headers.etag }
      const parts = await Promise.allSettled(binaryRanges(file.size).map(async range => {
        const outputPath = join(temporary, `range-${sequence++}`)
        const response = await readPublic(file.key, { outputPath, maxBytes: range.end - range.start + 1, range,
          headers: { 'If-Match': source.etag, 'Accept-Encoding': 'identity' } })
        verifyRangeHeaders(response, range, source)
        check((await lstat(outputPath)).size === range.end - range.start + 1, 'range-byte-count')
        return outputPath
      }))
      for (const part of parts) if (part.status === 'rejected') throw part.reason
      const h256 = createHash('sha256'), h512 = createHash('sha512'); let size = 0
      for (const part of parts) for await (const bytes of createReadStream(part.value)) { size += bytes.length; h256.update(bytes); h512.update(bytes) }
      check(size === file.size && h256.digest('hex') === file.sha256 && h512.digest('base64') === file.sha512, 'binary-public-hash')
      receipt.binaries.push({ key: file.key, size, sha256: file.sha256, sha512: file.sha512, status: 'full-public-hash-verified' }); await save()
      for (const part of parts) await rm(part.value)
    }
    check(receipt.binaries.length === 5, 'binary-barrier')
    for (const file of plan.metadata) {
      receipt.active = { key: file.key, sha256: file.sha256, status: 'promoting-feed' }; await save()
      const bodyPath = join(temporary, `feed-${sequence++}`); await writeFile(bodyPath, file.contents)
      const uploaded = await putOnce(file, bodyPath)
      check([200, 201, 204, 412].includes(uploaded.status), 'feed-put-status')
      const outputPath = join(temporary, `feed-readback-${sequence++}`)
      const response = await readPublic(file.key, { outputPath, maxBytes: file.contents.length, headers: { 'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity' } })
      const bytes = await readFile(outputPath)
      check(response.status === 200 && bytes.equals(file.contents) && sha256(bytes) === file.sha256, 'feed-public-hash')
      receipt.feeds.push({ key: file.key, sha256: file.sha256, status: 'exact-public-bytes-verified' }); await save()
    }
    receipt.stage = 'published-verified'; delete receipt.active; await save(); return receipt
  } catch (error) {
    receipt.stage = 'failed'; if (receipt.active) receipt.active.status = 'failed'
    receipt.code = error instanceof CapabilityError ? error.code : 'execution-failed-no-retry'; await save(); throw error
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController(), stop = () => controller.abort()
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  try {
    const { values } = parseArgs({ options: { manifest: { type: 'string' }, assets: { type: 'string' }, receipt: { type: 'string' }, execute: { type: 'boolean', default: false } } })
    check(values.manifest && values.assets && values.receipt, 'required-cli-arguments')
    const raw = process.env.MUSE_RELEASE_116_TOS_PLAN
    check(typeof raw === 'string' && raw.length <= 131072, 'missing-capability')
    const receipt = await publishCapability({ plan: decodeJson(raw), manifestPath: values.manifest, assetsDir: values.assets,
      receiptPath: values.receipt, execute: values.execute, signal: controller.signal })
    console.log(JSON.stringify({ stage: receipt.stage, version: receipt.version, sourceCommit: receipt.sourceCommit,
      binaries: receipt.binaries.length, feeds: receipt.feeds.length }))
  } catch (error) {
    console.error(JSON.stringify({ stage: 'failed', code: error instanceof CapabilityError ? error.code : 'execution-failed-no-retry' })); process.exitCode = 1
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop) }
}
