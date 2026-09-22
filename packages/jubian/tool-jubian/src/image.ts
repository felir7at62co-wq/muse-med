/**
 * The paid image route's deployment choices: which `gpt-image-2` catalogue row
 * `jubian_video image_generate` buys from, and the read-only Remote face a
 * Settings page lists that row's alternatives over.
 *
 * The row is one fact with two homes, in this order: the short-drama settings
 * section, which a person edits on the Web Settings page, and then this row's own
 * composition config. The settings document wins because the page is the only
 * surface that can show the account's own price next to each candidate; the config
 * stays as what a deployment without that page states.
 *
 * This plugin never picks a row on its own: a catalogue listing several of them
 * fails in `resolveImageModel` and names every candidate, because a default would
 * spend real money on a platform nobody selected.
 *
 * @module @deepseek-ai/dsh-tool-jubian/src/image
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JubianClient } from '@deepseek-ai/dsh-jubian'
import { MODEL_TASK_TYPES, imageCandidates, readModels } from '@deepseek-ai/dsh-jubian-api'
import type { ImageModelSelection } from '@deepseek-ai/dsh-jubian-api'
// Type-only: resolves the `settings` service and its Context merge.
import type {} from '@deepseek-ai/dsh-settings'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ImageRouteRow } from './types.ts'
import './types.ts'

/**
 * The short-drama settings section that may pin the paid image row, and the field
 * inside it. Spelled here rather than imported: the section is read through the
 * settings service's generic `get`, so this row keeps working — and keeps its
 * dependency list — whether or not the drama settings package is composed.
 */
const DRAMA_IMAGE_SETTING = { namespace: 'drama', field: 'imageStandardId' } as const

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `jubianImage` Remote namespace. */
    jubianImage: JubianImageRoutes
  }
}

/** The composition fields the paid image route reads. */
export interface ImageRouteConfig {
  /**
   * Which `platformId` of the `taskType=2` catalogue `image_generate` buys from,
   * such as `KU_AI`. The account catalogue can list one model id once per
   * platform at different prices, and this plugin never picks one for you: with
   * several rows and no configured platform or standard, the call fails and
   * names every candidate.
   */
  imagePlatformId?: string
  /**
   * Which catalogue row (`standardId`, the row's own `id`) `image_generate` buys
   * from, such as `66`. Either this or `imagePlatformId` is enough to pin one row.
   */
  imageStandardId?: number
}

/**
 * Read the row the short-drama settings section pinned.
 *
 * The section is a durable document another package owns, so the field is checked
 * rather than trusted: anything but a positive integer is no pin at all, and the
 * route then falls back to the composition config exactly as if the field had
 * never been written.
 * @param ctx - Host context that may carry the settings service.
 * @returns the pinned catalogue row id, or undefined while nothing pins one.
 */
function pinnedStandardId(ctx: Context): number | undefined {
  const settings = ctx.get('settings')
  if (settings === undefined) return undefined
  const section = settings.get(DRAMA_IMAGE_SETTING.namespace)
  if (typeof section !== 'object' || section === null) return undefined
  const value = (section as Record<string, unknown>)[DRAMA_IMAGE_SETTING.field]
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * The catalogue row one paid image call buys from, resolved as that call is made.
 *
 * Resolved per call rather than once at mount: the settings document can change
 * while this row stays loaded, and a page edit has to reach the next paid call
 * without a restart.
 * @param ctx - Host context that may carry the settings service.
 * @param config - this row's own composition config.
 * @returns the selection `resolveImageModel` receives; an empty one means no row is pinned.
 */
export function pinnedImageSelection(ctx: Context, config: ImageRouteConfig): ImageModelSelection {
  const standardId = pinnedStandardId(ctx)
  // A row chosen on the settings page is the whole selection: keeping a
  // composition platform beside it would fail a call the person already decided.
  if (standardId !== undefined) return { standardId }
  return {
    ...config.imageStandardId === undefined ? {} : { standardId: config.imageStandardId },
    ...config.imagePlatformId === undefined ? {} : { platformId: config.imagePlatformId },
  }
}

/**
 * Host service backing the generated `ctx.remote.jubianImage` namespace: the rows
 * the paid image route may buy from.
 *
 * The namespace reads and never writes, and it carries rows only — the token that
 * authorizes the read never crosses to the browser.
 */
export class JubianImageRoutes extends TypertRemoteService {
  /**
   * @param ctx - Host context carrying the Remote assembly.
   * @param options - the transport the tools already read the account over.
   */
  constructor(ctx: Context, options: { client: JubianClient }) {
    super(ctx, 'jubianImage')
    this.client = options.client
  }

  /** Transport shared with the tools: one origin, one credential, one timeout. */
  private readonly client: JubianClient

  /**
   * List the `gpt-image-2` catalogue rows this account may buy from.
   *
   * Free and read-only: the very catalogue read the paid call makes, spending
   * nothing. A Settings page offers these rows so a person picks a platform by its
   * own price instead of reading that price out of a failure message.
   * @returns one entry per `gpt-image-2` row, in catalogue order.
   * @throws RemoteError when the catalogue cannot be read; its message is what the page shows.
   */
  @Remote
  async routes(): Promise<{ candidates: ImageRouteRow[] }> {
    try {
      const response = await this.client.request({
        method: 'GET', path: `/model/charge/getSelectList?taskType=${MODEL_TASK_TYPES.image}` })
      return { candidates: imageCandidates(readModels(response.data)) }
    } catch (error: unknown) {
      throw new RemoteError('jubian-image/catalogue-unreadable',
        error instanceof Error ? error.message : String(error), {}, { cause: error })
    }
  }
}
