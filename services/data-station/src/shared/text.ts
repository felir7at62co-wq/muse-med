const high = (code: number) => code >= 0xd800 && code <= 0xdbff;
const low = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Slices UTF-16 text without separating a surrogate pair, so the result stays well-formed for JSON storage.
 * A start inside a pair moves past it; an end inside a pair moves before it.
 * @param text Text to cut.
 * @param start First code unit, clamped to the text.
 * @param end Code unit after the last one, clamped to the text.
 * @returns The well-formed part of `text` between the adjusted bounds.
 */
export function sliceText(text: string, start: number, end = text.length): string {
  let from = Math.min(Math.max(0, start), text.length), to = Math.min(Math.max(from, end), text.length);
  if (from > 0 && from < text.length && low(text.charCodeAt(from)) && high(text.charCodeAt(from - 1))) from++;
  if (to > from && to < text.length && high(text.charCodeAt(to - 1)) && low(text.charCodeAt(to))) to--;
  return text.slice(from, Math.max(from, to));
}
