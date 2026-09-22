/**
 * The asset-organization writes: create a library folder, move assets into one,
 * and rename an asset.
 *
 * These are the three calls the console itself makes, reproduced with the same
 * verbs and bodies. Each one is guarded the way every other write here is: a
 * caller-supplied `idempotency_key`, an intent line before the request leaves,
 * and a settle line after it returns. A repeated key sends nothing.
 *
 * Two of them also read before they write, because the provider reports its
 * refusals as one envelope code that cannot separate "that folder already
 * exists" from "that folder is gone". The free tree read settles both questions
 * locally, so the caller gets a decidable answer instead of a bare failure.
 */
import type { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { JubianError } from '@deepseek-ai/dsh-jubian'
import { findFolder, findFolderById, readFolderTree } from '@deepseek-ai/dsh-jubian-api'
import type { FolderNode } from '@deepseek-ai/dsh-jubian-api'
import { composedAssetName, resolveNaming } from './naming.ts'
import type { AssetCategory, Naming } from './naming.ts'
import { need, requireKey, writeUnderLedger } from './write.ts'

/** The two asset scopes the console offers, as the provider numbers them. */
export const ASSET_SCOPES = { team: 1, personal: 2 } as const

/** Arguments shared by the organization writes. */
export interface FolderMethodArgs {
  folder_name?: string
  parent_id?: number
  asset_scope_type?: number
  root_category_type?: number
  material_ids?: number[]
  target_folder_id?: number
  material_id?: number
  asset_name?: string
  episode?: string
  asset_category?: AssetCategory
  idempotency_key?: string
}

/** Everything the organization writes take from outside the transport. */
export interface FolderMethodDeps {
  /** Naming choices; defaults to the convention's own defaults when omitted. */
  naming?: Naming
}

/** Read one library's folder tree. */
async function libraryTree(client: JubianClient, scope: number, categoryType: number): Promise<FolderNode[]> {
  return readFolderTree((await client.request({ method: 'GET',
    path: `/aigc/assetFolder/tree?assetScopeType=${scope}&rootCategoryType=${categoryType}` })).data)
}

/**
 * Answer a key that already has a record, before the free precondition read.
 *
 * The precondition reads below decide "this folder already exists" from the live
 * tree, and after a successful create that same tree is exactly what a repeated
 * key would find — so without this check a replay would report a folder the
 * first call created as a refusal. Asking the ledger first keeps the package-wide
 * meaning of a repeated key: the recorded outcome, and nothing sent.
 * @param ledger - Write-path ledger.
 * @param key - Caller-supplied key, already proven usable.
 * @returns The recorded outcome, or null when this key has no record yet.
 */
async function replayed(ledger: JubianLedger, key: string): Promise<Record<string, unknown> | null> {
  const existing = await ledger.find(key)
  if (existing === undefined) return null
  return { replayed: true, outcome: existing.outcome ?? 'unknown', response_sha256: existing.response_sha256,
    data: null, sent: false, status: 'replayed',
    next: '这个 idempotency_key 已有记录：本次没有发送请求，也没有改动远端。'
      + '用 jubian_organize 重读一次索引即可看到现状。' }
}

/** Reject a scope or category the provider has no library for. */
function requireLibrary(scope: number, categoryType: number): void {
  if (!Object.values(ASSET_SCOPES).includes(scope as 1 | 2) || ![1, 2, 3].includes(categoryType)) {
    throw new JubianError('INVALID_ARGUMENT', `asset_scope_type=${scope} / root_category_type=${categoryType}`)
  }
}

/**
 * `create_folder` — make one folder inside a category library.
 *
 * The folder is created under `parent_id`, or directly under the library root
 * when the caller names no parent: the root's own identifier is the category
 * number, which is what the console passes. A sibling that already carries the
 * name is reported instead of creating a second folder with it.
 * @param client - Jubian transport.
 * @param ledger - Write-path ledger.
 * @param args - `folder_name`, `asset_scope_type`, `root_category_type`, optional `parent_id` and key.
 * @returns The created folder's identifier once the tree shows it, or the existing sibling.
 * @throws {JubianError} `INVALID_ARGUMENT` for a missing or unusable argument.
 */
export async function createFolderMethod(client: JubianClient, ledger: JubianLedger,
  args: FolderMethodArgs): Promise<Record<string, unknown>> {
  const key = requireKey(args.idempotency_key)
  const recorded = await replayed(ledger, key)
  if (recorded !== null) return recorded
  const name = need(args.folder_name, 'folder_name').trim()
  if (!name) throw new JubianError('INVALID_ARGUMENT', 'folder_name')
  const scope = need(args.asset_scope_type, 'asset_scope_type')
  const categoryType = need(args.root_category_type, 'root_category_type')
  requireLibrary(scope, categoryType)
  const parentId = args.parent_id ?? categoryType
  const existing = findFolder(await libraryTree(client, scope, categoryType), name, args.parent_id)
  if (existing !== null) {
    return { sent: false, status: 'folder_exists', folder_id: existing.folder_id, name, parent_id: parentId,
      next: '同名文件夹已经存在，没有发送任何请求。要建一个不同层级的同名文件夹，请给出 parent_id；'
        + '要往里放资产，直接用这个 folder_id 调 move。' }
  }
  const result = await writeUnderLedger(ledger, key, 'asset_folder_create',
    () => ({ folderName: name, parentId, assetScopeType: scope, rootCategoryType: categoryType }),
    sent => client.request({ method: 'POST', path: '/aigc/assetFolder/add', body: need(sent) }))
  const created = findFolder(await libraryTree(client, scope, categoryType), name, args.parent_id)
  return { ...result, sent: true, status: 'created', folder_id: created?.folder_id ?? null, name,
    parent_id: parentId, asset_scope_type: scope, root_category_type: categoryType,
    confirmed: created !== null,
    next: created === null
      ? '请求已被受理，但回读的文件夹树里还没有这个名字：稍后重读树确认，不要重复创建。'
      : `文件夹已建好（folder_id=${created.folder_id}）。把资产放进去用 move；`
        + '要按规范命名新资产，用 image_generate 或 rename 的 episode 与 asset_category。' }
}

/**
 * `move` — put assets into a folder.
 *
 * `root_category_type` is required because it selects the tree this method reads
 * to prove the target exists; the request body carries only the three fields the
 * console sends. Moving back to a library root is allowed by naming the library's
 * own identifier — the category number — as the target.
 * @param client - Jubian transport.
 * @param ledger - Write-path ledger.
 * @param args - `material_ids`, `target_folder_id`, `asset_scope_type`, `root_category_type` and a key.
 * @returns The move's outcome, or a decidable refusal when the target is not there.
 * @throws {JubianError} `INVALID_ARGUMENT` for a missing or unusable argument.
 */
export async function moveMethod(client: JubianClient, ledger: JubianLedger,
  args: FolderMethodArgs): Promise<Record<string, unknown>> {
  const key = requireKey(args.idempotency_key)
  const recorded = await replayed(ledger, key)
  if (recorded !== null) return recorded
  const ids = need(args.material_ids, 'material_ids')
  if (ids.length === 0 || ids.some(id => !Number.isSafeInteger(id) || id < 1)) {
    throw new JubianError('INVALID_ARGUMENT', 'material_ids')
  }
  const target = need(args.target_folder_id, 'target_folder_id')
  const scope = need(args.asset_scope_type, 'asset_scope_type')
  const categoryType = need(args.root_category_type, 'root_category_type')
  requireLibrary(scope, categoryType)
  const tree = await libraryTree(client, scope, categoryType)
  // The library root is not a node of its own tree; the console addresses it by
  // the category number, which is what its own selected-folder state holds.
  if (target !== categoryType && findFolderById(tree, target) === null) {
    return { sent: false, status: 'target_folder_missing', target_folder_id: target,
      asset_scope_type: scope, root_category_type: categoryType,
      next: '目标文件夹不在该库的文件夹树里，没有发送任何请求。先重读文件夹树拿到真实 folder_id；'
        + `要把资产放回库根目录，把 target_folder_id 传成 ${categoryType}。` }
  }
  const result = await writeUnderLedger(ledger, key, 'asset_move',
    () => ({ ids, targetFolderId: target, assetScopeType: scope }),
    sent => client.request({ method: 'PUT', path: '/aigc/material/move', body: need(sent) }))
  return { ...result, sent: true, status: 'moved', material_ids: ids, target_folder_id: target,
    asset_scope_type: scope, root_category_type: categoryType,
    next: '移动已被提供方受理。用 jubian_organize 重读一次索引即可看到资产所在的新文件夹；'
      + '同一个 idempotency_key 不会重复发送。' }
}

/**
 * `rename` — rename one asset.
 *
 * The name is sent verbatim unless the caller names an `episode` and
 * `asset_category`, in which case this composes the conventional name exactly as
 * `image_generate` does. Nothing renames anything automatically: a rename is a
 * change to a name a person may already be reading in the console, so it only
 * happens when a caller asks for it.
 * @param client - Jubian transport.
 * @param ledger - Write-path ledger.
 * @param args - `material_id`, `asset_name`, an optional `episode`/`asset_category` pair, and a key.
 * @param deps - Optional naming choices.
 * @returns The rename's outcome and the name that was sent.
 * @throws {JubianError} `INVALID_ARGUMENT` for a missing or unusable argument.
 */
export async function renameMethod(client: JubianClient, ledger: JubianLedger,
  args: FolderMethodArgs, deps: FolderMethodDeps = {}): Promise<Record<string, unknown>> {
  const key = requireKey(args.idempotency_key)
  const recorded = await replayed(ledger, key)
  if (recorded !== null) return recorded
  const materialId = need(args.material_id, 'material_id')
  if (!Number.isSafeInteger(materialId) || materialId < 1) {
    throw new JubianError('INVALID_ARGUMENT', 'material_id')
  }
  const name = args.episode === undefined
    ? need(args.asset_name, 'asset_name').trim()
    : composedAssetName(args.episode, need(args.asset_category, 'asset_category'),
      need(args.asset_name, 'asset_name'), deps.naming ?? resolveNaming())
  if (!name) throw new JubianError('INVALID_ARGUMENT', 'asset_name')
  const result = await writeUnderLedger(ledger, key, 'asset_rename',
    () => ({ id: materialId, assetName: name }),
    sent => client.request({ method: 'PUT', path: '/aigc/material/reName', body: need(sent) }))
  return { ...result, sent: true, status: 'renamed', material_id: materialId, asset_name: name,
    next: '改名已被提供方受理。它只改显示名称，不改图片、不改 id，也不会把资产搬到别的类别；'
      + '要换类别需要重新生成资产。用 jubian_organize 重读索引确认。' }
}
