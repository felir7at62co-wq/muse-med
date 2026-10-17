/** Deployment-owned object access seam for the character library. */
import { Context, Service } from '@deepseek-ai/cordis'

import type { CharacterLibraryObjectGet, CharacterLibraryObjectHead, CharacterLibraryObjectListPage, CharacterLibraryObjectListRequest, CharacterLibraryObjectStoreStatus } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Deployment-specific character-library object access. */
    characterLibraryObjectStore: CharacterLibraryObjectStore
  }
}

/**
 * Least-capability object store. It deliberately has no delete, copy, ACL,
 * policy or presigned-URL operation.
 */
export abstract class CharacterLibraryObjectStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'characterLibraryObjectStore')
  }

  /**
   * Report deployment readiness without constructing an SDK client or doing network IO.
   * @returns The provider's read and write readiness flags.
   */
  abstract status(): CharacterLibraryObjectStoreStatus

  /**
   * List one bounded page below a fixed reviewed prefix.
   * @param request - Prefix, cursor, and page bound.
   * @param signal - Optional cancellation signal.
   * @returns A page of object descriptors and continuation cursor.
   */
  abstract list(
    request: CharacterLibraryObjectListRequest,
    signal?: AbortSignal,
  ): Promise<CharacterLibraryObjectListPage>

  /**
   * Read metadata without fetching the object body.
   * @param key - Object key to inspect.
   * @param signal - Optional cancellation signal.
   * @returns Object metadata, or null when absent.
   */
  abstract head(key: string, signal?: AbortSignal): Promise<CharacterLibraryObjectHead | null>

  /**
   * Read at most maxBytes into memory; providers enforce the bound before or during transfer.
   * @param key - Object key to read.
   * @param maxBytes - Maximum accepted object body length.
   * @param signal - Optional cancellation signal.
   * @returns The bounded object body and provider metadata.
   */
  abstract get(key: string, maxBytes: number, signal?: AbortSignal): Promise<CharacterLibraryObjectGet>
}
