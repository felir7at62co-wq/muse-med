import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream } from 'node:fs'
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    artifacts: { type: 'string' },
    version: { type: 'string' },
    commit: { type: 'string' },
    cert: { type: 'string' },
    key: { type: 'string' },
    host: { type: 'string', default: '127.0.0.1' },
    ready: { type: 'string' },
    evidence: { type: 'string' },
    'old-blockmap': { type: 'string' },
    'old-blockmap-sha256': { type: 'string' },
    'rc-alias': { type: 'boolean', default: false },
  },
})

const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u
const sha256Pattern = /^[\da-f]{64}$/u
const sha512Pattern = /^[A-Za-z0-9+/]{86}==$/u
const startTime = new Date().toISOString()
const prefix = '/feed/'

function required(option) {
  const value = values[option]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Missing --${option}`)
  return value
}

async function digest(path, contents) {
  const file = await lstat(path)
  if (!file.isFile() || file.size === 0) throw new Error(`Expected a nonempty plain file: ${basename(path)}`)
  const sha256 = createHash('sha256')
  const sha512 = createHash('sha512')
  let size = 0
  for await (const bytes of contents ? [contents] : createReadStream(path)) {
    size += bytes.length
    sha256.update(bytes)
    sha512.update(bytes)
  }
  if (size !== file.size) throw new Error(`File changed while checking: ${basename(path)}`)
  return { path, size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64'), contents }
}

async function readArtifact(directory, name, manifest, inMemory = false) {
  const path = join(directory, name)
  const contents = inMemory ? await readFile(path) : undefined
  const actual = await digest(path, contents)
  const expected = manifest.artifacts?.[name]
  if (!expected || expected.size !== actual.size || expected.sha256 !== actual.sha256 || expected.sha512 !== actual.sha512) {
    throw new Error(`Candidate build manifest disagrees with ${name}`)
  }
  return actual
}

async function writeJsonAtomic(destination, value) {
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await rename(temporary, destination)
  } finally {
    await rm(temporary, { force: true })
  }
}

// An ignored or multipart Range receives an ordinary 200 response. Electron may then use its full download path.
function requestedRange(header, size) {
  if (typeof header !== 'string') return
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header)
  if (!match || (!match[1] && !match[2])) return
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix === 0) return null
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(match[1])
  const end = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null
  return { start, end: Math.min(end, size - 1) }
}

async function main() {
  const directory = resolve(required('artifacts'))
  const version = required('version')
  const commit = required('commit')
  if (!stableVersion.test(version) || !/^[\da-f]{40}$/u.test(commit)) throw new Error('Expected a stable version and a full source commit')
  const host = values.host
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('The test feed requires a loopback host')
  const ready = resolve(required('ready'))
  const evidence = values.evidence ? resolve(values.evidence) : undefined
  if (ready === evidence) throw new Error('--ready and --evidence must be different files')
  await lstat(ready).then(() => { throw new Error('The ready file already exists') }, error => {
    if (error.code !== 'ENOENT') throw error
  })

  const installerName = `muse-med-${version}-win-x64.exe`
  const manifest = JSON.parse(await readFile(join(directory, 'unsigned-build.json'), 'utf8'))
  if (manifest.schemaVersion !== 1 || manifest.target !== 'win-x64' || manifest.version !== version || manifest.sourceCommit !== commit) {
    throw new Error('Candidate build manifest has the wrong target, version or source commit')
  }
  const [installer, blockmap, feed] = await Promise.all([
    readArtifact(directory, installerName, manifest),
    readArtifact(directory, `${installerName}.blockmap`, manifest),
    readArtifact(directory, 'latest.yml', manifest, true),
  ])
  const { parse } = createRequire(resolve('package.json'))('yaml')
  const metadata = parse(feed.contents.toString('utf8'))
  const descriptor = metadata?.files?.[0]
  if (metadata?.version !== version || metadata.path !== installerName || metadata.sha512 !== installer.sha512
      || !Array.isArray(metadata.files) || metadata.files.length !== 1 || descriptor?.url !== installerName
      || descriptor.size !== installer.size || descriptor.sha512 !== installer.sha512 || !sha512Pattern.test(descriptor.sha512)) {
    throw new Error('latest.yml does not describe the exact Windows executable')
  }

  const routes = new Map([
    ['latest.yml', feed],
    [installerName, installer],
    [`${installerName}.blockmap`, blockmap],
  ])
  if (values['rc-alias']) routes.set('rc.yml', feed)
  const oldBlockmapPath = values['old-blockmap']
  const oldBlockmapSha = values['old-blockmap-sha256']
  if (oldBlockmapPath || oldBlockmapSha) {
    const name = oldBlockmapPath && basename(oldBlockmapPath)
    const oldVersion = name && /^muse-med-([\d.]+)-win-x64\.exe\.blockmap$/u.exec(name)?.[1]
    if (!oldVersion || !stableVersion.test(oldVersion) || oldVersion === version || !sha256Pattern.test(oldBlockmapSha ?? '')) {
      throw new Error('The optional old blockmap must have its exact Windows name and a trusted SHA-256')
    }
    const oldBlockmap = await digest(resolve(oldBlockmapPath))
    if (oldBlockmap.sha256 !== oldBlockmapSha) throw new Error('Old Windows blockmap hash differs from the trusted hash')
    routes.set(name, oldBlockmap)
  }

  const [cert, key] = await Promise.all([readFile(required('cert')), readFile(required('key'))])
  const certificate = new X509Certificate(cert)
  if (!(host === 'localhost' ? certificate.checkHost(host) : certificate.checkIP(host))) {
    throw new Error('Certificate identity does not match the loopback host')
  }
  const requests = []
  let evidenceWrites = Promise.resolve()
  function record(response, method, name, requestedBytes) {
    if (!evidence) return
    response.once('close', () => {
      requests.push({ time: new Date().toISOString(), method, file: name, status: response.statusCode,
        bytes: requestedBytes, completed: response.writableFinished })
      evidenceWrites = evidenceWrites.then(() => writeJsonAtomic(evidence, { startTime, requests })).catch(error => {
        process.stderr.write(`HTTPS fixture evidence could not be recorded: ${error.code ?? 'unknown'}\n`)
        process.exitCode = 1
      })
    })
  }

  const server = createServer({ cert, key, minVersion: 'TLSv1.2' }, (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD', 'content-length': '0' }).end()
      return
    }
    const requestPath = request.url?.split('?')[0]
    const name = requestPath?.startsWith(prefix) ? requestPath.slice(prefix.length) : undefined
    const artifact = routes.get(name)
    if (!artifact) {
      record(response, request.method, null, 0)
      response.writeHead(404, { 'content-length': '0' }).end()
      return
    }
    const range = request.method === 'GET' ? requestedRange(request.headers.range, artifact.size) : undefined
    if (range === null) {
      record(response, request.method, name, 0)
      response.writeHead(416, { 'content-range': `bytes */${artifact.size}`, 'content-length': '0' }).end()
      return
    }
    const start = range?.start ?? 0
    const end = range?.end ?? artifact.size - 1
    const length = end - start + 1
    const headers = {
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'content-length': String(length),
      'content-type': artifact.contents ? 'text/yaml; charset=utf-8' : 'application/octet-stream',
      ...(range && { 'content-range': `bytes ${start}-${end}/${artifact.size}` }),
    }
    record(response, request.method, name, request.method === 'GET' ? length : 0)
    response.writeHead(range ? 206 : 200, headers)
    if (request.method === 'HEAD') response.end()
    else if (artifact.contents) response.end(artifact.contents.subarray(start, end + 1))
    else void pipeline(createReadStream(artifact.path, { start, end }), response).catch(() => response.destroy())
  })
  if (evidence) await writeJsonAtomic(evidence, { startTime, requests })
  const listening = once(server, 'listening')
  server.listen(0, host)
  try {
    await listening
    const { port } = server.address()
    const artifacts = Object.fromEntries([...routes].map(([name, item]) =>
      [name, { size: item.size, sha256: item.sha256, sha512: item.sha512 }]))
    await writeJsonAtomic(ready, {
      feedUrl: `https://${host}:${port}${prefix}`, port, version, commit, startTime,
      certificateSha256: certificate.fingerprint256, artifacts,
    })
  } catch (error) {
    server.close()
    throw error
  }
}

try {
  await main()
} catch (error) {
  process.stderr.write(`HTTPS fixture: ${error.message}\n`)
  process.exitCode = 1
}
