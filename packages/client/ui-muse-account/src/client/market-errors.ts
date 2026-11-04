/** Locale-owned market failures shared by local operations and cloud publication controls. */
import { marketZh, type MarketLocaleKey } from './market-locales.ts'

/** Map a bounded Host reason without showing raw upstream diagnostics.
 * @param error Adapter failure containing a reason in Error.message.
 * @returns An admitted market locale key or the generic failure key.
 */
export function marketFailure(error: unknown): MarketLocaleKey {
  const key = `error.${error instanceof Error ? error.message : 'generic'}`
  return Object.hasOwn(marketZh, key) ? key as MarketLocaleKey : 'error.generic'
}
