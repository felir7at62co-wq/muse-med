/**
 * Wire vocabulary of the `jubianToken` and `jubianImage` Remote namespaces.
 * Types only: the declarations below are what makes a refusal code this package
 * throws a recognised member of the Remote error map, and what gives the
 * `jubianImage` payload a public home, so the Gateway, the Client, and any other
 * consumer read one typed contract rather than a bare string.
 *
 * @module @deepseek-ai/dsh-tool-jubian/src/types
 */

// Import the protocol module so the declaration at the end of this file
// augments its error map rather than defining an unrelated ambient module.
import type {} from '@deepseek-ai/dsh-typert-protocol'

/**
 * One `gpt-image-2` catalogue row as the `jubianImage` namespace carries it.
 *
 * Declared here rather than reused from `dsh-jubian-api`, whose row type is not
 * reachable through a public non-wildcard subpath: a type that crosses a Remote
 * boundary has to live in a module the package exports by name.
 */
export interface ImageRouteRow {
  /** The row's own `id`, which the paid request carries as `standardId`. */
  readonly standardId: number
  /** The platform the row buys from, such as `KU_AI`. */
  readonly platformId: string
  /** The row's unit price, or null while the catalogue states none. */
  readonly unitPrice: number | null
  /** The unit that price is quoted in, or null while the catalogue states none. */
  readonly unit: string | null
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * The credential provider refused a write of the Jubian admin token — for
     * example because a read-only source shadows the reference. The details
     * name only the reference, so no failure path can carry the value back out.
     */
    'jubian-token/rejected': { readonly ref: string }
    /**
     * The `jubianImage` namespace could not read the account catalogue, so it
     * has no rows to offer. The message is the transport's own reason — a
     * missing token, an expired one, a provider outage — which no detail field
     * narrows without restating it.
     */
    'jubian-image/catalogue-unreadable': {}
  }
}
