/**
 * The `jubianToken` Remote namespace over the real credential seam: one fixed
 * reference, a one-directional value, and a status answer that never carries
 * the token back.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { JubianToken } from '../src/token.ts'

const REF = credentialRef('JUBIANAI_ADMIN_TOKEN')

/**
 * Boot the service over the in-memory credential provider.
 * @param seed - values the provider starts with, keyed by reference name.
 * @returns the context and a reader for the stored value the seam resolves.
 */
async function boot(seed: Record<string, string> = {}): Promise<{
  ctx: Context
  stored: () => Promise<string | undefined>
}> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials, seed)
  await ctx.plugin(JubianToken)
  return { ctx, stored: async () => (await ctx.credentials.resolve(REF))?.value }
}

describe('the jubianToken Remote namespace', () => {
  it('reports an unconfigured reference without a source', async () => {
    const { ctx } = await boot()
    expect(ctx.jubianToken).toBeDefined()
    await expect(ctx.jubianToken.describe()).resolves.toEqual({ configured: false, writable: true })
  })

  it('reports the configured reference and the source supplying it', async () => {
    const { ctx } = await boot({ JUBIANAI_ADMIN_TOKEN: 'seeded' })
    await expect(ctx.jubianToken.describe()).resolves.toEqual({
      configured: true,
      source: 'memory',
      writable: true,
    })
  })

  it('stores the value under the fixed reference and answers with the post-write status', async () => {
    const { ctx, stored } = await boot()
    await expect(ctx.jubianToken.set('eyJhbGci.payload.sig')).resolves.toEqual({
      configured: true,
      source: 'memory',
      writable: true,
    })
    expect(await stored()).toBe('eyJhbGci.payload.sig')
  })

  it('clears the stored value and reports the reference unconfigured again', async () => {
    const { ctx, stored } = await boot({ JUBIANAI_ADMIN_TOKEN: 'seeded' })
    await expect(ctx.jubianToken.unset()).resolves.toEqual({ configured: false, writable: true })
    expect(await stored()).toBeUndefined()
    // Removing an absent reference is a no-op, not a failure.
    await expect(ctx.jubianToken.unset()).resolves.toEqual({ configured: false, writable: true })
  })

  it('refuses an empty value and names the operation that clears the reference instead', async () => {
    const { ctx, stored } = await boot({ JUBIANAI_ADMIN_TOKEN: 'seeded' })
    for (const empty of ['', '   ']) {
      await expect(ctx.jubianToken.set(empty)).rejects.toMatchObject({ code: 'gateway/bad-request' })
    }
    expect(await stored()).toBe('seeded')
  })

  it('reports a provider refusal with the seam\'s own message and only the reference in the details', async () => {
    const ctx = new Context()
    ctx.provide('credentials', {
      describe: async () => ({ configured: true, source: 'env', writable: false }),
      set: async () => { throw new Error('refusing to write a reference shadowed by the launching environment') },
      unset: async () => { throw 'plain refusal' },
    })
    await ctx.plugin(JubianToken)

    for (const call of [(): Promise<unknown> => ctx.jubianToken.set('next'),
      (): Promise<unknown> => ctx.jubianToken.unset()]) {
      await expect(call()).rejects.toMatchObject({
        code: 'jubian-token/rejected',
        details: { ref: 'JUBIANAI_ADMIN_TOKEN' },
      })
    }
    await expect(ctx.jubianToken.set('next')).rejects.toThrow(
      'refusing to write a reference shadowed by the launching environment')
    await expect(ctx.jubianToken.unset()).rejects.toThrow('plain refusal')
  })

  it('answers with the projected fields even when the provider widens its reply', async () => {
    const ctx = new Context()
    ctx.provide('credentials', {
      describe: async () => ({ configured: true, source: 'env', writable: false, value: 'leaked' }),
      set: async () => {},
      unset: async () => {},
    })
    await ctx.plugin(JubianToken)
    await expect(ctx.jubianToken.describe()).resolves.toEqual({
      configured: true,
      source: 'env',
      writable: false,
    })
  })
})
