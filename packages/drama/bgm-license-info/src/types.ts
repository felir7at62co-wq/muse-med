/** Music-rights declarations carried independently of matching-model licenses. */

/** Intended release purpose; unknown does not imply non-commercial use. */
export type BgmUsage = 'commercial' | 'non_commercial' | 'unknown'

/** Normalized source declaration; declared is not a verification of legal rights. */
export interface LicenseInfo {
  /** Completeness of the supplied declaration, never an approval status. */
  readonly status: 'declared' | 'unknown'
  /** License name or identifier, or unknown when absent. */
  readonly license: string
  /** Explicit source statement, never inferred from a license name or mood. */
  readonly commercial_use: boolean | 'unknown'
  /** Rights document or source reference, distinct from an audio file path. */
  readonly source: string
  /** Required credit text; an explicit no-credit statement is preserved. */
  readonly attribution: string
  /** Declared usage scope, preserved without interpreting free-form restrictions. */
  readonly scope: string
}

/** Track identity and its caller-supplied rights declaration. */
export interface BgmLicenseRecord {
  /** Display name of the planned track. */
  readonly track: string
  /** Audio source path, independent of license_info.source. */
  readonly source: string
  /** Catalog content identity when supplied. */
  readonly track_id?: string
  /** Source digest when supplied or measured by the composer. */
  readonly source_sha256?: string
  /** Normalized rights declaration. */
  readonly license_info: LicenseInfo
  /** Unknown-data and use-mismatch findings; no automatic approval. */
  readonly warnings: string[]
}
