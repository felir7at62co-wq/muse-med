/**
 * The asset library's folder tree: the grouping the console shows beside a
 * project's assets.
 *
 * The provider answers with the node array itself, nested through `children`,
 * and a folder carries no parent field — parentage is structural. That is why
 * this reader returns the tree rather than a flat list with a parent column: a
 * flattened form would have to invent the parent it was given.
 */
import { JubianError } from '@deepseek-ai/dsh-jubian'

function invalid(): never { throw new JubianError('CONTRACT_CHANGED') }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}

function id(value: unknown): number {
  const candidate = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 1) invalid()
  return candidate
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/** One asset-library folder, with the sub-folders the provider nested under it. */
export interface FolderNode {
  folder_id: number
  name: string | null
  children: FolderNode[]
}

/** Read one level of the tree. */
function level(value: unknown): FolderNode[] {
  if (!Array.isArray(value)) invalid()
  return value.map((entry) => {
    const row = object(entry)
    const children = row.children
    return { folder_id: id(row.id ?? row.folderId),
      name: nullableText(row.folderName ?? row.name),
      children: children === undefined || children === null ? [] : level(children) }
  })
}

/**
 * Read the folder tree of one category library.
 *
 * The endpoint answers with the node array as its payload, while the shared
 * envelope normalization hands a `rows`-carrying object to readers of the paged
 * list endpoints; both spellings read here so a provider that adopts either one
 * keeps working.
 * @param data - Envelope `data` from `/aigc/assetFolder/tree`.
 * @returns The root-level folders, each carrying its sub-folders.
 * @throws {JubianError} `CONTRACT_CHANGED` when the payload is neither an array nor a `rows` object.
 */
export function readFolderTree(data: unknown): FolderNode[] {
  return level(Array.isArray(data) ? data : object(data).rows)
}

/**
 * Find one folder by name among a parent's direct children.
 *
 * A folder name is the only identity the console's create call accepts, so a
 * caller that must not create a duplicate has to look the name up here first.
 * @param nodes - Root-level folders to search.
 * @param name - Folder name to match, compared trimmed and exactly.
 * @param parentId - Restrict the search to this folder's children; the root level when omitted.
 * @returns The first matching folder, or null when no direct child carries that name.
 */
export function findFolder(nodes: readonly FolderNode[], name: string, parentId?: number): FolderNode | null {
  const scope = parentId === undefined ? nodes : findFolderById(nodes, parentId)?.children ?? []
  const wanted = name.trim()
  return scope.find(node => (node.name ?? '').trim() === wanted) ?? null
}

/**
 * Find one folder by its identifier, at any depth.
 * @param nodes - Root-level folders to search.
 * @param folderId - Folder identifier the provider assigned.
 * @returns The matching folder, or null when the tree does not hold it.
 */
export function findFolderById(nodes: readonly FolderNode[], folderId: number): FolderNode | null {
  for (const node of nodes) {
    if (node.folder_id === folderId) return node
    const nested = findFolderById(node.children, folderId)
    if (nested !== null) return nested
  }
  return null
}
