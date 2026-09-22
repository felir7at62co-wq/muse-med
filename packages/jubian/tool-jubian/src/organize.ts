/**
 * The read-only organization view over one project's assets.
 *
 * One call joins three remote reads and the project's own `assets_manifest.json`
 * into the listing a person would otherwise assemble by hand: which episode uses
 * which character, scene and prop, and what each asset's remote identifiers and
 * statuses are. It sends only reads, charges nothing, and reports — never edits —
 * the names that do not yet follow the convention.
 *
 * The local manifest is the episode map because the provider holds no per-asset
 * episode field; the remote reads supply the names, identifiers and statuses the
 * manifest cannot be trusted to have kept current. A remote asset no manifest row
 * names is reported rather than dropped, because that is exactly the asset a
 * caller has lost track of.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { JubianClient } from '@deepseek-ai/dsh-jubian'
import { JubianError } from '@deepseek-ai/dsh-jubian'
import { readAssetList, readFolderTree, readMaterialList, readTaskList } from '@deepseek-ai/dsh-jubian-api'
import type { AssetRow, FolderNode, MaterialRow } from '@deepseek-ai/dsh-jubian-api'
import { ASSET_CATEGORIES, ASSET_CATEGORY_TYPES, auditAssetName, carriedEpisode, categoryOfType,
  declaredCategory, normalizedEpisode } from './naming.ts'
import type { AssetCategory, Naming } from './naming.ts'
import { ASSET_SCOPES } from './folders.ts'
import { need } from './write.ts'

/** Page size every read asks for: the provider's own documented maximum. */
const PAGE_SIZE = 1000

/** Where the index lands inside the project directory unless configured otherwise. */
const DEFAULT_INDEX_PATH = join('_probe', 'asset-index.md')

/** Manifest `type` spellings that belong to one category, in either language the pipeline writes. */
const TYPE_ALIASES: Record<string, AssetCategory> = {
  character: '角色', 角色: '角色',
  scene: '场景', 场景: '场景',
  prop: '道具', 道具: '道具',
}

/** Everything the organization view takes from outside the transport. */
export interface OrganizeOptions {
  /** Resolved naming choices, used by the audit and the episode tokens it reads. */
  naming: Naming
  /** Index path relative to the project directory; defaults to `_probe/asset-index.md`. */
  indexPath?: string
}

/** One asset row of the local manifest, as the index joins on it. */
interface ManifestAsset {
  name: string
  category: AssetCategory
  /** Declared episode numbers, empty for a series-wide master. */
  episodes: string[]
  asset_id: number | null
  material_id: number | null
  official: boolean
  status: string | null
}

/** One asset as the index lists it. */
interface IndexedAsset {
  name: string
  official: boolean
  asset_id: number | null
  material_id: number | null
  /** The status the local manifest recorded. */
  manifest_status: string | null
  /** The provider's own name for this asset, which is what the console lists. */
  remote_name: string | null
  /** The provider's current status for this asset. */
  remote_status: string | null
}

/** One remote name that does not follow the naming convention. */
interface NamingViolation {
  source: 'asset' | 'material'
  id: number
  name: string
  reason: string
}

/**
 * One asset whose provider category disagrees with what its name or its manifest
 * row says it is.
 *
 * This is the defect a creation request leaves behind when it sends `assetType`
 * 1 for every asset: a scene or a prop then sits in the character library. The
 * index reports it; moving or renaming it stays a caller's decision.
 */
interface CategoryMismatch {
  asset_id: number
  name: string | null
  asset_type: number
  /** The category the manifest declares, when the manifest holds this asset. */
  manifest_category: AssetCategory | null
  /** The category the asset's own name declares, when it declares one. */
  declared_category: AssetCategory | null
  expected: AssetCategory
}

/** Read one value as trimmed text, or an empty string when it carries none. */
function text(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** Read one provider or manifest identifier, or null when it is not a positive integer. */
function optionalId(value: unknown): number | null {
  const candidate = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 1 ? candidate : null
}

/** Read one manifest row as a plain object. */
function object(value: unknown, detail: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JubianError('CONTRACT_CHANGED', detail)
  return value as Record<string, unknown>
}

/**
 * Read the project's own asset manifest.
 *
 * The manifest is a durable-file boundary, so its document, its asset array and
 * every row's name, type and episode numbers are validated here: an index built
 * over a half-readable manifest would silently report the wrong episodes.
 * @param projectDir - Resolved project directory.
 * @returns Every declared asset, in manifest order.
 * @throws {JubianError} `CONTRACT_CHANGED` when the file, a row or an episode number cannot be read.
 */
async function readManifest(projectDir: string): Promise<ManifestAsset[]> {
  const path = join(projectDir, 'assets_manifest.json')
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch { throw new JubianError('CONTRACT_CHANGED', `${path} 读不到`) }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as unknown
  } catch { throw new JubianError('CONTRACT_CHANGED', `${path} 不是 JSON`) }
  const document = object(parsed, `${path} 顶层不是 JSON 对象`)
  const rows = Array.isArray(document.items) ? document.items : document.assets
  if (!Array.isArray(rows)) throw new JubianError('CONTRACT_CHANGED', `${path} 缺少 items 资产数组`)
  return rows.map((row) => {
    const record = object(row, `${path} 有资产行不是对象`)
    const name = text(record.name)
    const category = TYPE_ALIASES[text(record.type).toLowerCase()] ?? null
    if (!name || category === null) throw new JubianError('CONTRACT_CHANGED', `${path} 有资产缺少 name 或 type`)
    const episodes: string[] = []
    if (Array.isArray(record.episodes)) {
      for (const declared of record.episodes) {
        const episode = text(declared)
        if (!episode) continue
        const normalized = normalizedEpisode(episode)
        if (normalized === null) {
          throw new JubianError('CONTRACT_CHANGED', `${path} 的 ${name} 集号 ${episode} 不是数字`)
        }
        episodes.push(normalized)
      }
    }
    return { name, category, episodes,
      asset_id: optionalId(record.jubian_asset_id ?? record.asset_id),
      material_id: optionalId(record.jubian_material_id ?? record.material_id),
      official: record.official === true,
      status: text(record.asset_status) || null }
  })
}

/**
 * Read every page of a project's asset list.
 *
 * The endpoint pages, and an index that stopped at the first page would report a
 * project's assets as a fraction of themselves.
 * @param client - Jubian transport.
 * @param scriptId - Project to list.
 * @returns Every asset row the provider holds for the project.
 */
async function readAllAssets(client: JubianClient, scriptId: number): Promise<AssetRow[]> {
  const collected: AssetRow[] = []
  let pageNum = 1
  for (;;) {
    const page = readAssetList((await client.request({ method: 'GET',
      path: `/aigc/asset/list?scriptId=${scriptId}&pageNum=${pageNum}&pageSize=${PAGE_SIZE}` })).data)
    collected.push(...page.rows)
    if (page.rows.length === 0 || collected.length >= page.total) return collected
    pageNum += 1
  }
}

/** One empty category bucket per category the console pages on. */
function emptyBuckets(): Record<AssetCategory, IndexedAsset[]> {
  return { 角色: [], 场景: [], 道具: [] }
}

/** Audit one remote name, recording a violation when it does not conform. */
function audit(name: string, source: 'asset' | 'material', id: number, naming: Naming,
  violations: NamingViolation[]): boolean {
  const verdict = auditAssetName(name, naming)
  if (!verdict.conforming) {
    violations.push({ source, id, name, reason: verdict.reason })
  }
  return verdict.conforming
}

/** Render one markdown table row for an indexed asset. */
function assetRow(asset: IndexedAsset): string {
  return `| ${asset.name} | ${asset.official ? '是' : '否'} | ${asset.asset_id ?? '—'} | `
    + `${asset.material_id ?? '—'} | ${asset.remote_name ?? '—'} | ${asset.remote_status ?? asset.manifest_status ?? '—'} |`
}

/** Render the whole index as markdown, mirroring the value the tool returns. */
function renderMarkdown(index: Record<string, unknown>): string {
  const episodes = index.episodes as {
    label: string
    asset_count: number
    categories: Record<AssetCategory, IndexedAsset[]>
    video_tasks: { task_id: number; task_name: string | null; status: string | null }[]
  }[]
  const series = index.series as Record<AssetCategory, IndexedAsset[]>
  const lines = ['# 资产组织索引', '',
    `- 项目 scriptId：${String(index.script_id)}`,
    `- 素材来源：${String(index.source_manifest)}`,
    `- 命名规范：${String(index.convention)}`, '']
  const section = (title: string, categories: Record<AssetCategory, IndexedAsset[]>): void => {
    lines.push(`## ${title}`, '')
    for (const category of ASSET_CATEGORIES) {
      const rows = categories[category]
      if (rows.length === 0) continue
      lines.push(`### ${category}`, '',
        '| 名称 | 正式 | asset_id | material_id | 远端名 | 状态 |', '|---|---|---|---|---|---|',
        ...rows.map(assetRow), '')
    }
  }
  for (const episode of episodes) {
    section(`${episode.label}（本集资产 ${String(episode.asset_count)} 项，视频任务 ${String(episode.video_tasks.length)} 个）`,
      episode.categories)
  }
  section('全剧母版（未标注集号的资产）', series)
  const unmatched = index.unmatched_remote_assets as { asset_id: number; name: string | null }[]
  lines.push('## 未匹配的远端资产', '',
    ...(unmatched.length === 0 ? ['（无：每个远端资产都在清单里有对应行）'] : unmatched.map(
      asset => `- ${asset.asset_id} ${asset.name ?? '（无名称）'}`)), '')
  const violations = index.naming_violations as NamingViolation[]
  lines.push('## 命名审计', '',
    `共检查 ${String(index.naming_checked)} 个远端名称，${String(violations.length)} 个不符合规范。`, '',
    ...(violations.length === 0 ? [] : violations.map(
      item => `- [${item.source} ${String(item.id)}] ${item.name} —— ${item.reason}`)), '')
  const folders = index.folders as Record<AssetCategory, FolderNode[]>
  const flatten = (nodes: readonly FolderNode[], depth: number): string[] => nodes.flatMap(node =>
    [`${'  '.repeat(depth)}- ${node.name ?? '（无名称）'}（folder_id=${String(node.folder_id)}）`,
      ...flatten(node.children, depth + 1)])
  lines.push('## 文件夹', '', `库范围：${String(index.folder_scope)}`, '')
  for (const category of ASSET_CATEGORIES) {
    lines.push(`### ${category}库`, '',
      ...(folders[category].length === 0 ? ['（无文件夹）'] : flatten(folders[category], 0)), '')
  }
  const mismatches = index.category_mismatches as CategoryMismatch[]
  lines.push('## 类别审计', '',
    `共 ${String(mismatches.length)} 个资产的类别号与它自己的名字或清单声明不一致。`, '',
    ...(mismatches.length === 0 ? [] : mismatches.map(item =>
      `- asset ${String(item.asset_id)} ${item.name ?? '（无名称）'}：assetType=${String(item.asset_type)}，`
        + `应为 ${item.expected}（清单声明 ${item.manifest_category ?? '未登记'}，名字声明 `
        + `${item.declared_category ?? '未声明'}）`)), '')
  lines.push('> 类别不一致是历史遗留的创建请求写错了 assetType。这里只报告：'
    + '改类别要重新生成资产，改名要用 jubian_asset rename，都需要用户明确同意后才执行。')
  return `${lines.join('\n')}\n`
}

/** Write one text file atomically inside its destination directory. */
async function atomicWriteText(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, body, 'utf8')
  await rename(temporary, path)
}

/**
 * Build one project's asset index without changing anything remote.
 * @param client - Jubian transport.
 * @param args - `script_id` and `project_dir` are required.
 * @param options - Resolved naming choices and the index path inside the project.
 * @returns The episode-by-category index, the naming audit, and the index file's path.
 * @throws {JubianError} `INVALID_ARGUMENT` for a missing argument, `CONTRACT_CHANGED` for a manifest
 *   that cannot be read or an index path that would leave the project directory.
 */
export async function organizeMethod(client: JubianClient, args: {
  script_id?: number | undefined
  project_dir?: string | undefined
}, options: OrganizeOptions): Promise<Record<string, unknown>> {
  const scriptId = need(args.script_id, 'script_id')
  const projectRoot = resolve(need(args.project_dir, 'project_dir'))
  const manifest = await readManifest(projectRoot)
  const assets = await readAllAssets(client, scriptId)
  const materials = readMaterialList((await client.request({ method: 'GET',
    path: `/aigc/material/list?scriptId=${scriptId}&isUsed=1&pageNum=1&pageSize=${PAGE_SIZE}` })).data)
  const tasks = readTaskList((await client.request({ method: 'GET',
    path: `/admin/aigc/video/task/list?scriptId=${scriptId}&taskType=1&pageNum=1` })).data)

  const assetById = new Map(assets.map(row => [row.asset_id, row]))
  const materialByAssetId = new Map<number, MaterialRow>()
  for (const row of materials.rows) {
    if (row.asset_id !== null) materialByAssetId.set(row.asset_id, row)
  }

  const buckets = new Map<string, Record<AssetCategory, IndexedAsset[]>>()
  const series = emptyBuckets()
  const matched = new Set<number>()
  const manifestByAssetId = new Map<number, ManifestAsset>()
  for (const item of manifest) {
    const remote = item.asset_id === null ? undefined : assetById.get(item.asset_id)
    const material = item.asset_id === null ? undefined : materialByAssetId.get(item.asset_id)
    if (item.asset_id !== null) {
      matched.add(item.asset_id)
      manifestByAssetId.set(item.asset_id, item)
    }
    const entry: IndexedAsset = { name: item.name, official: item.official, asset_id: item.asset_id,
      material_id: item.material_id ?? material?.material_id ?? null, manifest_status: item.status,
      remote_name: remote?.name ?? null, remote_status: material?.status ?? null }
    if (item.episodes.length === 0) {
      series[item.category].push(entry)
      continue
    }
    for (const episode of item.episodes) {
      const bucket = buckets.get(episode) ?? emptyBuckets()
      bucket[item.category].push(entry)
      buckets.set(episode, bucket)
    }
  }

  const violations: NamingViolation[] = []
  let checked = 0
  for (const row of assets) {
    if (row.name === null) continue
    checked += 1
    audit(row.name, 'asset', row.asset_id, options.naming, violations)
  }
  for (const row of materials.rows) {
    if (row.name === null) continue
    checked += 1
    audit(row.name, 'material', row.material_id, options.naming, violations)
  }

  // A creation request that sent one `assetType` for every asset leaves scenes
  // and props inside the character library. The manifest's declared category and
  // the asset's own name are the two independent witnesses; either one disagreeing
  // with the provider's number is the defect.
  const mismatches: CategoryMismatch[] = []
  for (const row of assets) {
    const remoteType = categoryOfType(row.asset_type)
    if (remoteType === null) continue
    const declared = declaredCategory(row.name ?? '', options.naming)
    const expected = manifestByAssetId.get(row.asset_id)?.category ?? declared
    if (expected === null || expected === remoteType) continue
    mismatches.push({ asset_id: row.asset_id, name: row.name,
      asset_type: ASSET_CATEGORY_TYPES[remoteType],
      manifest_category: manifestByAssetId.get(row.asset_id)?.category ?? null,
      declared_category: declared, expected })
  }

  const folders: Record<AssetCategory, FolderNode[]> = { 角色: [], 场景: [], 道具: [] }
  for (const category of ASSET_CATEGORIES) {
    folders[category] = readFolderTree((await client.request({ method: 'GET',
      path: `/aigc/assetFolder/tree?assetScopeType=${ASSET_SCOPES.personal}`
        + `&rootCategoryType=${ASSET_CATEGORY_TYPES[category]}` })).data)
  }

  const tasksByEpisode = new Map<string, { task_id: number; task_name: string | null; status: string | null }[]>()
  for (const task of tasks.rows) {
    const token = task.task_name === null ? null : carriedEpisode(task.task_name, options.naming)
    if (token === null || token === options.naming.seriesLabel) continue
    const key = token.slice(2)
    const rows = tasksByEpisode.get(key) ?? []
    rows.push({ task_id: task.task_id, task_name: task.task_name, status: task.status })
    tasksByEpisode.set(key, rows)
  }

  const episodeKeys = [...new Set([...buckets.keys(), ...tasksByEpisode.keys()])].sort()
  const episodes = episodeKeys.map((key) => {
    const categories = buckets.get(key) ?? emptyBuckets()
    return { episode: key, label: `EP${key}`, categories,
      asset_count: ASSET_CATEGORIES.reduce((total, category) => total + categories[category].length, 0),
      video_tasks: tasksByEpisode.get(key) ?? [] }
  })

  const indexPath = resolve(projectRoot, options.indexPath ?? DEFAULT_INDEX_PATH)
  if (!indexPath.startsWith(`${projectRoot}${sep}`)) {
    throw new JubianError('CONTRACT_CHANGED', '索引路径必须落在项目目录内')
  }
  const index: Record<string, unknown> = { script_id: scriptId, project_dir: projectRoot,
    source_manifest: join(projectRoot, 'assets_manifest.json'),
    convention: `EP{两位集数}${options.naming.separator}{类别}${options.naming.separator}{名称}`
      + `，跨集母版用 ${options.naming.seriesLabel}`,
    episodes, series,
    unmatched_remote_assets: assets.filter(row => !matched.has(row.asset_id))
      .map(row => ({ asset_id: row.asset_id, name: row.name })),
    naming_checked: checked, naming_violations: violations,
    folders, folder_scope: `个人资产（assetScopeType=${ASSET_SCOPES.personal}）`,
    category_mismatches: mismatches,
    video_tasks_total: tasks.total, index_path: indexPath,
    next: '这是只读视图：没有重命名、没有移动、没有改动任何远端资产。'
      + '不符合规范的名字与类别不一致的资产只在这里报告——批量改名或搬家需要用户明确同意，'
      + `再用 jubian_asset rename / create_folder / move 执行。索引文件已写到 ${indexPath}。` }
  await atomicWriteText(indexPath, renderMarkdown(index))
  return index
}
