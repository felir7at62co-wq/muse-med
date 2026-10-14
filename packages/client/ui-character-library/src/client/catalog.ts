/** Same-process display filtering and restricted image sources for the Phase2 browser. */
import type {
  LibraryBrowserSource,
  LibraryDisplayItem,
  LibraryFilters,
  LibraryReadOnlyCapability,
} from './types.ts'

/** Approved display status does not enable binding or any other mutation. */
export const libraryReadOnlyCapability: LibraryReadOnlyCapability = Object.freeze<LibraryReadOnlyCapability>({ kind: 'no_bind' })

/** The shipped display source performs no reads or network requests before a catalog adapter exists. */
export const defaultLibraryBrowserSource: LibraryBrowserSource = Object.freeze<LibraryBrowserSource>({
  async load({ signal }) {
    signal.throwIfAborted()
    return Promise.resolve({ kind: 'unconfigured' })
  },
})

function matchesOptionalFilter(value: string | undefined, selected: string | undefined): boolean {
  if (!selected || selected === 'all') return true
  if (selected === 'unknown') return !value || value.trim() === '' || value === 'unknown'
  return value === selected
}

/**
 * Select display items without changing the source list or interpreting external metadata.
 * @param items - Display items supplied by the same-process source.
 * @param filters - Search across display IDs, names and tags, combined with every selected facet.
 * @returns Items in source order matching all selected filters.
 */
export function filterLibraryItems(
  items: readonly LibraryDisplayItem[],
  filters: LibraryFilters,
): readonly LibraryDisplayItem[] {
  const query = filters.q?.trim().toLowerCase()
  return items.filter((item) => {
    if (query && ![item.displayId, item.name, ...item.tags].some(value => value.toLowerCase().includes(query))) return false
    if (!matchesOptionalFilter(item.category, filters.category)) return false
    if (!matchesOptionalFilter(item.gender, filters.gender)) return false
    if (!matchesOptionalFilter(item.style, filters.style)) return false
    if (!matchesOptionalFilter(item.approvalStatus, filters.approvalStatus)) return false
    if (!filters.appearance || filters.appearance === 'all') return true
    if (filters.appearance === 'unknown') return item.appearanceTags.length === 0 || item.appearanceTags.includes('unknown')
    return item.appearanceTags.includes(filters.appearance)
  })
}

const INLINE_IMAGE =
  /^data:image\/(?:png|jpeg|webp);base64,(?=[A-Za-z0-9+/])(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const BLOB_IMAGE = /^blob:(https?:\/\/[^/?#\s]+|null)\/[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/

/**
 * Permit inline raster images and browser object URLs, without fetching or resolving paths.
 * A future adapter owns safe image bytes and may supply a blob made from its controlled proxy.
 * @param source - Optional thumbnail or preview URL supplied by the display source.
 * @returns The original permitted URL, or undefined for remote, file, active, or malformed URLs.
 */
export function safeLibraryPreviewSrc(source: string | undefined): string | undefined {
  if (!source) return undefined
  if (INLINE_IMAGE.test(source)) return source
  const blob = BLOB_IMAGE.exec(source)
  if (!blob) return undefined
  const originText = source.slice(5, source.lastIndexOf('/'))
  if (originText === 'null') return source
  try {
    const origin = new URL(originText)
    return origin.origin === originText ? source : undefined
  } catch {
    // A malformed origin cannot name a browser-created object URL.
    return undefined
  }
}
