import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { storyboardMethod } from '../src/methods.ts'

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'

/** One saved storyboard as the provider holds it, readable by `readStoryboard`. */
const BOARD = {
  id: 1646907,
  scriptId: 2708,
  episodeId: 25,
  isGenerate: 1,
  storyboardName: 'EP25-P3:镜21-33-r2',
  modelConfig: JSON.stringify({ ratio: '9:16', resolution: '720p', genNum: 1, duration: 6, modelId: 'sd2.5' }),
  storyboardMaterialList: [{ materialKey: 'official-a', assetId: '125204' }],
}

let root: string
let ledger: JubianLedger

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jubian-envelope-'))
  ledger = new JubianLedger({ root: join(root, 'ledger') })
})

afterEach(async () => { await rm(root, { recursive: true, force: true }) })

/** The first call's result, over a transport that always answers the same bytes. */
function clientAnswering(body: string): JubianClient {
  return new JubianClient({ credential: async () => TOKEN,
    fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }) })
}

describe('jubian_storyboard get over the layouts the transport accepts', () => {
  it('reads the documented envelope', async () => {
    const result = await storyboardMethod(clientAnswering(JSON.stringify({ code: 200, msg: '操作成功', data: BOARD })),
      ledger, { method: 'get', storyboard_id: 1646907 })
    const storyboard = result.storyboard as { storyboard_id: number; material_keys: string[] }
    expect(storyboard.storyboard_id).toBe(1646907)
    expect(storyboard.material_keys).toEqual(['official-a'])
  })

  it('reads a payload the remote wrapped in a one-element array', async () => {
    const result = await storyboardMethod(clientAnswering(JSON.stringify([BOARD])), ledger,
      { method: 'get', storyboard_id: 1646907 })
    expect((result.storyboard as { storyboard_id: number }).storyboard_id).toBe(1646907)
  })

  it('reads a payload the remote wrapped in a second envelope', async () => {
    const result = await storyboardMethod(clientAnswering(JSON.stringify({ code: 200, data: { code: 0, data: BOARD } })),
      ledger, { method: 'get', storyboard_id: 1646907 })
    expect((result.storyboard as { storyboard_id: number }).storyboard_id).toBe(1646907)
  })

  it('reports the structure of a body that is not JSON and none of its values', async () => {
    const thrown = await storyboardMethod(clientAnswering(`gateway said no: ${TOKEN}`), ledger,
      { method: 'get', storyboard_id: 1646907 }).catch((error: unknown) => error)
    const message = (thrown as Error).message
    expect(message).toContain('Jubian response did not match the expected envelope')
    expect(message).toContain('body is not JSON:')
    expect(message).toContain('excerpt')
    expect(message).not.toContain(TOKEN)
  })

  it('still fails when a tolerated layout holds a payload no reader can use', async () => {
    // Tolerance stops at the transport: a reader that cannot read the payload it
    // received still rejects the call instead of reporting a half-read value.
    await expect(storyboardMethod(clientAnswering(JSON.stringify([{ code: 200, data: { id: 1 } }])), ledger,
      { method: 'get', storyboard_id: 1646907 }))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  })
})
