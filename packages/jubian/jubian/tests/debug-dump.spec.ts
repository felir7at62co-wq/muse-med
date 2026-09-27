import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEBUG_DUMP_ENV, JubianClient } from '../src/index.ts'
import type { JubianDebugRecord } from '../src/index.ts'

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'

let root: string
let dumpPath: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jubian-dump-'))
  // The directory does not exist yet: the dump owns creating it.
  dumpPath = join(root, 'probe', 'responses.jsonl')
  delete process.env.DSH_JUBIAN_DEBUG_DUMP
})

afterEach(async () => {
  delete process.env.DSH_JUBIAN_DEBUG_DUMP
  await rm(root, { recursive: true, force: true })
})

function client(fetchImpl: typeof fetch): JubianClient {
  return new JubianClient({ credential: async () => TOKEN, fetch: fetchImpl })
}

/** Every record the dump appended, in order. */
async function records(): Promise<JubianDebugRecord[]> {
  const text = await readFile(dumpPath, 'utf8')
  return text.trim().split('\n').map(line => JSON.parse(line) as JubianDebugRecord)
}

describe('DSH_JUBIAN_DEBUG_DUMP', () => {
  it('writes nothing while the switch is off', async () => {
    await client(async () => new Response(JSON.stringify({ code: 200, data: { id: 1 } })))
      .request({ method: 'GET', path: '/one' })
    await expect(readFile(dumpPath, 'utf8')).rejects.toThrow()
  })

  it('appends one redacted record per response, including one nothing could read', async () => {
    process.env[DEBUG_DUMP_ENV] = dumpPath
    const body = { code: 200, msg: '操作成功', data: { id: 1646907, accessToken: TOKEN,
      videoUrl: `https://cdn.example.com/a/b.mp4?X-Amz-Signature=${TOKEN}` } }
    let call = 0
    const subject = client(async () => {
      call += 1
      return call === 1 ? new Response(JSON.stringify(body))
        : new Response(JSON.stringify({ code: 'nope', msg: TOKEN, rows: [] }))
    })
    await subject.request({ method: 'GET', path: '/aigc/storyboard/1646907' })
    await expect(subject.request({ method: 'GET', path: '/aigc/storyboard/list' }))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })

    const lines = await records()
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ method: 'GET', path: '/aigc/storyboard/1646907', http_status: 200,
      application_code: 200, envelope_layout: 'object-data', bytes: Buffer.byteLength(JSON.stringify(body)) })
    expect(lines[1]).toMatchObject({ path: '/aigc/storyboard/list', envelope_layout: 'object-no-code',
      application_code: null })
    const written = await readFile(dumpPath, 'utf8')
    expect(written).not.toContain(TOKEN)
    const first = lines[0]?.body as { data: Record<string, unknown> }
    expect(first.data.accessToken).toBe('[redacted]')
    expect(first.data.videoUrl).toBe('https://cdn.example.com/…')
    const second = lines[1]?.body as Record<string, unknown>
    expect(second.msg).toBe('[redacted]')
    expect(typeof lines[0]?.at).toBe('string')
    expect(lines[0]?.response_sha256).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it('records a body that never parsed as the same bounded excerpt the error carries', async () => {
    process.env[DEBUG_DUMP_ENV] = dumpPath
    await expect(client(async () => new Response(`gateway said no: ${TOKEN}`))
      .request({ method: 'GET', path: '/one' })).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    const lines = await records()
    expect(lines).toHaveLength(1)
    expect(lines[0]?.envelope_layout).toBe('unparsed')
    expect(String(lines[0]?.body)).toContain('body is not JSON')
    expect(await readFile(dumpPath, 'utf8')).not.toContain(TOKEN)
  })

  it.skipIf(process.platform === 'win32')('creates the file with owner-only permissions', async () => {
    process.env[DEBUG_DUMP_ENV] = dumpPath
    await client(async () => new Response(JSON.stringify({ code: 200, data: 1 })))
      .request({ method: 'GET', path: '/one' })
    expect((await stat(dumpPath)).mode & 0o777).toBe(0o600)
  })
})
