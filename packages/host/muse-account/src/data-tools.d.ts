/** Model tool that searches the data station's whole collection (全收录) with the signed-in Muse account. */
import type { Context } from '@deepseek-ai/cordis'
import { type MuseDataStationClient } from './data-station.ts'
/** Validated result size of one search. */
export interface MuseDataToolOptions {
  /** Works returned per page. */
  readonly pageSize: number
}
/**
 * Register `data_station_search`: find dramas and source novels in the data station's whole collection.
 * @param ctx - Context with the owning tool registry.
 * @param client - Account-token station transport owned by the plugin.
 * @param options - Validated result size.
 */
export declare function mountMuseDataTools(ctx: Context, client: Pick<MuseDataStationClient, 'works'>, options: MuseDataToolOptions): void
//# sourceMappingURL=data-tools.d.ts.map
