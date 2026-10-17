/**
 * Volcengine TOS provider for the reviewed historical character-library reads.
 * Write methods remain fail-closed until upload prefixes, IAM and publication
 * semantics receive a separate review.
 * @module @deepseek-ai/dsh-character-library-tos
 */
import type { Context } from '@deepseek-ai/cordis'
import { CharacterLibraryObjectStore, type CharacterLibraryObjectGet, type CharacterLibraryObjectHead, type CharacterLibraryObjectListPage, type CharacterLibraryObjectListRequest, type CharacterLibraryObjectStoreStatus } from '@deepseek-ai/dsh-character-library'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

import z from '@deepseek-ai/schemastery'
import { TosCharacterLibraryAdapter, loadLockedTosSdk } from './adapter.ts'
import type { CharacterLibraryTosOptions, ResolvedConfig, TosReadCredentials } from './types.ts'

export {
  CHARACTER_LIBRARY_ANCIENT_PREFIX,
  CHARACTER_LIBRARY_TOS_BUCKET,
  CHARACTER_LIBRARY_TOS_ENDPOINT,
  CHARACTER_LIBRARY_TOS_REGION,
  CHARACTER_LIBRARY_URBAN_PREFIX,
} from './adapter.ts'
export type { CharacterLibraryTosOptions as CharacterLibraryTosConfig } from './types.ts'

/** Cordis plugin name. */
export const name = 'character-library-tos'

const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_CONNECTION_TIMEOUT_MS = 30_000
const MAX_REQUEST_TIMEOUT_MS = 60_000

/** Deployment configuration. No read identity is configured by default. */
export interface Config extends CharacterLibraryTosOptions {
  /** Per-request connection timeout in milliseconds. */
  readonly connectionTimeoutMs: number
  /** Per-request total timeout in milliseconds. */
  readonly requestTimeoutMs: number
}

/** Schemastery definition for the read-only TOS identity and bounded timeouts. */
export const Config = z.object({
  readAccessKeyIdRef: z.string().role('credential-ref'),
  readSecretAccessKeyRef: z.string().role('credential-ref'),
  connectionTimeoutMs: z.number().step(1).min(100).max(MAX_CONNECTION_TIMEOUT_MS)
    .default(DEFAULT_CONNECTION_TIMEOUT_MS),
  requestTimeoutMs: z.number().step(1).min(100).max(MAX_REQUEST_TIMEOUT_MS)
    .default(DEFAULT_REQUEST_TIMEOUT_MS),
})

function resolveConfig(config: Config): ResolvedConfig {
  const accessRef = config.readAccessKeyIdRef
  const secretRef = config.readSecretAccessKeyRef
  if ((accessRef === undefined) !== (secretRef === undefined)) {
    throw new TypeError('character-library-tos: both read credential references are required together')
  }
  return {
    readCredentials: accessRef === undefined || secretRef === undefined
      ? null
      : {
        accessKeyIdRef: credentialRef(accessRef),
        secretAccessKeyRef: credentialRef(secretRef),
      },
    connectionTimeoutMs: config.connectionTimeoutMs,
    requestTimeoutMs: config.requestTimeoutMs,
  }
}

/** TOS-backed deployment provider for the character-library object store. */
export class TosCharacterLibraryObjectStore extends CharacterLibraryObjectStore {
  private readonly adapter: TosCharacterLibraryAdapter
  private readonly readConfigured: boolean

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const resolved = resolveConfig(config)
    this.readConfigured = resolved.readCredentials !== null
    this.adapter = new TosCharacterLibraryAdapter(resolved, {
      loadSdk: loadLockedTosSdk,
      resolveReadCredentials: () => this.resolveCredentials(resolved),
    })
  }

  /** Report deployment configuration without resolving secrets or loading the SDK. */
  status(): CharacterLibraryObjectStoreStatus {
    return {
      readConfigured: this.readConfigured,
      writeConfigured: false,
    }
  }

  /** List one bounded page below a reviewed historical prefix. */
  list(
    request: CharacterLibraryObjectListRequest,
    signal?: AbortSignal,
  ): Promise<CharacterLibraryObjectListPage> {
    return this.adapter.list(request, signal)
  }

  /** Read object metadata without fetching its body. */
  head(key: string, signal?: AbortSignal): Promise<CharacterLibraryObjectHead | null> {
    return this.adapter.head(key, signal)
  }

  /** Read one object through a bounded Range request. */
  get(
    key: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<CharacterLibraryObjectGet> {
    return this.adapter.get(key, maxBytes, signal)
  }

  private async resolveCredentials(config: ResolvedConfig): Promise<TosReadCredentials | undefined> {
    const refs = config.readCredentials
    if (refs === null) return undefined
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) return undefined
    const [accessKeyId, secretAccessKey] = await Promise.all([
      credentials.resolve(refs.accessKeyIdRef),
      credentials.resolve(refs.secretAccessKeyRef),
    ])
    if (accessKeyId === undefined || secretAccessKey === undefined) return undefined
    return {
      accessKeyId: accessKeyId.value,
      secretAccessKey: secretAccessKey.value,
    }
  }
}

/**
 * Install the TOS object-store provider.
 * @param ctx - Host Cordis context.
 * @param config - reviewed credential references and timeout limits.
 */
export function apply(ctx: Context, config: Config): void {
  new TosCharacterLibraryObjectStore(ctx, config)
}
