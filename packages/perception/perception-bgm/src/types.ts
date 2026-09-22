/** Public catalogue entries after validation; filenames never choose local paths. */
export interface CatalogTrack {
  id: string
  name: string
  sha256: string
  bytes: number
  url: string
  valence: number
  arousal: number
  moods: string[]
}

/** Resolved deployment settings for bounded public-library access. */
export interface CatalogConfig {
  catalogUrl: string
  cacheDir: string
  networkTimeoutMs: number
  maxCatalogBytes: number
  maxTrackBytes: number
}
