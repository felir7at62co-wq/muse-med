/** Controlled reintroduction of accumulated Assistant trimming in a private compiled benchmark worker. */

const VISIBILITY_EXPRESSIONS = [
  'nextVisible = previous?.kind === "text" && previousVisible || chunk.text.trim() !== "";',
  'nextVisible = previous?.kind === "reasoning" && previousVisible || chunk.text.trim() !== "";',
] as const

/**
 * Restore accumulated trimming without changing the production source or worker endpoint.
 * @param compiledSource - Complete, freshly built conversation worker JavaScript.
 * @returns Worker JavaScript with exactly the text and reasoning visibility expressions replaced.
 * @throws If either compiled expression is missing or appears more than once.
 */
export function accumulatedTrimControl(compiledSource: string): string {
  let source = compiledSource
  for (const expression of VISIBILITY_EXPRESSIONS) {
    const parts = source.split(expression)
    if (parts.length !== 2) throw new Error('accumulated-trim control requires exactly one compiled expression per block kind')
    source = parts.join('nextVisible = blockIsVisible(blocks[chunk.index]);')
  }
  return source
}
