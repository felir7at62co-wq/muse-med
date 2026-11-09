/** Skill publication metadata shared by local storage and its consumers. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** SHA-256 identity of one immutable publication archive. */
export type MarketReleaseId = Branded<'MarketReleaseId'>

/** Author-supplied publication information, without executable plugin rows. */
export interface MarketMetadata {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly version: string
  readonly license: string
  readonly category: string
  readonly examples: readonly string[]
  readonly requirements: readonly string[]
}

/** Versioned Skill-only archive manifest. */
export interface MarketManifest extends MarketMetadata {
  readonly formatVersion: 1
  readonly kind: 'skill'
  readonly skills: readonly { readonly name: string; readonly path: string }[]
}

/** Exact publication bytes and the metadata decoded from them. */
export interface MarketRelease {
  readonly id: MarketReleaseId
  readonly sha256: string
  readonly bytes: number
  readonly manifest: MarketManifest
}

/** A locally retained publication; storage does not activate a Skill. */
export interface MuseMarketInstallation {
  readonly release: MarketRelease
  readonly enabled: false
}

/** Deployment-owned bounds for archives, expanded resources and local records. */
export interface MarketLimits {
  /** Maximum compressed ZIP bytes accepted for one publication. */
  readonly archiveBytes: number
  /** Maximum combined expanded bytes, including the publication manifest. */
  readonly expandedBytes: number
  /** Maximum ZIP entry count, including manifest and directory entries. */
  readonly fileCount: number
  /** Maximum bytes in a publication manifest or local installation ledger. */
  readonly recordBytes: number
}
