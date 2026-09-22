/**
 * The rows the paid asset-image route can buy from, as the 短剧 page reads them.
 *
 * The rows arrive over the `jubianImage` Remote namespace, which
 * `@deepseek-ai/dsh-tool-jubian` owns: that package holds the credential and the
 * transport that read the account catalogue, so this page only ever sees the
 * rows a person may choose between — never the token behind them.
 *
 * The namespace is optional, the way the plugin inventory is: a deployment that
 * composes no Jubian tools answers {@link DramaImageRoutes} with `unavailable`
 * rather than an empty catalogue, which would look like an account with no rows.
 */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'

/** One `gpt-image-2` catalogue row the paid route can buy from. */
export interface DramaImageRoute {
  /** The row's own `id`, which the paid request carries as `standardId`. */
  readonly standardId: number
  /** The platform the row buys from, such as `KU_AI`. */
  readonly platformId: string
  /** The row's unit price, or null while the catalogue states none. */
  readonly unitPrice: number | null
  /** The unit that price is quoted in, or null while the catalogue states none. */
  readonly unit: string | null
}

/** What the page knows about the payable rows. */
export type DramaImageRoutes =
  /** The catalogue answered; `routes` may still be empty. */
  | { readonly status: 'ok'; readonly routes: readonly DramaImageRoute[] }
  /** This deployment composes no Jubian image-route namespace. */
  | { readonly status: 'unavailable' }
  /** The namespace answered with a refusal, or the call itself threw. */
  | { readonly status: 'failed'; readonly message: string }

/** One `jubianImage.routes` answer as the Remote assembly delivers it. */
export type ImageRoutesResult = RemoteResult<{ readonly candidates: readonly DramaImageRoute[] }>

/** The one method this page reads from the paid route's Remote namespace. */
export interface JubianImageFace {
  /**
   * Read the rows the account's `gpt-image-2` catalogue lists.
   * @returns the payable rows, or the namespace's refusal.
   */
  routes: () => Promise<ImageRoutesResult>
}

/**
 * Fold one Remote answer into what the page shows.
 * @param result - the namespace's answer, or its refusal.
 * @returns the rows, or the reason there are none to show.
 */
export function imageRoutesOf(result: ImageRoutesResult): DramaImageRoutes {
  return result.ok
    ? { status: 'ok', routes: result.value.candidates }
    : { status: 'failed', message: `${result.error.code}: ${result.error.message}` }
}
