/** Browser-safe projections of the read-only character reference library. */
import type { CharacterLibraryErrorCode, CharacterLibraryPreview } from '@deepseek-ai/dsh-character-library/types'
export type {
  CharacterLibraryBrowseRequest,
  CharacterLibraryBrowseResult,
  CharacterLibraryEntry,
  CharacterLibraryPreviewRequest,
  CharacterLibraryStatus,
} from '@deepseek-ai/dsh-character-library/types'

/** Verified image encoded for a browser without exposing a storage URL. */
export interface CharacterLibraryImage {
  readonly catalogAssetId: CharacterLibraryPreview['catalogAssetId']
  readonly dataUrl: string
  readonly sha256: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Stable domain failure from a read-only character library operation. */
    'character-library/read-failed': { readonly code: CharacterLibraryErrorCode }
  }
}
