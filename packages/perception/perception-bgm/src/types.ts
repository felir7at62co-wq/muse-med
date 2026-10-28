import type { LicenseInfo } from '@deepseek-ai/dsh-bgm-license-info'
import type { AudioProfile } from './audio-profile.ts'

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
  audio_profile?: AudioProfile
  license_info: LicenseInfo
  license_warnings: string[]
}

/** Resolved deployment settings for bounded public-library access. */
export interface CatalogConfig {
  catalogUrl: string
  cacheDir: string
  networkTimeoutMs: number
  maxCatalogBytes: number
  maxTrackBytes: number
}
