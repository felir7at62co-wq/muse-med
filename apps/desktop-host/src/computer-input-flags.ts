/** Distinguish physical activity from Windows-injected keyboard and pointer events. */

/** Classify the flags supplied by Windows low-level input hooks.
 * @param kind - Hook category, independent of the key or pointer content.
 * @param flags - KBDLLHOOKSTRUCT or MSLLHOOKSTRUCT flags.
 * @returns Whether the event may be treated as local human activity.
 */
export function isPhysicalInput(kind: 'keyboard' | 'mouse', flags: number): boolean {
  const injectedMask = kind === 'keyboard' ? 0x12 : 0x03
  return (flags & injectedMask) === 0
}

/** Recognize an Escape press after excluding injected input.
 * @param event - Windows keyboard message.
 * @param key - Virtual key used only for this comparison, never retained.
 * @returns Whether the physical key press requests computer-use exit.
 */
export function isEscapeKeyDown(event: number | bigint, key: number): boolean {
  return (event === 0x100 || event === 0x104 || event === 0x100n || event === 0x104n) && key === 0x1b
}
