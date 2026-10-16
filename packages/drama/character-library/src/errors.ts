/** Stable, non-secret failures for the character library capability. */

export type CharacterLibraryStoreErrorCode =
  | 'UNAVAILABLE'
  | 'NOT_FOUND'
  | 'OBJECT_TOO_LARGE'
  | 'PRECONDITION_FAILED'
  | 'INVALID_RESPONSE'
  | 'READ_FAILED'

/** Provider failure without SDK responses, credentials, URLs or object bodies. */
export class CharacterLibraryStoreError extends Error {
  constructor(readonly code: CharacterLibraryStoreErrorCode) {
    super(code)
    this.name = 'CharacterLibraryStoreError'
  }
}

/** Stable domain error codes safe to expose without provider details. */
export type CharacterLibraryErrorCode =
  | 'INVALID_REQUEST'
  | 'UNCONFIGURED'
  | 'LIST_FAILED'
  | 'LIST_BOUND_EXCEEDED'
  | 'CATALOG_REJECTED'
  | 'ASSET_NOT_FOUND'
  | 'PREVIEW_UNAVAILABLE'
  | 'IMAGE_INVALID'
  | 'IMAGE_MISMATCH'

/** Public operation stage attached to a domain failure. */
export type CharacterLibraryFailureStage =
  | 'browse'
  | 'detail'
  | 'preview'
  | 'recommend'

/** Domain failure with a stable code and stage, never a raw provider error. */
export class CharacterLibraryError extends Error {
  constructor(
    readonly code: CharacterLibraryErrorCode,
    readonly stage: CharacterLibraryFailureStage,
  ) {
    super(code)
    this.name = 'CharacterLibraryError'
  }
}
