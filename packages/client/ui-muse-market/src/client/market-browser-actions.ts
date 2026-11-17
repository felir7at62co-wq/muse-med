/** Browser-only Skill publication operations; local installation stays with the Muse Host. */
import type { MarketManifest } from '@deepseek-ai/dsh-muse-market/types'
import type { MarketAccountId, MarketPublicationId, MarketPublisherId, MarketReviewAction,
  MarketUploadRequestId } from '@deepseek-ai/dsh-muse-market/cloud-values'
import type { MarketIdentity, MarketLegacyResource, MarketPublication, MarketOutcomeKey, MarketTranslate } from './market-actions.ts'

/** Browser download with verified, complete publication bytes. */
export interface MarketBrowserFile { readonly name: string; readonly bytes: Uint8Array }

/** Prepared upload bytes and the manifest decoded from those exact bytes. */
export interface MarketBrowserArchive { readonly bytes: Uint8Array; readonly manifest: MarketManifest }

/** Same-origin cloud operations with explicit account assertions on mutations. */
export interface MarketBrowserActions {
  /** Maximum compressed ZIP bytes accepted before local reading or upload. */
  readonly archiveBytes: number
  /** @param query - Search text. @param mine - Include only current creator-visible records. @returns Validated cloud publications. */
  catalog(query: string, mine: boolean): Promise<MarketPublication[]>
  /** @param query - Search text. @returns Original public Skill metadata, without local installation claims. */
  legacyCatalog(query: string): Promise<MarketLegacyResource[]>
  /** @returns Current account, admitted teams and moderation capability, without credentials. */
  identity(): Promise<MarketIdentity>
  /** @param id - Cloud publication identity. @returns Current visible metadata. */
  getPublication(id: MarketPublicationId): Promise<MarketPublication>
  /** @param id - Publication identity. @param revision - Observed revision. @param action - Review transition.
   * @param note - Review note. @param accountId - Original account assertion. @returns Confirmed publication metadata.
   */
  review(id: MarketPublicationId, revision: number, action: MarketReviewAction, note: string,
    accountId: MarketAccountId): Promise<MarketPublication>
  /** @param bytes - Complete selected ZIP. @returns Validated local metadata, without uploading. */
  previewArchive(bytes: Uint8Array): Promise<MarketManifest>
  /** @param bytes - Complete selected ZIP. @param presetPortrait - Automatic match used only if unbound.
   * @returns Validated actual upload bytes and the manifest decoded from them, preserving an existing binding.
   */
  prepareArchive(bytes: Uint8Array, presetPortrait: string): Promise<MarketBrowserArchive>
  /** @param bytes - Prepared immutable ZIP. @param publisherId - Admitted team. @param requestId - Retained retry identity.
   * @param accountId - Original account assertion. @returns Server-confirmed private draft without submitting for review.
   */
  uploadArchive(bytes: Uint8Array, publisherId: MarketPublisherId, requestId: MarketUploadRequestId,
    accountId: MarketAccountId): Promise<MarketPublication>
  /** @param publication - Observed publication and digest. @returns Verified exact bytes for a browser file download. */
  downloadPublication(publication: MarketPublication): Promise<MarketBrowserFile>
  /** @param resource - Observed original resource and digest. @returns Verified canonical ZIP directly importable in Muse. */
  downloadLegacy(resource: MarketLegacyResource): Promise<MarketBrowserFile>
}

/** Existing public and creator URLs rendered by the independent market website. */
export type MarketBrowserView = 'discover' | 'publish' | 'upload'

/** Standalone website inputs; no desktop state, renderer hooks or activation callbacks are synthesized. */
export interface MarketBrowserPageProps {
  readonly actions: MarketBrowserActions
  readonly view: MarketBrowserView
  readonly onNavigate: (view: MarketBrowserView) => void
  readonly t: MarketTranslate
  readonly reportOutcome: (key: MarketOutcomeKey, failed: boolean) => void
}
