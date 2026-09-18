/**
 * The one credential key this plugin owns, plus the bearer-token hygiene every
 * Jubian reader applies before it builds a header.
 *
 * `trimBearerToken` and `isUsableBearerToken` are moved verbatim from
 * `packages/bundle/muse-product/src/jubian-credential.ts`, where they were the
 * shared repair for four adapters. The behaviour is deliberately identical: a
 * secret pasted from a shell keeps the shell's separator (`export X=...;`) and
 * a settings form may keep the quotes the operator copied with it. Both are
 * paste artifacts, never part of the token. Only the boundary is repaired here;
 * an interior space still fails as an authentication problem rather than being
 * sent, logged or echoed.
 */

/** The credential reference this plugin reads; the plugin owns this name, the host owns the value. */
export const JUBIAN_TOKEN_REF = 'JUBIANAI_ADMIN_TOKEN'

/**
 * Remove the paste artifacts around one secret value; the token itself is never rewritten.
 * @param value - Stored or pasted secret.
 * @returns The value with surrounding whitespace, one trailing shell separator and one matching quote pair removed.
 */
export function trimBearerToken(value: string): string {
  let candidate = value.trim()
  if (candidate.endsWith(';') || candidate.endsWith('&')) candidate = candidate.slice(0, -1).trim()
  const first = candidate[0], last = candidate.at(-1)
  if (candidate.length >= 2 && (first === '"' || first === "'") && last === first) candidate = candidate.slice(1, -1).trim()
  return candidate
}

/** Whether a repaired value is still something a bearer header may carry. */
export function isUsableBearerToken(value: string): boolean {
  return value.length > 0 && !/\s/.test(value)
}
