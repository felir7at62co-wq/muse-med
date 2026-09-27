/**
 * One bad response has to be described the same way whichever layer refuses it.
 *
 * The transport refuses a body it cannot read as an envelope; a reader refuses a
 * payload it cannot read fields from. Both now reject through the summary in
 * `@deepseek-ai/dsh-jubian`, so these cases assert the two layers agree: the
 * structure that arrived, the envelope code against the accepted set, and the one
 * switch that captures the whole response. A credential a body carried is never
 * among it, and the summary describes a malformed value instead of throwing.
 */

import { describe, expect, it } from 'vitest'
import { DEBUG_DUMP_ENV, JubianClient, describeBodyRejection, describeRejection } from '@deepseek-ai/dsh-jubian'
import { readAssetList } from '../src/asset.ts'
import { readModels } from '../src/catalog.ts'

/** The token every stub transport answers with; it never leaves the test. */
const TOKEN = 'stub-token'

/** One credential and one signed URL a rejected body carries, neither of which may be echoed. */
const ACCESS_TOKEN = 'sk-live-5f3a91d2c4b7'
const SIGNED_URL = 'https://cdn.example.test/a.png?X-Signature=deadbeefdeadbeefdeadbeef'

/** The one bad response both layers are handed: the raw body, and the payload a reader sees in it. */
const BAD_BODY = { code: 500, msg: '剧本不存在', accessToken: ACCESS_TOKEN, url: SIGNED_URL, rows: 'not an array' }

/**
 * Send one body through the real transport and return the message it rejected with.
 * @param body - The value the stub transport answers with.
 * @returns The rejection message the client produced.
 */
async function transportMessage(body: unknown): Promise<string> {
  const client = new JubianClient({ credential: async () => TOKEN,
    fetch: async () => new Response(JSON.stringify(body), { status: 200 }) })
  try {
    await client.request({ method: 'GET', path: '/aigc/asset/list' })
  } catch (error) { return (error as Error).message }
  throw new Error('the transport accepted a body it should have refused')
}

/**
 * Read one payload through a real reader and return the message it rejected with.
 * @param read - The reader to call.
 * @returns The rejection message the reader produced.
 */
function readerMessage(read: () => unknown): string {
  try { read() } catch (error) { return (error as Error).message }
  throw new Error('the reader accepted a payload it should have refused')
}

describe('one bad response, described the same by both layers', () => {
  it('names the structure, the code against the accepted set and the capture switch', async () => {
    // One bad response: the transport reads it as the raw body, while a reader is
    // handed the same object as the payload it was supposed to use.
    const fromTransport = await transportMessage(BAD_BODY)
    const fromReader = readerMessage(() => readAssetList(BAD_BODY))

    for (const message of [fromTransport, fromReader]) {
      expect(message).toContain('Jubian response did not match the expected envelope')
      expect(message).toContain('[code, msg, accessToken, url, rows]')
      expect(message).toContain('code=500')
      expect(message).toContain('accepted envelope codes: 0 / 200')
      expect(message).toContain(DEBUG_DUMP_ENV)
    }
    // The reader names itself, so one message says which endpoint read failed.
    expect(fromReader).toContain('readAssetList')
  })

  it('never reproduces a credential or a signed URL the body carried', async () => {
    const fromTransport = await transportMessage(BAD_BODY)
    const fromReader = readerMessage(() => readAssetList(BAD_BODY))

    for (const message of [fromTransport, fromReader]) {
      expect(message).not.toContain(ACCESS_TOKEN)
      expect(message).not.toContain('X-Signature')
      expect(message).toContain('[redacted]')
    }
  })

  it('compares the code of a body that carries no readable envelope', async () => {
    // A body with no integer code is still described: what arrived, and that the
    // accepted set is not what came.
    const message = await transportMessage({ message: 'ok', result: [] })
    expect(message).toContain('code=none, not an integer')
    expect(message).toContain(DEBUG_DUMP_ENV)
  })

  it('describes a malformed payload instead of throwing while reporting a failure', () => {
    // The summary runs on whatever a reader was handed, including values that are
    // not the payload it wanted, so reporting a failure never becomes a second one.
    for (const value of [null, undefined, [], [1, 2, 3], 'a string', 42, true, { code: 'not a number' }]) {
      const described = describeRejection(value)
      expect(described).toContain(DEBUG_DUMP_ENV)
      expect(described.length).toBeGreaterThan(DEBUG_DUMP_ENV.length)
    }
    // A body that never decoded is described from its bytes.
    expect(describeBodyRejection(null, new Uint8Array([0xff, 0xfe]))).toContain(DEBUG_DUMP_ENV)
  })

  it('keeps describing an array payload a reader refused', () => {
    const message = readerMessage(() => readModels([1, 2, 3]))
    expect(message).toContain('top-level array of 3 elements')
    expect(message).toContain(DEBUG_DUMP_ENV)
  })
})
