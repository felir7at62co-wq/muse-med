/** Publish source identities from complete, current production-card readbacks. */
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { storyboardMaterials } from '@deepseek-ai/dsh-jubian-api'
import { productionHash } from './production-plan.ts'
import type { ProductionPlan } from './production-types.ts'

/** Actual free-write receipt retained for one package. */
export interface ProductionSourceReceipt {
  readonly storyboard_id: number
  readonly snapshot_sha256: string
}

/** Native parser's current editable-card identity and material snapshot. */
export interface ProductionSourceCard {
  readonly sha256: string
  readonly card: { readonly script_id: number; readonly snapshot: Record<string, unknown>; readonly model_config: Record<string, unknown> }
}

/** Result of publishing source facts; none of these states approves media. */
export type ProductionManifestResult = {
  status: 'published' | 'unchanged'
  path: string
  sha256: string
} | {
  status: 'not_published' | 'failed'
  path: string
  reason: string
}

/** Canonical source manifest consumed by the episode renderer.
 * @param plan - Current production plan, whose package order determines source numbers.
 * @returns The manifest path in the plan's project.
 */
export function productionManifestPath(plan: ProductionPlan): string {
  return join(plan.project_dir, 'episode_packages', String(plan.episode).padStart(2, '0'), 'package.json')
}

/** Write a complete source manifest after fresh native-card and input checks.
 * @param plan - Saved, fingerprint-checked source plan.
 * @param planPath - Exact saved plan path used by this publication.
 * @param receipts - Successful free-write receipts; unknown results must not be supplied.
 * @param readCard - Read the actual native card through its configured transport.
 * @param checkInputs - Return a reason when project, source or model changed, otherwise undefined.
 * @param signal - Cancels reads and prevents publication after the caller stops.
 * @returns Source facts or an explicit refusal; filesystem and transport errors are reported by the caller.
 */
export async function publishProductionManifest(plan: ProductionPlan, planPath: string,
  receipts: Readonly<Record<string, ProductionSourceReceipt>>, readCard: (id: number) => Promise<ProductionSourceCard>,
  checkInputs: () => Promise<string | undefined>, signal: AbortSignal): Promise<ProductionManifestResult> {
  const path = productionManifestPath(plan)
  const refuse = (reason: string): ProductionManifestResult => ({ status: 'not_published', path, reason })
  if (plan.packages.length === 0 || plan.packages.some((pack, index) => pack.index !== index + 1
    || pack.shots.length === 0 || pack.shots.some(shot => !Number.isSafeInteger(shot) || shot < 1))) {
    return refuse('package_plan_invalid')
  }
  signal.throwIfAborted()
  const root = await realpath(plan.project_dir)
  const parent = join(root, 'episode_packages'), directory = join(parent, String(plan.episode).padStart(2, '0'))
  const target = join(directory, 'package.json')
  const inspect = async () => {
    const directories = new Map<string, string>()
    for (const entry of [root, parent, directory, target]) {
      const info = await lstat(entry).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT' && entry !== root) return undefined
        throw error
      })
      if (info && (info.isSymbolicLink() || (entry === target ? !info.isFile() : !info.isDirectory()))) {
        throw new Error('制作来源清单目标不允许符号链接或不匹配的文件类型。')
      }
      if (info && entry !== target) directories.set(entry, `${info.dev}:${info.ino}`)
    }
    return directories
  }
  const readTargetHash = async (): Promise<string | undefined> => {
    try { return productionHash(await readFile(target)) }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
  }
  const before = await inspect()
  const original = await readTargetHash()
  const cards = new Set<number>()
  const tasks = []
  for (const pack of plan.packages) {
    signal.throwIfAborted()
    const receipt = receipts[String(pack.index)]
    if (receipt === undefined || cards.has(receipt.storyboard_id)) return refuse('package_receipts_incomplete')
    cards.add(receipt.storyboard_id)
    const current = await readCard(receipt.storyboard_id)
    if (current.sha256 !== receipt.snapshot_sha256) return refuse('current_card_changed')
    if (current.card.script_id !== plan.script_id || Number(current.card.snapshot.episodeId) !== plan.episode_id
      || Number(current.card.snapshot.episodeCount) !== plan.episode) return refuse('card_project_changed')
    if (typeof current.card.model_config.prompt !== 'string') return refuse('card_prompt_unavailable')
    const materialFields = ['materialAssetId', 'assetId', 'materialKey', 'materialType', 'materialUrl', 'fileName', 'sortOrder', 'audioDuration']
    tasks.push({ index: pack.index, name: pack.name, shots: pack.shots, requested_duration: pack.duration,
      prompt: current.card.model_config.prompt, storyboard_id: receipt.storyboard_id, snapshot_sha256: current.sha256,
      material_bindings: storyboardMaterials(current.card.snapshot).materials.map(item => Object.fromEntries(materialFields
        .filter(field => item[field] !== undefined).map(field => [field, item[field]]))) })
  }
  const issue = await checkInputs()
  if (issue !== undefined) return refuse(issue)
  signal.throwIfAborted()
  if (await realpath(plan.project_dir) !== root) return refuse('manifest_target_changed')
  const after = await inspect()
  if ([...before].some(([entry, identity]) => after.get(entry) !== identity)) return refuse('manifest_target_changed')
  const content = JSON.stringify({ version: 1, operation: 'muse_production', mode: 'advisory', media_acceptance: false,
    episode: String(plan.episode).padStart(2, '0'), script_id: plan.script_id, episode_id: plan.episode_id,
    plan_path: planPath, plan_fingerprint: plan.fingerprint, source_path: plan.source_path,
    source_sha256: plan.source_sha256, model: plan.model, video_tasks: tasks }, null, 2) + '\n'
  await mkdir(directory, { recursive: true, mode: 0o700 })
  signal.throwIfAborted()
  const previous = await readTargetHash()
  signal.throwIfAborted()
  if (previous !== original) return refuse('manifest_target_changed')
  if (previous === productionHash(content)) return { status: 'unchanged', path, sha256: previous }
  await writeFileAtomic(target, content, { mode: 0o600, dirMode: 0o700 })
  return { status: 'published', path, sha256: productionHash(content) }
}
