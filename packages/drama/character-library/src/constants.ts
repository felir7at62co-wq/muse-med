/** Fixed boundaries owned by the character-library domain. */
import type { CharacterLibraryCollection, CharacterLibraryPrefix } from './types.ts'

/** Fixed catalog source identity for the reviewed character reference tree. */
export const CHARACTER_LIBRARY_SOURCE_ID = 'muse-character-reference-qa'
/** Reviewed read prefix for ancient character references. */
export const ANCIENT_PREFIX: CharacterLibraryPrefix =
  'assets/reference/characters/stylized/ancient/ancient/'
/** Reviewed read prefix for urban character references. */
export const URBAN_PREFIX: CharacterLibraryPrefix =
  'assets/reference/characters/stylized/urban/urban/'
/** Both reviewed read prefixes in scan order. */
export const CHARACTER_LIBRARY_PREFIXES = [ANCIENT_PREFIX, URBAN_PREFIX] as const

/** Maximum objects requested per store list page. */
export const MAX_LIST_PAGE_SIZE = 100
/** Maximum list pages scanned for each prefix. */
export const MAX_LIST_PAGES_PER_PREFIX = 4
/** Maximum bytes accepted for one metadata object. */
export const MAX_METADATA_BYTES = 256 * 1024
/** Default image preview byte bound. */
export const DEFAULT_PREVIEW_BYTES = 5 * 1024 * 1024
/** Maximum caller-selected image preview byte bound. */
export const MAX_PREVIEW_BYTES = 10 * 1024 * 1024
/** Maximum verified images returned by one Agent-oriented match. */
export const MAX_MATCH_CANDIDATES = 3
/** Maximum entries returned in one browse result. */
export const MAX_BROWSE_LIMIT = 50

/**
 * Resolve the reviewed read prefix for a collection.
 * @param collection - Ancient or urban collection.
 * @returns Its fixed read prefix.
 */
export function prefixFor(collection: CharacterLibraryCollection): CharacterLibraryPrefix {
  return collection === 'ancient' ? ANCIENT_PREFIX : URBAN_PREFIX
}

/**
 * Resolve a collection from its reviewed read prefix.
 * @param prefix - One of the two fixed read prefixes.
 * @returns Its ancient or urban collection.
 */
export function collectionFor(prefix: CharacterLibraryPrefix): CharacterLibraryCollection {
  return prefix === ANCIENT_PREFIX ? 'ancient' : 'urban'
}
