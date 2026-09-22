import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { createFolderMethod, moveMethod, renameMethod } from '../src/folders.ts'
import { resolveNaming } from '../src/naming.ts'

/** The tree the provider holds during these tests. */
const TREE = [{ id: 11, folderName: 'EP05', children: [] }]

/** A client stub that records every request and answers from a path-keyed table. */
function stubClient(handler: (request: { method: string; path: string; body?: Record<string, unknown> }) => unknown) {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
  const client = new JubianClient({ credential: async () => 'token',
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const request = { method: String(init?.method), path: (url as URL).toString(),
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}) }
      calls.push(request)
      return new Response(JSON.stringify({ code: 200, data: handler(request) }), { status: 200 })
    } })
  return { calls, client }
}

/** A provider whose folder tree grows by one node after the first create. */
function folderProvider(): ReturnType<typeof stubClient> {
  let created = false
  return stubClient((request) => {
    if (request.path.includes('/aigc/assetFolder/tree')) {
      return created ? [...TREE, { id: 12, folderName: 'EP06', children: [] }] : TREE
    }
    if (request.path.includes('/aigc/assetFolder/add')) {
      created = true
      return null
    }
    return null
  })
}

let root: string
let ledger: JubianLedger
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jubian-folders-'))
  ledger = new JubianLedger({ root })
})

describe('createFolderMethod', () => {
  it('reports an existing sibling instead of creating a second folder with that name', async () => {
    const { calls, client } = folderProvider()
    const result = await createFolderMethod(client, ledger, { folder_name: ' EP05 ', asset_scope_type: 2,
      root_category_type: 1, idempotency_key: 'k1' })
    expect(result).toMatchObject({ sent: false, status: 'folder_exists', folder_id: 11 })
    expect(calls.map(call => call.method)).toEqual(['GET'])
    expect(calls[0]!.path).toContain('/aigc/assetFolder/tree?assetScopeType=2&rootCategoryType=1')
  })

  it('creates the folder, then reads the tree back to name its identifier', async () => {
    const { calls, client } = folderProvider()
    const result = await createFolderMethod(client, ledger, { folder_name: 'EP06', asset_scope_type: 2,
      root_category_type: 1, idempotency_key: 'k2' })
    expect(result).toMatchObject({ sent: true, status: 'created', folder_id: 12, confirmed: true, name: 'EP06',
      parent_id: 1, asset_scope_type: 2, root_category_type: 1 })
    expect(calls.map(call => call.method)).toEqual(['GET', 'POST', 'GET'])
    // The library root's own identifier is the category number, as the console sends it.
    expect(calls[1]!.body).toEqual({ folderName: 'EP06', parentId: 1, assetScopeType: 2, rootCategoryType: 1 })
  })

  it('uses the parent a caller named', async () => {
    const { calls, client } = folderProvider()
    await createFolderMethod(client, ledger, { folder_name: 'EP06', parent_id: 11, asset_scope_type: 2,
      root_category_type: 1, idempotency_key: 'k3' })
    expect(calls[0]!.path).toContain('rootCategoryType=1')
    expect(calls[1]!.body).toMatchObject({ parentId: 11 })
  })

  it('admits when the readback has not shown the new folder yet', async () => {
    const { client } = stubClient(request => request.path.includes('tree') ? TREE : null)
    const result = await createFolderMethod(client, ledger, { folder_name: 'EP06', asset_scope_type: 2,
      root_category_type: 1, idempotency_key: 'k4' })
    expect(result).toMatchObject({ confirmed: false, folder_id: null })
    expect(String(result.next)).toContain('不要重复创建')
  })

  it('replays a repeated key before the precondition read, without a second request', async () => {
    const { calls, client } = folderProvider()
    const args = { folder_name: 'EP06', asset_scope_type: 2, root_category_type: 1, idempotency_key: 'k5' }
    const first = await createFolderMethod(client, ledger, args)
    const sent = calls.length
    expect(await createFolderMethod(client, ledger, args))
      .toMatchObject({ replayed: true, sent: false, status: 'replayed' })
    expect(calls.length).toBe(sent)
    expect(first).toMatchObject({ replayed: false, outcome: 'accepted' })
  })

  it('refuses a blank name, an unknown library or a missing key before any request', async () => {
    const { calls, client } = folderProvider()
    await expect(createFolderMethod(client, ledger, { folder_name: '   ', asset_scope_type: 2,
      root_category_type: 1, idempotency_key: 'k6' })).rejects.toThrow(/folder_name/)
    await expect(createFolderMethod(client, ledger, { folder_name: 'x', asset_scope_type: 3,
      root_category_type: 1, idempotency_key: 'k7' })).rejects.toThrow(/asset_scope_type=3/)
    await expect(createFolderMethod(client, ledger, { folder_name: 'x', asset_scope_type: 2,
      root_category_type: 9, idempotency_key: 'k8' })).rejects.toThrow(/root_category_type=9/)
    await expect(createFolderMethod(client, ledger, { folder_name: 'x', asset_scope_type: 2,
      root_category_type: 1 })).rejects.toThrow(/idempotency_key/)
    await expect(createFolderMethod(client, ledger, { asset_scope_type: 2, root_category_type: 1,
      idempotency_key: 'k9' })).rejects.toThrow(/folder_name/)
    expect(calls).toEqual([])
  })
})

describe('moveMethod', () => {
  it('moves the rows the caller named, sending exactly the console\'s three fields', async () => {
    const { calls, client } = folderProvider()
    const result = await moveMethod(client, ledger, { material_ids: [900, 901], target_folder_id: 11,
      asset_scope_type: 2, root_category_type: 1, idempotency_key: 'm1' })
    expect(result).toMatchObject({ sent: true, status: 'moved', material_ids: [900, 901], target_folder_id: 11 })
    expect(calls[1]).toMatchObject({ method: 'PUT', body: { ids: [900, 901], targetFolderId: 11, assetScopeType: 2 } })
    expect(calls[1]!.path).toContain('/aigc/material/move')
  })

  it('accepts the library root as a destination, which is not a node of its own tree', async () => {
    const { calls, client } = folderProvider()
    const result = await moveMethod(client, ledger, { material_ids: [900], target_folder_id: 1,
      asset_scope_type: 2, root_category_type: 1, idempotency_key: 'm2' })
    expect(result).toMatchObject({ sent: true, status: 'moved', target_folder_id: 1 })
    expect(calls).toHaveLength(2)
  })

  it('reports a target the library does not hold instead of sending the move', async () => {
    const { calls, client } = folderProvider()
    const result = await moveMethod(client, ledger, { material_ids: [900], target_folder_id: 999,
      asset_scope_type: 2, root_category_type: 1, idempotency_key: 'm3' })
    expect(result).toMatchObject({ sent: false, status: 'target_folder_missing', target_folder_id: 999 })
    expect(String(result.next)).toContain('重读文件夹树')
    expect(calls.map(call => call.method)).toEqual(['GET'])
  })

  it('refuses an empty or unusable id list, an unknown library or a missing key', async () => {
    const { calls, client } = folderProvider()
    const base = { target_folder_id: 11, asset_scope_type: 2, root_category_type: 1, idempotency_key: 'm4' }
    await expect(moveMethod(client, ledger, { ...base, material_ids: [] })).rejects.toThrow(/material_ids/)
    await expect(moveMethod(client, ledger, { ...base, material_ids: [0] })).rejects.toThrow(/material_ids/)
    await expect(moveMethod(client, ledger, { ...base, material_ids: [1.5] })).rejects.toThrow(/material_ids/)
    await expect(moveMethod(client, ledger, { ...base, material_ids: [900], asset_scope_type: 7 }))
      .rejects.toThrow(/asset_scope_type=7/)
    await expect(moveMethod(client, ledger, { material_ids: [900], target_folder_id: 11,
      asset_scope_type: 2, root_category_type: 1 })).rejects.toThrow(/idempotency_key/)
    await expect(moveMethod(client, ledger, { material_ids: [900], asset_scope_type: 2,
      root_category_type: 1, idempotency_key: 'm0' })).rejects.toThrow(/target_folder_id/)
    expect(calls).toEqual([])
  })

  it('replays a repeated key before reading the tree', async () => {
    const { calls, client } = folderProvider()
    await moveMethod(client, ledger, { material_ids: [900], target_folder_id: 11, asset_scope_type: 2,
      root_category_type: 1, idempotency_key: 'm5' })
    const sent = calls.length
    expect(await moveMethod(client, ledger, { material_ids: [900], target_folder_id: 11, asset_scope_type: 2,
      root_category_type: 1, idempotency_key: 'm5' })).toMatchObject({ replayed: true, sent: false,
      status: 'replayed' })
    expect(calls.length).toBe(sent)
  })

  it('reports an intent line that never settled as an unknown outcome', async () => {
    // A process killed between the two ledger lines leaves exactly this record.
    await ledger.begin({ idempotencyKey: 'orphan', method: 'asset_move', requestSha256: 'sha256:0' })
    const { calls, client } = folderProvider()
    expect(await moveMethod(client, ledger, { material_ids: [900], target_folder_id: 11, asset_scope_type: 2,
      root_category_type: 1, idempotency_key: 'orphan' })).toMatchObject({ replayed: true, outcome: 'unknown' })
    expect(calls).toEqual([])
  })
})

describe('renameMethod', () => {
  it('sends the name verbatim when the caller names no episode', async () => {
    const { calls, client } = folderProvider()
    const result = await renameMethod(client, ledger, { material_id: 900, asset_name: ' 陆沉舟｜高定西装 ',
      idempotency_key: 'r1' })
    expect(result).toMatchObject({ sent: true, status: 'renamed', material_id: 900, asset_name: '陆沉舟｜高定西装' })
    expect(calls[0]).toMatchObject({ method: 'PUT', body: { id: 900, assetName: '陆沉舟｜高定西装' } })
    expect(calls[0]!.path).toContain('/aigc/material/reName')
  })

  it('composes the conventional name when the caller names an episode and a category', async () => {
    const { calls, client } = folderProvider()
    const result = await renameMethod(client, ledger, { material_id: 900, asset_name: '红包', episode: '5',
      asset_category: '道具', idempotency_key: 'r2' })
    expect(result).toMatchObject({ asset_name: 'EP05｜道具｜红包' })
    expect(calls[0]!.body).toEqual({ id: 900, assetName: 'EP05｜道具｜红包' })
  })

  it('takes the naming choices it is given', async () => {
    const { calls, client } = folderProvider()
    await renameMethod(client, ledger, { material_id: 900, asset_name: '红包', episode: '5',
      asset_category: '道具', idempotency_key: 'r3' }, { naming: resolveNaming({ separator: '|' }) })
    expect(calls[0]!.body).toEqual({ id: 900, assetName: 'EP05|道具|红包' })
  })

  it('refuses a missing category, a blank name, a bad identifier or a missing key', async () => {
    const { calls, client } = folderProvider()
    await expect(renameMethod(client, ledger, { material_id: 900, asset_name: '红包', episode: '5',
      idempotency_key: 'r4' })).rejects.toThrow(/asset_category/)
    await expect(renameMethod(client, ledger, { material_id: 900, asset_name: '   ',
      idempotency_key: 'r5' })).rejects.toThrow(/asset_name/)
    await expect(renameMethod(client, ledger, { material_id: 0, asset_name: 'x',
      idempotency_key: 'r6' })).rejects.toThrow(/material_id/)
    await expect(renameMethod(client, ledger, { material_id: 900 })).rejects.toThrow(/idempotency_key/)
    await expect(renameMethod(client, ledger, { asset_name: 'x', idempotency_key: 'r7' }))
      .rejects.toThrow(/material_id/)
    expect(calls).toEqual([])
  })

  it('replays a repeated key without a second request', async () => {
    const { calls, client } = folderProvider()
    const args = { material_id: 900, asset_name: '陆沉舟｜高定西装', idempotency_key: 'r8' }
    await renameMethod(client, ledger, args)
    const sent = calls.length
    expect(await renameMethod(client, ledger, args)).toMatchObject({ replayed: true, sent: false })
    expect(calls.length).toBe(sent)
  })
})
