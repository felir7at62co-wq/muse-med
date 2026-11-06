import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { obtain, type MediaResource } from '../scripts/media-resources.ts'

const bytes = Buffer.from('locked media resource\n')

async function fixture(handler: (request: IncomingMessage, response: ServerResponse, count: number) => void) {
  const root = await mkdtemp(join(tmpdir(), 'media-resource-download-'))
  let requests = 0
  const server = createServer((request, response) => { handler(request, response, ++requests) })
  onTestFinished(async () => {
    if (server.listening) {
      const closed = new Promise<void>((resolve, reject) => server.close((error) => {
        if (error) reject(error)
        else resolve()
      }))
      server.closeAllConnections()
      await closed
    }
    await rm(root, { recursive: true, force: true })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected an assigned loopback port')
  const resource: MediaResource = { filename: 'locked.bin', url: `http://127.0.0.1:${address.port}/download`,
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  return { root, resource, requests: () => requests }
}

it('downloads through Node, verifies the lock and reuses only matching cached bytes', async () => {
  const f = await fixture((_request, response) => response.end(bytes))
  expect(await obtain(f.resource, f.root)).toBe(join(f.root, f.resource.filename))
  expect(await readFile(join(f.root, f.resource.filename))).toEqual(bytes)
  expect(await obtain(f.resource, f.root)).toBe(join(f.root, f.resource.filename))
  expect(f.requests()).toBe(1)
  expect(await readdir(f.root)).toEqual([f.resource.filename])
})

it('recovers a real Node transport failure with system curl and publishes only the complete verified redirect target', async () => {
  const started = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const agents: string[] = []
  const f = await fixture((request, response, count) => {
    if (count === 1) { request.socket.destroy(); return }
    agents.push(request.headers['user-agent'] ?? '')
    if (request.url === '/download') {
      response.writeHead(302, { location: '/payload' }).end()
      return
    }
    response.write(bytes.subarray(0, 2))
    started.resolve(undefined)
    void release.promise.then(() => { response.end(bytes.subarray(2)) })
  })
  const download = obtain(f.resource, f.root)
  try {
    await Promise.race([started.promise, download.then(() => { throw new Error('download completed before its body was released') })])
    const staged = await readdir(f.root)
    expect(staged).toHaveLength(1)
    expect(staged[0]).toMatch(/\.part$/u)
    expect(staged).not.toContain(f.resource.filename)
    release.resolve(undefined)
    expect(await download).toBe(join(f.root, f.resource.filename))
    expect(await readFile(join(f.root, f.resource.filename))).toEqual(bytes)
    expect(await readdir(f.root)).toEqual([f.resource.filename])
    expect(f.requests()).toBe(3)
    expect(agents).toHaveLength(2)
    expect(agents.every(agent => agent.startsWith('curl/'))).toBe(true)
  } finally {
    release.resolve(undefined)
    await Promise.allSettled([download])
  }
})

it('keeps the original HTTP error without invoking curl', async () => {
  const f = await fixture((_request, response) => response.writeHead(503).end('unavailable'))
  await expect(obtain(f.resource, f.root)).rejects.toThrow('HTTP 503')
  expect(f.requests()).toBe(1)
  expect(await readdir(f.root)).toEqual([])
})

it('keeps Node checksum failures terminal and removes its owned partial file', async () => {
  const f = await fixture((_request, response) => response.end(Buffer.alloc(bytes.length)))
  await expect(obtain(f.resource, f.root)).rejects.toThrow('media checksum mismatch')
  expect(f.requests()).toBe(1)
  expect(await readdir(f.root)).toEqual([])
})

it('rejects incorrect curl bytes before publishing the cache', async () => {
  const f = await fixture((request, response, count) => {
    if (count === 1) request.socket.destroy()
    else response.end(Buffer.alloc(bytes.length))
  })
  await expect(obtain(f.resource, f.root)).rejects.toThrow('media checksum mismatch')
  expect(f.requests()).toBe(2)
  expect(await readdir(f.root)).toEqual([])
})

it('removes the curl partial file after a real HTTP failure and waits for that child to exit', async () => {
  const f = await fixture((request, response, count) => {
    if (count === 1) request.socket.destroy()
    else response.writeHead(404).end('missing')
  })
  await expect(obtain(f.resource, f.root)).rejects.toThrow()
  expect(f.requests()).toBe(2)
  expect(await readdir(f.root)).toEqual([])
})

it('bounds curl response bytes even when the response has no Content-Length', async () => {
  const f = await fixture((request, response, count) => {
    if (count === 1) request.socket.destroy()
    else { response.write(bytes); response.end(bytes) }
  })
  await expect(obtain(f.resource, f.root)).rejects.toThrow()
  expect(f.requests()).toBe(2)
  expect(await readdir(f.root)).toEqual([])
})

it('uses a bounded curl retry for a transient response after Node transport recovery', async () => {
  const f = await fixture((request, response, count) => {
    if (count === 1) request.socket.destroy()
    else if (count === 2) response.writeHead(503, { 'retry-after': '0' }).end()
    else response.end(bytes)
  })
  expect(await obtain(f.resource, f.root)).toBe(join(f.root, f.resource.filename))
  expect(await readFile(join(f.root, f.resource.filename))).toEqual(bytes)
  expect(f.requests()).toBe(3)
  expect(await readdir(f.root)).toEqual([f.resource.filename])
})

it('stops after two curl retries and removes the incomplete cache candidate', async () => {
  const f = await fixture((request, response, count) => {
    if (count === 1) request.socket.destroy()
    else response.writeHead(503, { 'retry-after': '0' }).end()
  })
  await expect(obtain(f.resource, f.root)).rejects.toThrow()
  expect(f.requests()).toBe(4)
  expect(await readdir(f.root)).toEqual([])
})

it('rejects a corrupt existing cache without downloading or replacing its contents', async () => {
  const f = await fixture((_request, response) => response.end(bytes))
  const corrupt = Buffer.alloc(bytes.length)
  await writeFile(join(f.root, f.resource.filename), corrupt)
  await expect(obtain(f.resource, f.root)).rejects.toThrow('media checksum mismatch')
  expect(f.requests()).toBe(0)
  expect(await readFile(join(f.root, f.resource.filename))).toEqual(corrupt)
  expect(await readdir(f.root)).toEqual([f.resource.filename])
})

it('does not reinterpret a malformed URL as a recoverable transport failure', async () => {
  const f = await fixture((_request, response) => response.end(bytes))
  await expect(obtain({ ...f.resource, url: 'http://[' }, f.root)).rejects.toThrow('Failed to parse URL')
  expect(f.requests()).toBe(0)
  expect(await readdir(f.root)).toEqual([])
})
