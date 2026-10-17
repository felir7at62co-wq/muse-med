import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import CredentialProvider, { type ResolvedCredential } from '@deepseek-ai/dsh-credentials'

import { CHARACTER_LIBRARY_ANCIENT_PREFIX } from '../src/adapter.ts'
import { apply, type Config } from '../src/index.ts'

const METADATA_KEY = CHARACTER_LIBRARY_ANCIENT_PREFIX + 'char_3d_0004/metadata.json'

class ScriptedCredentials extends CredentialProvider {
  private calls = 0

  constructor(
    ctx: Context,
    private readonly values: readonly (ResolvedCredential | undefined | Error)[],
    private readonly onResolve?: (call: number) => void,
  ) {
    super(ctx)
  }

  resolve(): Promise<ResolvedCredential | undefined> {
    this.calls += 1
    this.onResolve?.(this.calls)
    const value = this.values[this.calls - 1]
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value)
  }

  describe() { return Promise.resolve({ configured: false, writable: false }) }
  set() { return Promise.resolve() }
  unset() { return Promise.resolve() }
  readRecord() { return Promise.resolve(undefined) }
  describeRecord() { return Promise.resolve({ configured: false, writable: false }) }
  listRecords() { return Promise.resolve([]) }
  modifyRecord() { return Promise.resolve(undefined) }
  deleteRecord() { return Promise.resolve() }
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    connectionTimeoutMs: 1_000,
    requestTimeoutMs: 2_000,
    ...overrides,
  }
}

describe('character-library-tos plugin', () => {
  it('mounts unconfigured without resolving a secret or constructing the SDK', async () => {
    const ctx = new Context()
    apply(ctx, config())

    expect(ctx.characterLibraryObjectStore.status()).toEqual({
      readConfigured: false,
      writeConfigured: false,
    })
    await expect(ctx.characterLibraryObjectStore.list({
      prefix: CHARACTER_LIBRARY_ANCIENT_PREFIX,
      limit: 1,
    })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await expect(ctx.characterLibraryObjectStore.head(METADATA_KEY))
      .rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await expect(ctx.characterLibraryObjectStore.get(METADATA_KEY, 1))
      .rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('reports read references without claiming write readiness', async () => {
    const ctx = new Context()
    apply(ctx, config({
      readAccessKeyIdRef: 'MUSE_CHARACTER_TOS_READ_ACCESS_KEY_ID',
      readSecretAccessKeyRef: 'MUSE_CHARACTER_TOS_READ_SECRET_ACCESS_KEY',
    }))

    expect(ctx.characterLibraryObjectStore.status()).toEqual({
      readConfigured: true,
      writeConfigured: false,
    })
  })

  it('rejects a partial credential-reference pair at plugin load', () => {
    const ctx = new Context()

    expect(() => {
      apply(ctx, config({
        readAccessKeyIdRef: 'MUSE_CHARACTER_TOS_READ_ACCESS_KEY_ID',
      }))
    }).toThrow(/both read credential references/)

    expect(() => {
      apply(new Context(), config({
        readSecretAccessKeyRef: 'MUSE_CHARACTER_TOS_READ_SECRET_ACCESS_KEY',
      }))
    }).toThrow(/both read credential references/)
  })

  it('fails closed when a configured deployment has no credential provider', async () => {
    const ctx = new Context()
    apply(ctx, config({
      readAccessKeyIdRef: 'MUSE_CHARACTER_TOS_READ_ACCESS_KEY_ID',
      readSecretAccessKeyRef: 'MUSE_CHARACTER_TOS_READ_SECRET_ACCESS_KEY',
    }))

    await expect(ctx.characterLibraryObjectStore.head(METADATA_KEY))
      .rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it.each([
    { values: [{ value: 'test-access-key', source: 'test' }, undefined] },
    { values: [undefined, { value: 'test-secret-key', source: 'test' }] },
    {
      values: [
        new Error('credential-provider-secret'),
        { value: 'test-secret-key', source: 'test' },
      ],
    },
  ] satisfies ReadonlyArray<{
    readonly values: readonly (ResolvedCredential | undefined | Error)[]
  }>) (
    'fails closed when either configured credential cannot resolve: %#',
    async ({ values }) => {
      const ctx = new Context()
      new ScriptedCredentials(ctx, values)
      apply(ctx, config({
        readAccessKeyIdRef: 'MUSE_CHARACTER_TOS_READ_ACCESS_KEY_ID',
        readSecretAccessKeyRef: 'MUSE_CHARACTER_TOS_READ_SECRET_ACCESS_KEY',
      }))

      await expect(ctx.characterLibraryObjectStore.head(METADATA_KEY))
        .rejects.toMatchObject({ code: 'UNAVAILABLE' })
    },
  )

  it('returns both resolved secrets to the adapter without retaining or using them after abort', async () => {
    const ctx = new Context()
    const controller = new AbortController()
    new ScriptedCredentials(ctx, [
      { value: 'test-access-key', source: 'test' },
      { value: 'test-secret-key', source: 'test' },
    ], (call) => {
      if (call === 2) controller.abort()
    })
    apply(ctx, config({
      readAccessKeyIdRef: 'MUSE_CHARACTER_TOS_READ_ACCESS_KEY_ID',
      readSecretAccessKeyRef: 'MUSE_CHARACTER_TOS_READ_SECRET_ACCESS_KEY',
    }))

    await expect(ctx.characterLibraryObjectStore.head(METADATA_KEY, controller.signal))
      .rejects.toMatchObject({ code: 'READ_FAILED' })
  })
})
