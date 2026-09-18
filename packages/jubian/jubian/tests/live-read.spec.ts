/**
 * One real, read-only call against the live provider.
 *
 * It proves two things the offline suite cannot: that the stored credential
 * authenticates, and that the envelope shape this package assumes is the shape
 * the provider actually sends. It is skipped unless the operator opts in,
 * because the default suite must never touch the network.
 *
 * The token is read straight from the credential document so this check does
 * not depend on the credentials service being mounted.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { JUBIAN_TOKEN_REF, JubianClient } from '../src/index.ts'

const enabled = process.env.DSH_JUBIAN_LIVE === '1'

/**
 * Read one credential value from the harness document without the credentials service.
 *
 * The document is real YAML with its own quoting rules, so it is parsed rather
 * than pattern-matched: a token containing a quote or a hash would otherwise be
 * read short and the check would fail for the wrong reason.
 */
async function storedToken(): Promise<string> {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const document = yaml.load(await readFile(join(home, '.credentials.yaml'), 'utf8')) as
    { refs?: Record<string, unknown> } | undefined
  const value = document?.refs?.[JUBIAN_TOKEN_REF]
  if (typeof value !== 'string' || !value) throw new Error(`${JUBIAN_TOKEN_REF} is absent from the credential document`)
  return value
}

describe.skipIf(!enabled)('live read-only call', () => {
  it('reads the image model catalogue', async () => {
    const client = new JubianClient({ credential: storedToken })
    const result = await client.request({ method: 'GET', path: '/model/charge/getSelectList?taskType=2' })
    expect(result.transport.http_status).toBe(200)
    expect(Array.isArray(result.data)).toBe(true)
    const rows = result.data as Record<string, unknown>[]
    expect(rows.some(row => row.modelId === 'gpt-image-2')).toBe(true)
  }, 30000)
})
