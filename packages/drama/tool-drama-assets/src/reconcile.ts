/**
 * The comparison itself: what the remote project already contains against what
 * the manifest records.
 *
 * This is a port of the pipeline's `_tools/asset_reconcile.py`, and the port is
 * field-for-field on purpose. Its evidence file is read by two other programs —
 * the workspace's `_tools/asset_reconcile_report.py` and the host's
 * paid-generation gate — so a name, a type or a verdict that drifts is a silent
 * failure in a check whose whole job is to stop a silent failure.
 *
 * Three judgements live here, and each is the pipeline's own, not this package's:
 * a remote asset exists when `asset/list` returned it with `delFlag == "0"`; a
 * remote asset is in use when `material/list` carried `isUsed == 1` and
 * `hsAssetStatus == "Active"`; and an unregistered asset releases a paid
 * generation only when a person registered it or ignored it with a reason.
 *
 * @module @deepseek-ai/dsh-tool-drama-assets/reconcile
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { JubianClient } from '@deepseek-ai/dsh-jubian'
import { JubianError } from '@deepseek-ai/dsh-jubian'
import { MANIFEST_FILE, manifestAssetIds, readManifest } from './manifest.ts'
import { readRemoteAssets, readRemoteMaterials } from './remote.ts'
import type { DanglingItem, Disposition, Dispositions, Manifest, ReconcileReport, RemoteAsset,
  RemoteMaterial, UnregisteredItem } from './types.ts'

/** Why a dangling entry is reported, in the pipeline's own words. */
const DANGLING_WHY = '清单里有这条记录，远端 asset/list 里没有它（可能在别的 scriptId 或已被删）'

/** The directory the pipeline's evidence lives in, below one project root. */
export const PROBE_DIR = '_probe'

/** The evidence file the host gate reads, below {@link PROBE_DIR}. */
export const EVIDENCE_FILE = 'asset-reconcile.json'

/** China Standard Time, the zone every stamp this package writes carries. */
const CN_OFFSET = '+08:00'
const CN_OFFSET_MS = 8 * 60 * 60 * 1000

/** The statuses a disposition may hold that release a paid generation. */
const RELEASING = new Set(['registered', 'ignored'])
/**
 * The paid-generation policy this evidence records.
 *
 * These are protocol constants, not deployment choices: they describe the route
 * the pipeline buys on, and the report exists so the host gate reads the same
 * numbers the pipeline priced.
 */
export const POLICY = {
  image_channel: 'KU_AI',
  image_unit_price_cny: 0.12,
  max_attempts_per_asset: 3,
  worst_case_cny_per_asset: 0.36,
  cross_project_reuse: '手动：先跑 jubian-asset-library 技能检索，结论写进本文件的 cross_project_note',
} as const

/**
 * The current moment as the pipeline stamps it: ISO seconds with the `+08:00` offset.
 * @param now - The instant to stamp; defaults to the current one.
 * @returns The stamp the evidence file carries.
 */
export function chinaStamp(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + CN_OFFSET_MS)
  return `${shifted.toISOString().slice(0, 19)}${CN_OFFSET}`
}

/**
 * The evidence file one project holds.
 * @param projectDir - Resolved project directory.
 * @returns The absolute path of `_probe/asset-reconcile.json` below it.
 */
export function evidencePath(projectDir: string): string {
  return join(projectDir, PROBE_DIR, EVIDENCE_FILE)
}

/**
 * One remote material's evidence row, filled from the material and then from the alive asset row.
 *
 * The material row answers first for every field, and the asset row is only the
 * fallback: a material that names its own category keeps it even when the asset
 * row disagrees. A field neither row carries is written as null, which is what
 * the pipeline's own report prints for it.
 * @param assetId - The asset the material belongs to.
 * @param material - The used material row.
 * @param asset - The alive asset row for the same id, absent when the asset was removed.
 * @returns The row the evidence lists.
 */
function unregisteredItem(assetId: number, material: RemoteMaterial,
  asset: RemoteAsset | undefined): UnregisteredItem {
  return {
    asset_id: assetId,
    material_id: material.material_id,
    name: material.name ?? asset?.name ?? null,
    asset_type: material.asset_type ?? asset?.asset_type ?? null,
    is_used: 1,
    hs_asset_status: 'Active',
    url: material.url ?? asset?.url ?? null,
    create_time: material.create_time ?? asset?.create_time ?? null,
  }
}

/** The ids of the assets the remote project still holds: rows carrying `delFlag == "0"`. */
function aliveIds(assets: RemoteAsset[]): Set<number> {
  return new Set(assets.filter(asset => asset.del_flag === '0').map(asset => asset.asset_id))
}

/**
 * The used-and-active materials of assets the remote project still holds, one per
 * asset id, first row wins.
 *
 * A removed asset stays out even when a material still points at it: the pipeline's
 * rule pairs `isUsed == 1` with `hsAssetStatus == "Active"` on a project whose asset
 * list still carries the row, and an asset with `delFlag` set is not one.
 * @param materials - Every material of the project's subject setting.
 * @param alive - The asset ids the project still holds.
 * @returns The used material per used asset id.
 */
function usedByAsset(materials: RemoteMaterial[], alive: Set<number>): Map<number, RemoteMaterial> {
  const used = new Map<number, RemoteMaterial>()
  for (const material of materials) {
    if (material.asset_id === null || !alive.has(material.asset_id)) continue
    if (material.is_used && material.hs_asset_status === 'Active' && !used.has(material.asset_id)) {
      used.set(material.asset_id, material)
    }
  }
  return used
}

/** The manifest records whose asset id the remote project does not hold. */
function danglingOf(manifest: Manifest, alive: Set<number>): DanglingItem[] {
  const dangling: DanglingItem[] = []
  for (const record of [...manifest.items, ...manifest.lead_readonly_records]) {
    const id = record['jubian_asset_id']
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || alive.has(id)) continue
    const stableId = record['stable_id']
    const name = record['name']
    dangling.push({ stable_id: typeof stableId === 'string' ? stableId : null, jubian_asset_id: id,
      name: typeof name === 'string' ? name : null, why: DANGLING_WHY })
  }
  return dangling
}

/**
 * The disposition map this run carries: the previous one, plus a pending entry per
 * unregistered asset, plus an automatic `registered` for every asset the manifest
 * now records.
 *
 * The automatic entry is what closes the loop: an asset a person registered in
 * the manifest is recognized on the next run, and the note they had written is
 * kept rather than overwritten.
 * @param unregistered - This run's unregistered rows.
 * @param known - Every asset id the manifest declares.
 * @param previous - The dispositions the previous evidence carried.
 * @returns Every disposition, keyed by asset id as text.
 */
function carryDispositions(
  unregistered: UnregisteredItem[],
  known: Set<number>,
  previous: Dispositions,
): Dispositions {
  const dispositions: Dispositions = { ...previous }
  for (const item of unregistered) {
    const key = String(item.asset_id)
    dispositions[key] ??= { status: 'pending', note: '' }
  }
  for (const [key, disposition] of Object.entries(dispositions)) {
    if (known.has(Number(key))) dispositions[key] = { status: 'registered', note: disposition.note }
  }
  return dispositions
}

/**
 * The two dispositions that still refuse a paid generation: no decision yet, and
 * an `ignored` decision that states no reason.
 * @param dispositions - Every disposition the evidence carries.
 * @returns The blocking asset ids and the ignored ids whose note is empty.
 */
export function deriveVerdicts(dispositions: Dispositions): {
  blocking: number[]
  ignored_without_note: number[]
} {
  const blocking: number[] = []
  const ignoredWithoutNote: number[] = []
  for (const [key, disposition] of Object.entries(dispositions)) {
    if (!RELEASING.has(disposition.status)) blocking.push(Number(key))
    if (disposition.status === 'ignored' && !disposition.note.trim()) ignoredWithoutNote.push(Number(key))
  }
  return { blocking, ignored_without_note: ignoredWithoutNote }
}

/**
 * The unregistered rows, in ascending asset id order.
 *
 * The evidence file's `unregistered` list is read positionally by the pipeline's
 * own report and its order is part of what a reader compares between runs, so the
 * order is explicit rather than left to the map's own iteration order.
 * @param used - The used material per used asset id.
 * @param known - Every asset id the manifest declares.
 * @param alive - Every alive asset row, by id.
 * @returns One evidence row per used asset the manifest does not record.
 */
function unregisteredOf(used: Map<number, RemoteMaterial>, known: Set<number>,
  alive: Map<number, RemoteAsset>): UnregisteredItem[] {
  const ids = [...used.keys()].filter(id => !known.has(id)).sort((left, right) => left - right)
  return ids.map(id => unregisteredItem(id, used.get(id) as RemoteMaterial, alive.get(id)))
}

/** Whether a report whose verdicts are known may release a paid asset creation. */
function isReady(blocking: number[], ignoredWithoutNote: number[]): boolean {
  return blocking.length === 0 && ignoredWithoutNote.length === 0
}

/**
 * Compare one project's remote assets against its manifest and return the report.
 *
 * Reading only: both remote calls are the provider's own list endpoints.
 * @param client - Jubian transport.
 * @param projectDir - Resolved project directory holding the manifest.
 * @param previous - The previous evidence, whose dispositions and cross-project note are carried forward.
 * @param now - The instant to stamp the report with; defaults to the current one.
 * @returns The evidence document, without having written it.
 * @throws {JubianError} `CONTRACT_CHANGED` for a manifest or a remote page this comparison cannot read.
 */
export async function buildReport(client: JubianClient, projectDir: string, previous: Partial<ReconcileReport>,
  now: Date = new Date()): Promise<ReconcileReport> {
  const manifest = await readManifest(projectDir)
  const known = manifestAssetIds(manifest)
  const assets = await readRemoteAssets(client, manifest.script_id)
  const materials = await readRemoteMaterials(client, manifest.script_id)
  const alive = aliveIds(assets)
  const used = usedByAsset(materials, alive)
  const aliveByAsset = new Map(assets.filter(asset => alive.has(asset.asset_id))
    .map(asset => [asset.asset_id, asset]))
  const unregistered = unregisteredOf(used, known, aliveByAsset)
  const dispositions = carryDispositions(unregistered, known, previous.disposition ?? {})
  const { blocking, ignored_without_note: ignoredWithoutNote } = deriveVerdicts(dispositions)
  const dangling = danglingOf(manifest, alive)

  return {
    script_id: manifest.script_id,
    ran_at: chinaStamp(now),
    source: { asset_list_rows: assets.length, material_list_rows: materials.length,
      remote_alive: alive.size, remote_used: used.size },
    manifest: { items: manifest.items.length, lead_readonly_records: manifest.lead_readonly_records.length,
      asset_ids: known.size },
    matched: used.size - unregistered.length,
    unregistered,
    dangling,
    disposition: dispositions,
    blocking,
    ignored_without_note: ignoredWithoutNote,
    ready: isReady(blocking, ignoredWithoutNote),
    policy: POLICY,
    cross_project_note: previous.cross_project_note ?? '',
  }
}

/** Write one text file atomically beside its destination directory. */
async function writeAtomic(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, body, 'utf8')
  await rename(temporary, path)
}

/** Serialize one report as the evidence file spells it: two-space indent, no ASCII escaping, one trailing newline. */
function evidenceText(report: ReconcileReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

/**
 * Read the evidence a project already holds, or an empty document when it holds none.
 *
 * An unreadable evidence file is a defect rather than an empty one: a comparison
 * that treated it as absent would silently drop every disposition a person had
 * already written.
 * @param projectDir - Resolved project directory.
 * @returns The parsed evidence, or an empty object when there is no file.
 * @throws {JubianError} `CONTRACT_CHANGED` when the file exists but is not a JSON object.
 */
export async function readEvidence(projectDir: string): Promise<Partial<ReconcileReport> & Partial<DisposedEvidence>> {
  const path = evidencePath(projectDir)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch { return {} }
  let document: unknown
  try {
    document = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown
  } catch { throw new JubianError('CONTRACT_CHANGED', `${path} 不是合法 JSON`) }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new JubianError('CONTRACT_CHANGED', `${path} 顶层不是 JSON 对象`)
  }
  return document as Partial<ReconcileReport> & Partial<DisposedEvidence>
}

/**
 * Reconcile one project and write the evidence the host gate reads.
 * @param client - Jubian transport.
 * @param projectDir - Resolved project directory holding `assets_manifest.json`.
 * @param now - The instant to stamp the report with; defaults to the current one.
 * @returns The written report.
 * @throws {JubianError} `CONTRACT_CHANGED` for a manifest, a remote page, or existing evidence this cannot read.
 */
export async function reconcileProject(client: JubianClient, projectDir: string,
  now: Date = new Date()): Promise<ReconcileReport> {
  const previous = await readEvidence(projectDir)
  const report = await buildReport(client, projectDir, previous, now)
  await writeAtomic(evidencePath(projectDir), evidenceText(report))
  return report
}

/** The evidence after one disposition was written: the file as it now stands, plus the recomputed verdicts. */
export type DisposedEvidence = Partial<ReconcileReport> & {
  /** Every disposition the evidence now carries. */
  disposition: Dispositions
  /** Unregistered asset ids with no decision yet. */
  blocking: number[]
  /** Ignored asset ids whose note is empty. */
  ignored_without_note: number[]
  /** Whether the evidence now releases a paid asset creation. */
  ready: boolean
}

/**
 * Record one person's disposition of one unregistered asset and recompute the verdicts.
 *
 * This touches no remote endpoint: the comparison it edits was made when the
 * evidence was written, and re-running it here would spend a network round trip
 * on a decision a person already made.
 * @param projectDir - Resolved project directory.
 * @param assetId - The unregistered asset the disposition is about.
 * @param status - `registered` or `ignored`.
 * @param note - Why the asset is not needed; required and non-empty for `ignored`.
 * @returns The evidence as written, minus the comparison fields this call does not recompute.
 * @throws {JubianError} `INVALID_ARGUMENT` for a missing or unusable argument,
 *   `CONTRACT_CHANGED` when the existing evidence cannot be read.
 */
export async function disposeAsset(projectDir: string, assetId: number, status: Disposition['status'],
  note: string): Promise<DisposedEvidence> {
  if (!Number.isSafeInteger(assetId) || assetId < 1) {
    throw new JubianError('INVALID_ARGUMENT', `asset_id 必须是正整数，收到 ${String(assetId)}`)
  }
  if (status !== 'registered' && status !== 'ignored') {
    throw new JubianError('INVALID_ARGUMENT', `status 必须是 registered 或 ignored，收到 ${String(status)}`)
  }
  if (status === 'ignored' && !note.trim()) {
    throw new JubianError('INVALID_ARGUMENT', 'status=ignored 必须带非空 note：写清为什么这个资产不需要')
  }
  const evidence = await readEvidence(projectDir)
  const dispositions: Dispositions = { ...(evidence.disposition ?? {}) }
  dispositions[String(assetId)] = { status, note }
  const { blocking, ignored_without_note: ignoredWithoutNote } = deriveVerdicts(dispositions)
  const updated: DisposedEvidence = { ...evidence, disposition: dispositions, blocking,
    ignored_without_note: ignoredWithoutNote, ready: isReady(blocking, ignoredWithoutNote) }
  await writeAtomic(evidencePath(projectDir), evidenceText(updated as ReconcileReport))
  return updated
}

/**
 * The project directory one call names, as an absolute path.
 * @param projectDir - The argument as the model passed it.
 * @returns The resolved project directory.
 * @throws {JubianError} `INVALID_ARGUMENT` when the argument is missing or blank.
 */
export function resolveProjectDir(projectDir: string | undefined): string {
  const trimmed = projectDir?.trim()
  if (!trimmed) {
    throw new JubianError('INVALID_ARGUMENT',
      `project_dir 必填：含 ${MANIFEST_FILE} 的项目根目录绝对路径`)
  }
  return resolve(trimmed)
}
