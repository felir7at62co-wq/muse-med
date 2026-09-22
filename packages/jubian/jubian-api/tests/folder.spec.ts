import { describe, expect, it } from 'vitest'
import { findFolder, findFolderById, readFolderTree } from '../src/folder.ts'

/** The tree the live endpoint answers with: a plain array of nested nodes. */
const TREE = [
  { id: 11, folderName: 'EP05', rootCategoryType: 1, children: [
    { id: 12, folderName: 'EP05-近景', children: [] },
  ] },
  { id: 13, folderName: '全剧', children: null },
]

describe('readFolderTree', () => {
  it('reads the nested node array the endpoint answers with', () => {
    expect(readFolderTree(TREE)).toEqual([
      { folder_id: 11, name: 'EP05', children: [{ folder_id: 12, name: 'EP05-近景', children: [] }] },
      { folder_id: 13, name: '全剧', children: [] },
    ])
  })

  it('reads the rows spelling the shared envelope normalization can hand it', () => {
    expect(readFolderTree({ total: 1, rows: [{ folderId: 11, name: 'EP05' }] }))
      .toEqual([{ folder_id: 11, name: 'EP05', children: [] }])
  })

  it('reads an empty library', () => {
    expect(readFolderTree([])).toEqual([])
  })

  it('keeps an unnamed folder visible rather than inventing a name', () => {
    expect(readFolderTree([{ id: 11 }])).toEqual([{ folder_id: 11, name: null, children: [] }])
  })

  it('rejects a payload that is neither a node array nor a rows object', () => {
    expect(() => readFolderTree(null)).toThrow()
    expect(() => readFolderTree({ total: 0 })).toThrow()
    expect(() => readFolderTree([null])).toThrow()
  })

  it('rejects a node without a usable identifier, or with a non-array children field', () => {
    expect(() => readFolderTree([{ folderName: 'x' }])).toThrow()
    expect(() => readFolderTree([{ id: 0, folderName: 'x' }])).toThrow()
    expect(() => readFolderTree([{ id: 11, children: 'x' }])).toThrow()
  })

  it('reads a string identifier the provider sent as text', () => {
    expect(readFolderTree([{ id: '11', folderName: 'EP05' }]))
      .toEqual([{ folder_id: 11, name: 'EP05', children: [] }])
  })
})

describe('findFolder', () => {
  it('finds a root-level folder by its trimmed name', () => {
    expect(findFolder(readFolderTree(TREE), ' EP05 ')?.folder_id).toBe(11)
  })

  it('finds a folder among one parent\'s children', () => {
    expect(findFolder(readFolderTree(TREE), 'EP05-近景', 11)?.folder_id).toBe(12)
  })

  it('reports nothing when the parent is absent from the tree', () => {
    expect(findFolder(readFolderTree(TREE), 'EP05-近景', 999)).toBeNull()
  })

  it('reports nothing when no direct child carries the name', () => {
    expect(findFolder(readFolderTree(TREE), 'EP05-近景')).toBeNull()
  })

  it('does not match a folder whose name is absent', () => {
    expect(findFolder(readFolderTree([{ id: 11 }]), 'EP05')).toBeNull()
  })
})

describe('findFolderById', () => {
  it('finds a folder at any depth', () => {
    expect(findFolderById(readFolderTree(TREE), 12)?.name).toBe('EP05-近景')
  })

  it('reports nothing for an identifier the tree does not hold', () => {
    expect(findFolderById(readFolderTree(TREE), 999)).toBeNull()
    expect(findFolderById([], 999)).toBeNull()
  })
})
