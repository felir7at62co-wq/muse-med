/** Browser publication operations; local installation remains owned by the Muse Host. */
import type MuseMarket from '@deepseek-ai/dsh-muse-market'
import type { MarketManifest, MarketRelease } from '@deepseek-ai/dsh-muse-market/types'

/** Cloud operations shared by the website and the authenticated Host adapter. */
export type MarketPublicationActions = Pick<MuseMarket, 'catalog' | 'identity' | 'review'>

/** Same-origin browser callbacks with explicit upload bounds and verified archive downloads. */
export interface MarketWebActions extends MarketPublicationActions, Pick<MuseMarket, 'legacyCatalog'> {
  /** Maximum compressed archive bytes accepted by this deployment. */
  readonly archiveBytes: number
  /** Inspect local ZIP metadata without uploading or accepting its resources.
   * @param archive User-selected ZIP bytes.
   * @returns Metadata for the local preview.
   */
  previewArchive(archive: Uint8Array): Promise<MarketManifest>
  /** Upload a complete archive as a private cloud draft.
   * @param archive User-confirmed ZIP bytes.
   * @param publisherId Selected publishing team.
   * @param requestId Idempotency key retained across retries for this file, team and portrait.
   * @param portrait Optional approved stock portrait identifier.
   * @returns Server-confirmed draft metadata.
   */
  uploadArchive(archive: Uint8Array, publisherId: string, requestId: string, portrait?: MarketManifest['portrait'] | MarketManifest['presetPortrait']): Promise<MarketRelease>
  /** Fetch and verify the exact immutable release bytes.
   * @param release Server-confirmed release metadata.
   * @returns Download name and verified ZIP bytes; it does not install anything locally.
   */
  downloadArchive(release: MarketRelease): Promise<{ name: string; bytes: Uint8Array }>
}
