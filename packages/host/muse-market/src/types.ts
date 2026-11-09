/** Skill publication metadata shared by local storage and its consumers. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'

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

/** Stable candidate facts retained with an exact Session publication selection. */
export interface MuseMarketBindingEntry {
  readonly release: MarketRelease
  readonly skill: {
    readonly name: string
    readonly description: string
    readonly whenToUse?: string
    readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  }
}

/** Complete default selection after an atomic activation update. */
export interface MuseMarketDefaults {
  readonly revision: number
  readonly defaults: readonly { readonly skillName: string; readonly releaseId: MarketReleaseId }[]
}

/** Explicit compare-and-set request; null selects no default for this Skill. */
export interface MuseMarketDefaultInput {
  readonly skillName: string
  readonly expected: MarketReleaseId | null
  readonly target: MarketReleaseId | null
}

/** Session-addressed release-set observation. */
export interface MuseMarketBindingRequest { readonly sessionId: SessionId }

/** A bound set never follows subsequent global default updates. */
export interface MuseMarketBindingView {
  readonly phase: 'blank' | 'bound' | 'legacy'
  readonly releases: readonly MuseMarketBindingEntry[]
}

/** Log-derived release set and whether a model request has been recorded. */
export interface MuseMarketBindingState {
  readonly bound: boolean
  readonly requested: boolean
  readonly releases: readonly MuseMarketBindingEntry[]
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Refuse removal of a publication retained by an activation consumer.
     * @mode serial
     * @param releaseId - Exact local archive identity being removed.
     */
    'muse-market/before-remove'(releaseId: MarketReleaseId): Promise<void>
    /** Default publication choices committed; consumers refetch their own Session views.
     * @mode emit
     */
    'muse-market/defaults-changed'(): void
  }
}
