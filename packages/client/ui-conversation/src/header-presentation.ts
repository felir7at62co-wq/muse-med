/** Public startup policy for the native conversation header. */
import Schema from '@deepseek-ai/schemastery'

/** Standard navigation rows or controls floating above the transcript. */
export type HeaderPresentation = 'standard' | 'floating'

/** Validated presentation choice shared by Host and browser. */
export const HeaderPresentation: Schema<HeaderPresentation> = Schema.union(['standard', 'floating']).default('standard')

/** Non-secret bootstrap value owned by the native conversation shell. */
export const HEADER_PRESENTATION_GLOBAL = '__DSH_CONVERSATION_HEADER_PRESENTATION__'

/** Resolve the Host-selected header style before native slots register.
 * @returns The validated presentation, defaulting to the standard Web header.
 */
export function readHeaderPresentation(): HeaderPresentation {
  const value: unknown = Reflect.get(globalThis, HEADER_PRESENTATION_GLOBAL)
  if (value === undefined) return 'standard'
  if (value !== 'standard' && value !== 'floating') throw new TypeError('Invalid conversation header presentation')
  return value
}
