/** Internal Phase2 browser display types; no catalog metadata is decoded here. */

/** Phase2 temporary display DTO, not TOS contract: the three browser categories. */
export type LibraryCategory = 'urban' | 'ancient' | 'unknown'

/** Phase2 temporary display DTO, not TOS contract: a displayed review state. */
export type LibraryApprovalStatus = 'pending_review' | 'approved' | 'rejected' | 'unknown'

/** Phase2 temporary display DTO, not TOS contract: one simplified metadata row. */
export interface LibraryMetadataField {
  readonly label: string
  readonly value: string
}

/**
 * Phase2 temporary display DTO, not TOS contract.
 * displayId is a browser label, never a project character, supplier asset, or binding identity.
 * Providers own metadata conversion and preview bytes; these fields confer no reuse permission.
 */
export interface LibraryDisplayItem {
  readonly displayId: string
  readonly name: string
  readonly category: LibraryCategory
  readonly gender?: string
  readonly style?: string
  readonly tags: readonly string[]
  readonly appearanceTags: readonly string[]
  readonly sourceDescription?: string
  readonly description?: string
  readonly approvalStatus: LibraryApprovalStatus
  readonly metadataSummary: readonly LibraryMetadataField[]
  readonly thumbnailSrc?: string
  readonly previewSrc?: string
}

/** Viewing capability shared by every item, including items displayed as approved. */
export interface LibraryReadOnlyCapability {
  readonly kind: 'no_bind'
}

/** Phase2 temporary display DTO, not TOS contract: a completed browser load. */
export type LibraryBrowserResult =
  | { readonly kind: 'unconfigured' }
  | {
    readonly kind: 'ready'
    readonly items: readonly LibraryDisplayItem[]
    readonly origin: 'fixture' | 'catalog'
  }

/** Same-process source of display data; external decoding belongs to a future catalog adapter. */
export interface LibraryBrowserSource {
  /**
   * Load one display list and report whether it came from test fixtures or a catalog.
   * @param options - Cancellation signal owned by the current browser load.
   * @returns The unconfigured state or a labeled display list; failures reject.
   */
  load(options: { readonly signal: AbortSignal }): Promise<LibraryBrowserResult>
}

/** Local browser filters; omitted values and all select every value, while unknown selects missing values. */
export interface LibraryFilters {
  readonly q?: string
  readonly category?: 'all' | LibraryCategory
  readonly gender?: string
  readonly style?: string
  readonly approvalStatus?: 'all' | LibraryApprovalStatus
  readonly appearance?: string
}
