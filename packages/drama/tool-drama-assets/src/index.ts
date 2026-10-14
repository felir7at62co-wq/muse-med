/**
 * `drama_assets`: the short-drama pipeline's pre-spend asset reconciliation, as
 * one model-facing tool.
 *
 * The pipeline shipped this twice: a skill told the model to run
 * `_tools/asset_reconcile.py` before spending money, and the host's paid-call
 * gate read the evidence that script wrote. The gate is what actually refuses a
 * call, so the comparison it depends on must not be a script the product's users
 * need Python to run. This package owns the comparison; the gate, the evidence
 * file's format, and the verdict it reads are unchanged.
 *
 * The comparison answers a question the manifest cannot: the manifest records
 * what this pipeline generated, while the remote project holds every asset that
 * was ever selected there. A project held a formal asset from three weeks earlier
 * that no manifest row mentioned, a model read the manifest as the inventory, and
 * two paid generations of an asset that already existed were bought. So this tool
 * reads both sides, writes one evidence file, and never writes anything remote.
 *
 * @module @deepseek-ai/dsh-tool-drama-assets
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { JUBIAN_TOKEN_REF, configuredJubianClient, JubianError, type JubianClient } from '@deepseek-ai/dsh-jubian'
import { disposeAsset, evidencePath, reconcileProject, resolveProjectDir } from './reconcile.ts'
import type { DisposedEvidence } from './reconcile.ts'
import { matchPreview } from './matching.ts'
import type { MatchLimits, MatchPreview } from './matching.ts'
import { reusePreview } from './reuse.ts'
import { usagePreview } from './usage.ts'
import type { UsagePreview } from './usage.ts'
import { sharedUsagePreview } from './shared-usage.ts'
import type { SharedUsagePreview } from './shared-usage.ts'
import type { ReusePreview } from './reuse.ts'
import type { DanglingItem, DramaAssetsMethod, ReconcileReport, UnregisteredItem } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-drama-assets'

/** The registries this plugin contributes `drama_assets` to. */
export const inject = ['tools', 'credentials']

/**
 * Plugin config. Every field is a deployment-varying choice: which origin the
 * remote reads go to, how long one read may take, and whether the workspace's own
 * pipeline secret file may stand in for a missing credential-store value. The
 * comparison's own rules — `delFlag`, `isUsed`, `Active`, the policy numbers —
 * are the pipeline's contract and are not configurable.
 */
export interface Config {
  /** Origin override; defaults to the client's own default base URL. */
  baseUrl?: string
  /** Per-call abort budget in milliseconds. */
  timeoutMs?: number
  /** Whether the workspace's own pipeline secret file may stand in for a missing credential-store value; defaults to true. */
  workspaceSecrets?: boolean
  /** Matching and shared-query provider page size, 1–1000; defaults to 1000. */
  matchPageSize?: number
  /** Matching and shared-query page limit per inventory; defaults to 100. */
  matchPageLimit?: number
  /** Matching requirements and query output-row limit per call; defaults to 100. */
  matchRequirementLimit?: number
}

export { workspacePipelineToken } from '@deepseek-ai/dsh-jubian'

/** One call's arguments, exactly as the parameter schema declares them. */
interface DramaAssetsArguments {
  /** The operation to run. */
  method: DramaAssetsMethod
  /** Project root holding `assets_manifest.json`; the file is written below `_probe/` there. */
  project_dir?: string
  /** The unregistered asset a `dispose` call is about. */
  asset_id?: number
  /** Exact shared character identity to query across registered costume and voice versions. */
  character_id?: string
  /** Shared query's explicit output page offset, starting at zero. */
  output_offset?: number
  /** The disposition a `dispose` call writes. */
  status?: string
  /** Why the asset is not needed; required and non-empty for `ignored`. */
  note?: string
  /** match_preview: requirement JSON contained in this project. */
  requirements_path?: string
  /** reuse_preview: optional project-contained per-shot requirement mapping. */
  plan_path?: string
}
/** What one `reconcile` call reports: the evidence it wrote, plus what the model must do next. */
interface DramaAssetsResult {
  /** The operation that ran. */
  readonly method: 'reconcile'
  /** Whether the evidence now releases a paid asset creation. */
  readonly ready: boolean
  /** The reason behind `ready`, in the pipeline's own words. */
  readonly ready_reason: string
  /** Absolute path of the evidence file this call wrote. */
  readonly evidence: string
  /** Project id the remote reads were keyed by. */
  readonly script_id: number
  /** When the comparison ran, with the `+08:00` offset. */
  readonly ran_at: string
  /** How many rows each remote read returned and what the comparison used. */
  readonly source: ReconcileReport['source']
  /** What the manifest declared. */
  readonly manifest: ReconcileReport['manifest']
  /** Used remote assets the manifest also records. */
  readonly matched: number
  /** Remote used-and-active assets the manifest does not record. */
  readonly unregistered: readonly Record<string, unknown>[]
  /** Manifest records whose asset id the remote project does not hold. */
  readonly dangling: readonly Record<string, unknown>[]
  /** Every defect in the manifest's own declarations; non-empty means nothing here is trustworthy. */
  readonly issues: ReconcileReport['issues']
  /** Every disposition the evidence carries. */
  readonly disposition: ReconcileReport['disposition']
  /** Unregistered asset ids with no decision yet. */
  readonly blocking: number[]
  /** Ignored asset ids whose note is empty. */
  readonly ignored_without_note: number[]
  /** The paid-generation policy the gate reads. */
  readonly policy: ReconcileReport['policy']
  /** The cross-project search conclusion a person wrote, carried forward. */
  readonly cross_project_note: string
  /** What to do about what was found, in one Chinese sentence. */
  readonly next: string
}

/** What one `dispose` call reports: the dispositions and verdicts it recomputed. */
interface DramaAssetsDispose {
  /** The operation that ran. */
  readonly method: 'dispose'
  /** The asset whose disposition this call wrote. */
  readonly asset_id: number
  /** Whether the evidence now releases a paid asset creation. */
  readonly ready: boolean
  /** The reason behind `ready`, in the pipeline's own words. */
  readonly ready_reason: string
  /** Absolute path of the evidence file this call wrote. */
  readonly evidence: string
  /** Every disposition the evidence carries. */
  readonly disposition: ReconcileReport['disposition']
  /** Unregistered asset ids with no decision yet. */
  readonly blocking: number[]
  /** Ignored asset ids whose note is empty. */
  readonly ignored_without_note: number[]
  /** Every manifest defect the evidence carries; a disposition never clears one. */
  readonly issues: ReconcileReport['issues']
  /** What this call leaves the caller to do, in one Chinese sentence. */
  readonly next: string
}

/**
 * The reason text for the two verdicts, in the pipeline's own words.
 *
 * A manifest defect is reported first and in full: while the local side of the
 * comparison is unreadable, the two verdict lists below describe what that defect
 * produced, so repairing them would be work on a wrong verdict.
 * @param report - The manifest defects and the two verdict lists the evidence carries.
 * @returns The Chinese reason the host gate reports for the same state.
 */
function readyReason(report: Pick<ReconcileReport, 'blocking' | 'ignored_without_note' | 'issues'>): string {
  const [first] = report.issues
  if (first !== undefined) {
    return `清单本身有 ${String(report.issues.length)} 处必须先修的问题：${first.message}`
  }
  if (report.blocking.length > 0) {
    return `对账里还有 ${String(report.blocking.length)} 条未处置的未登记资产：${report.blocking.join('、')}`
  }
  if (report.ignored_without_note.length > 0) {
    return `这 ${String(report.ignored_without_note.length)} 条判为 ignored 但没写 note：`
      + report.ignored_without_note.join('、')
  }
  return 'ok'
}

/** The one sentence describing what a call leaves the caller to do. */
function nextStep(report: Pick<ReconcileReport, 'ready' | 'blocking' | 'ignored_without_note' | 'dangling' | 'issues'>): string {
  if (report.ready) {
    return report.dangling.length === 0
      ? '证据 ready=true：可以发起付费生图。'
      : `证据 ready=true：可以发起付费生图；但清单里还有 ${String(report.dangling.length)} 条悬空记录需要修。`
  }
  if (report.issues.length > 0) {
    return '证据 ready=false：清单读不全，上面每一条 issues 都要按 message 修好再重跑 reconcile，'
      + '这一轮列出的 unregistered / dangling 都建立在那份读不全的清单上。'
  }
  return '证据 ready=false：付费生图会被宿主钩子拒绝，先按 ready_reason 把未登记的资产逐条处置。'
}

/** One `unregistered` row as the model reads it: the evidence row with absent values spelled as sentinels. */
interface PresentedUnregistered {
  asset_id: number
  material_id: number
  name: string
  asset_type: number
  is_used: number
  hs_asset_status: string
  url: string
  create_time: string
}

/** One `dangling` row as the model reads it. */
interface PresentedDangling {
  stable_id: string
  jubian_asset_id: number
  name: string
  why: string
}

/** One `reconcile` result as the model reads it. */
interface PresentedReconcile extends Omit<DramaAssetsResult, 'unregistered' | 'dangling'> {
  unregistered: PresentedUnregistered[]
  dangling: PresentedDangling[]
}

/** One `dispose` result as the model reads it. */
type PresentedDispose = DramaAssetsDispose

/**
 * Spell one evidence row for the model.
 *
 * The evidence file carries an absent provider field as JSON null, while the tool
 * schema declares plain scalars: the parameter DSL has no nullable scalar, and a
 * model reading `0` or an empty string has the same fact — the provider did not
 * send this field. `asset_type` 0 therefore means "no category number", never a
 * category, because the provider numbers its categories 1, 2 and 3.
 * @param item - One evidence row.
 * @returns The same row with absent values spelled as an empty string or 0.
 */
function presentUnregistered(item: UnregisteredItem): PresentedUnregistered {
  return { asset_id: item.asset_id, material_id: item.material_id, name: item.name ?? '',
    asset_type: item.asset_type ?? 0, is_used: item.is_used, hs_asset_status: item.hs_asset_status,
    url: item.url ?? '', create_time: item.create_time ?? '' }
}

/**
 * Spell one dangling record for the model.
 * @param item - One evidence record.
 * @returns The same record with a missing stable id or name spelled as an empty string.
 */
function presentDangling(item: DanglingItem): PresentedDangling {
  return { stable_id: item.stable_id ?? '', jubian_asset_id: item.jubian_asset_id,
    name: item.name ?? '', why: item.why }
}

/** Assemble one `reconcile` call's result from the evidence it wrote. */
function presentReconcile(report: ReconcileReport, projectDir: string): PresentedReconcile {
  return { method: 'reconcile', ready: report.ready, ready_reason: readyReason(report),
    evidence: evidencePath(projectDir), script_id: report.script_id, ran_at: report.ran_at,
    source: report.source, manifest: report.manifest, matched: report.matched,
    unregistered: report.unregistered.map(presentUnregistered), dangling: report.dangling.map(presentDangling),
    issues: report.issues, disposition: report.disposition, blocking: report.blocking,
    ignored_without_note: report.ignored_without_note, policy: report.policy,
    cross_project_note: report.cross_project_note, next: nextStep(report) }
}

/**
 * Assemble one `dispose` call's result from the evidence as written.
 *
 * The comparison fields are absent rather than defaulted: this call never read the
 * remote project, and a count filled with zeros would read as a comparison that
 * found nothing. `reconcile` is what produces those fields. The manifest defects
 * the evidence carries are reported as they stand, because they are what keeps
 * this call's `ready` false.
 * @param projectDir - Resolved project directory holding the evidence.
 * @param assetId - The asset this call disposed of.
 * @param evidence - The evidence document {@link disposeAsset} wrote.
 * @returns The dispositions, the recomputed verdicts, and the path written to.
 */
function presentDispose(projectDir: string, assetId: number, evidence: DisposedEvidence): DramaAssetsDispose {
  const { disposition, blocking, ignored_without_note: ignoredWithoutNote, issues } = evidence
  return { method: 'dispose', asset_id: assetId, ready: evidence.ready,
    ready_reason: readyReason({ blocking, ignored_without_note: ignoredWithoutNote, issues }),
    evidence: evidencePath(projectDir), disposition, blocking, ignored_without_note: ignoredWithoutNote, issues,
    next: '处置已写入证据：宿主付费钩子下次读到它就会按新的 blocking / ignored_without_note 判定；'
      + '要刷新远端比对结果与 ran_at，再跑一次 reconcile。' }
}

/**
 * Run one `drama_assets` call.
 * @param client - Jubian transport for reconciliation and GET-only matching.
 * @param args - The dispatched arguments.
 * @param limits - Resolved matching-only bounds; omitted calls use the declared defaults.
 * @param signal - Shared query cancellation; other methods retain their existing request behavior.
 * @returns Existing reconciliation results, or a read-only matching preview.
 * @throws {JubianError} `INVALID_ARGUMENT` for a missing argument,
 *   `CONTRACT_CHANGED` for a manifest, a remote page, or existing evidence this call cannot read.
 */
export function runDramaAssets(client: JubianClient, args: DramaAssetsArguments & { method: 'reconcile' }, limits?: MatchLimits, signal?: AbortSignal): Promise<PresentedReconcile>
/**
 * Run one `drama_assets` call.
 * @param client - Jubian transport for reconciliation and GET-only matching.
 * @param args - The dispatched arguments.
 * @param limits - Resolved matching-only bounds; omitted calls use the declared defaults.
 * @param signal - Shared query cancellation; other methods retain their existing request behavior.
 * @returns Existing reconciliation results, or a read-only matching preview.
 * @throws {JubianError} `INVALID_ARGUMENT` for a missing argument,
 *   `CONTRACT_CHANGED` for a manifest, a remote page, or existing evidence this call cannot read.
 */
export function runDramaAssets(client: JubianClient, args: DramaAssetsArguments & { method: 'dispose' }, limits?: MatchLimits, signal?: AbortSignal): Promise<PresentedDispose>
/**
 * Run one `drama_assets` call.
 * @param client - Jubian transport for reconciliation and GET-only matching.
 * @param args - The dispatched arguments.
 * @param limits - Resolved matching-only bounds; omitted calls use the declared defaults.
 * @param signal - Shared query cancellation; other methods retain their existing request behavior.
 * @returns Existing reconciliation results, or a read-only matching preview.
 * @throws {JubianError} `INVALID_ARGUMENT` for a missing argument,
 *   `CONTRACT_CHANGED` for a manifest, a remote page, or existing evidence this call cannot read.
 */
export function runDramaAssets(client: JubianClient, args: DramaAssetsArguments & { method: 'match_preview' }, limits?: MatchLimits, signal?: AbortSignal): Promise<MatchPreview>
/**
 * Run one `drama_assets` call.
 * @param client - Jubian transport for reconciliation and GET-only matching.
 * @param args - The dispatched arguments.
 * @param limits - Resolved matching-only bounds; omitted calls use the declared defaults.
 * @param signal - Shared query cancellation; other methods retain their existing request behavior.
 * @returns Existing reconciliation results, or a read-only matching preview.
 * @throws {JubianError} `INVALID_ARGUMENT` for a missing argument,
 *   `CONTRACT_CHANGED` for a manifest, a remote page, or existing evidence this call cannot read.
 */
export function runDramaAssets(client: JubianClient, args: DramaAssetsArguments & { method: 'reuse_preview' }, limits?: MatchLimits, signal?: AbortSignal): Promise<ReusePreview>
/**
 * Run one `drama_assets` call.
 * @param client - Jubian transport for reconciliation and GET-only matching.
 * @param args - The dispatched arguments.
 * @param limits - Resolved matching-only bounds; omitted calls use the declared defaults.
 * @param signal - Shared query cancellation; other methods retain their existing request behavior.
 * @returns Existing reconciliation results, or a read-only matching preview.
 * @throws {JubianError} `INVALID_ARGUMENT` for a missing argument,
 *   `CONTRACT_CHANGED` for a manifest, a remote page, or existing evidence this call cannot read.
 */
export function runDramaAssets(client: JubianClient, args: DramaAssetsArguments,
  limits?: MatchLimits, signal?: AbortSignal):
Promise<PresentedReconcile | PresentedDispose | MatchPreview | ReusePreview | UsagePreview | SharedUsagePreview>
export async function runDramaAssets(client: JubianClient,
  args: DramaAssetsArguments, limits: MatchLimits = matchLimits({}), signal?: AbortSignal):
Promise<PresentedReconcile | PresentedDispose | MatchPreview | ReusePreview | UsagePreview | SharedUsagePreview> {
  const projectDir = resolveProjectDir(args.project_dir)
  if (args.method === 'shared_usage_preview') return await sharedUsagePreview(client, projectDir,
    { ...(args.asset_id === undefined ? {} : { asset_id: args.asset_id }),
      ...(args.character_id === undefined ? {} : { character_id: args.character_id }),
      ...(args.output_offset === undefined ? {} : { output_offset: args.output_offset }) },
    { pageSize: limits.pageSize, pageLimit: limits.pageLimit, outputLimit: limits.requirementsLimit }, signal)
  if (args.method === 'usage_preview') return await usagePreview(client, projectDir, args.plan_path, args.asset_id, limits.requirementsLimit)
  if (args.method === 'reuse_preview') {
    if (!args.requirements_path) throw new JubianError('INVALID_ARGUMENT', 'reuse_preview 需要 requirements_path。')
    return await reusePreview(client, projectDir, args.requirements_path, args.plan_path, limits)
  }
  if (args.method === 'match_preview') {
    if (!args.requirements_path) throw new JubianError('INVALID_ARGUMENT', 'match_preview 需要 requirements_path。')
    return await matchPreview(client, projectDir, args.requirements_path, limits)
  }
  if (args.method === 'dispose') {
    const { asset_id: assetId, status, note } = args
    if (assetId === undefined || status === undefined) {
      throw new JubianError('INVALID_ARGUMENT', 'drama_assets dispose 需要 asset_id 与 status')
    }
    return presentDispose(projectDir, assetId, await disposeAsset(projectDir, assetId, status, note ?? ''))
  }
  return presentReconcile(await reconcileProject(client, projectDir), projectDir)
}

/** The one sentence every `unregistered` row means, for the tool schema. */
const UNREGISTERED_NOTE = '这类资产剧变远端已经选用，清单里没有；付费生图前必须逐条处置：'
  + '要复用就登记进 assets_manifest.json 再跑一次 reconcile 自动标 registered，'
  + '确认不需要就用 dispose 写 ignored 并说明原因。'

/**
 * One `unregistered` row: remote-used assets the manifest does not record.
 *
 * The evidence file writes an absent provider field as null; this tool result
 * spells it as `0` or an empty string, because the parameter DSL has no nullable
 * scalar and `0` is never a category the provider issues.
 */
const UNREGISTERED_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    asset_id: { type: 'integer', required: true, description: '剧变父资产 ID。' },
    material_id: { type: 'integer', required: true,
      description: '该资产已选用行的材质 ID。' },
    name: { type: 'string', required: true,
      description: '材质行的名字，没有就用资产行的；两行都没有时为空串。' },
    asset_type: { type: 'integer', required: true,
      description: '类别号：1=角色，2=场景，3=道具；两行都没有时为 0。' },
    is_used: { type: 'integer', required: true, description: '材质行的 isUsed，本列表上恒为 1。' },
    hs_asset_status: { type: 'string', required: true,
      description: '材质行的 hsAssetStatus，本列表上恒为 Active。' },
    url: { type: 'string', required: true, description: '材质行或资产行的 URL；都没有时为空串。' },
    create_time: { type: 'string', required: true,
      description: '材质行或资产行的创建时间；都没有时为空串。' },
  },
} as const

/** One `dangling` row: a manifest record the remote project does not hold. */
const DANGLING_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    stable_id: { type: 'string', required: true, description: '清单的 stable_id；没有时为空串。' },
    jubian_asset_id: { type: 'integer', required: true, description: '清单声明的剧变资产 ID。' },
    name: { type: 'string', required: true, description: '清单里的名字；没有时为空串。' },
    why: { type: 'string', required: true, description: '为什么这条算悬空。' },
  },
} as const

/** One `issues` row: a defect in the manifest's own declarations. */
const MANIFEST_ISSUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true,
      description: '稳定的问题代码；对账使用 manifest_items_missing / manifest_items_spelling / lead_records_missing / manifest_record_unreadable，共享用途查询使用库存或身份核对代码。' },
    inventory: { type: 'string', description: 'Shared usage query: affected provider inventory or local identity records.' },
    ids: { type: 'array', items: { type: 'integer' }, description: 'Shared usage query: exact affected asset, material or package IDs.' },
    message: { type: 'string', required: true,
      description: '具体问题说明；对账解释缺失清单键，共享查询解释不完整库存或无法核实的资产身份。' },
  },
} as const

/** One `policy` object: the numbers the host gate and this file both read. */
const POLICY_SCHEMA = {
  type: 'object', additionalProperties: false,
  description: 'reconcile 报告：付费策略，钩子与本文件读到同一组数字。',
  properties: {
    image_channel: { type: 'string', required: true, description: '付费生图走的渠道。' },
    image_unit_price_cny: { type: 'number', required: true, description: '单张价格，元。' },
    max_attempts_per_asset: { type: 'integer', required: true, description: '单张最多重试次数。' },
    worst_case_cny_per_asset: { type: 'number', required: true, description: '单张最坏花费，元。' },
    cross_project_reuse: { type: 'string', required: true, description: '跨项目复用的做法。' },
  },
} as const

/**
 * Model-facing result schema.
 *
 * One flat object holds method-specific fields, which the schema does not require:
 * the parameter DSL rejects
 * `required` inside a `oneOf` branch, so a branch-per-method schema would compile
 * into branches that match nothing. Every field a call does report is required;
 * the fields a method does not report are simply absent from its value, which is
 * what the field descriptions say.
 */
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    method: { type: 'string', required: true, enum: ['reconcile', 'dispose', 'match_preview', 'reuse_preview', 'usage_preview', 'shared_usage_preview'],
      description: '产生本结果的操作；两个方法的字段不同，本 schema 只强制共有字段。' },
    assets: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Current remote parents, distinct package counts and precise identity metadata.' },
    uses: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Remote bound package IDs and real episode identities; missing episode axes remain null.' },
    duplicate_audio_groups: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Same-character/same-period voice candidates with usage-ranked suggestions; never deletion authorization.' },
    coverage: { type: 'object', additionalProperties: true, description: 'Inventory completeness and explicitly unscanned history, other local plans and collaborators’ defaults.' },
    query_complete: { type: 'boolean', description: 'Whether the requested character or asset filter is fully covered; unknown character identities do not imply no uses.' },
    stable_inventory: { type: 'boolean', description: 'Two complete current inventories agree; this is not an atomic provider transaction.' },
    totals: { type: 'object', additionalProperties: true, description: 'Total matching rows before output truncation.' },
    pagination: { type: 'object', additionalProperties: true, description: 'Shared query output_offset, output_limit, next_offset and query_sha256. Read the next offset with the same filters; combine pages only when their query_sha256 matches.' },
    complete: { type: 'boolean', description: 'Only the declared current remote inventory scan; not an atomic absence or deletion guarantee.' },
    delete_allowed: { type: 'boolean', description: 'Shared usage queries never grant deletion authority.' },
    usage_rows: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Current local package or project voice references; never remote binding receipts.' },
    voice_states: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Stable character voice gaps and preserved current references; remote identity and sound remain to verify.' },
    total: { type: 'integer', description: 'Number of matching local references before the result limit.' },
    truncated: { type: 'boolean', description: 'True when a usage query omits rows because of the output limit; query an exact asset_id.' },
    ready: { type: 'boolean',
      description: '证据是否已经可以让宿主钩子放行付费生图：issues 为空、blocking 与 ignored_without_note 都为空才为 true。' },
    ready_reason: { type: 'string', description: 'ready 的判定依据；放行时为 ok。' },
    issues: { type: 'array', required: true,
      description: '当前方法的读取或身份核对问题。reconcile/dispose 非空时 ready=false；shared_usage_preview 按 complete、query_complete 和 coverage 判断覆盖范围，不能把未知计数当作零引用，也不阻止其他独立工作。',
      items: MANIFEST_ISSUE_SCHEMA },
    evidence: { type: 'string',
      description: '本次写入的证据文件绝对路径（<project_dir>/_probe/asset-reconcile.json）；宿主钩子读的就是它。' },
    disposition: { type: 'object', additionalProperties: true,
      description: '每条未登记资产的处置记录，跨次运行保留；值是 {status, note}，'
        + 'status 为 pending / registered / ignored。' },
    blocking: { type: 'array', items: { type: 'integer' },
      description: '还没处置（不是 registered / ignored）的未登记资产 ID；非空即拒绝付费生图。' },
    ignored_without_note: { type: 'array', items: { type: 'integer' },
      description: '判为 ignored 但 note 为空的资产 ID；非空即拒绝付费生图。' },
    next: { type: 'string', required: true, description: '针对本次结果的具体后续操作与范围说明。' },
    status: { type: 'string', enum: ['reuse_ready', 'needs_review', 'missing', 'blocked', 'complete', 'incomplete'], description: 'match_preview 的整体结果；不是审批或付费授权。' },
    search_scope: { type: 'string', enum: ['current_project'], description: '仅当前项目；missing 不表示历史库也没有素材。' },
    source_sha256: { type: 'string', description: '已核对的原文摘要。' },
    fingerprint: { type: 'string', description: 'reuse_preview 的来源、资产版本、适用条件及整卡计划摘要；无审批或执行权限。' },
    apply_allowed: { type: 'boolean', description: '预览恒为 false，只表示本结果不授予写入权限；用户授权后仍可调用原有绑定工具。' },
    groups: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      fingerprint: { type: 'string', required: true }, kind: { type: 'string', required: true, enum: ['character', 'scene', 'voice'] },
      name: { type: 'string', required: true }, identity: { type: 'string', required: true },
      status: { type: 'string', required: true, enum: ['reuse_ready', 'needs_review', 'missing', 'blocked'] },
      requirement_ids: { type: 'array', required: true, items: { type: 'string' } },
      episodes: { type: 'array', required: true, items: { type: 'integer' } },
      conditions: { type: 'array', required: true, items: { type: 'string' } },
      state_or_costume: { type: 'string', required: true },
      candidate_asset_ids: { type: 'array', required: true, items: { type: 'integer' } },
      selected_asset_id: { type: 'integer' }, reason_codes: { type: 'array', required: true, items: { type: 'string' } },
      approval_required: { type: 'boolean', required: true },
      candidates: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        asset_id: { type: 'integer', required: true }, name: { type: 'string', required: true },
        stable_id: { type: 'string', required: true }, state_or_costume: { type: 'string', required: true },
      } } },
    } } },
    shots: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      storyboard_id: { type: 'integer', required: true },
      status: { type: 'string', required: true, enum: ['awaiting_confirmation', 'already_bound', 'blocked'] },
      reason_codes: { type: 'array', required: true, items: { type: 'string' } },
      requirement_ids: { type: 'array', required: true, items: { type: 'string' } },
      selections: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        material_key: { type: 'string', required: true }, asset_id: { type: 'integer', required: true },
      } } },
      before_sha256: { type: 'string' }, after_sha256: { type: 'string' }, apply_allowed: { type: 'boolean', required: true },
    } } },
    read_only: { type: 'boolean', description: 'match_preview 恒为 true。' },
    paid_requests: { type: 'integer', description: 'match_preview 恒为 0。' },
    remote_writes: { type: 'integer', description: 'match_preview 恒为 0。' },
    local_writes: { type: 'integer', description: 'match_preview 恒为 0。' },
    counts: { type: 'object', additionalProperties: false, properties: {
      reuse_ready: { type: 'integer', required: true }, needs_review: { type: 'integer', required: true },
      missing: { type: 'integer', required: true }, blocked: { type: 'integer', required: true },
    } },
    matches: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      id: { type: 'string', required: true }, kind: { type: 'string', required: true, enum: ['character', 'scene', 'voice'] },
      name: { type: 'string', required: true }, status: { type: 'string', required: true, enum: ['reuse_ready', 'needs_review', 'missing', 'blocked'] },
      candidate_asset_ids: { type: 'array', required: true, items: { type: 'integer' } },
      selected_asset_id: { type: 'integer' }, reason_codes: { type: 'array', required: true, items: { type: 'string' } },
      evidence: { type: 'array', required: true, items: { type: 'string' } },
    } } },
    asset_id: { type: 'integer',
      description: 'dispose 报告：本次写入处置的资产 ID；reconcile 不带这个字段。' },
    script_id: { type: 'integer',
      description: 'reconcile 报告：本次读的剧变项目 ID，取自清单的 script_id；dispose 不重新对账，不带这个字段。' },
    ran_at: { type: 'string',
      description: 'reconcile 报告：对账时间（+08:00 的 ISO 时间），证据 24 小时内有效；'
        + 'dispose 沿用证据里的时间但不带这个字段。' },
    source: { type: 'object', additionalProperties: false,
      description: 'reconcile 报告：远端两侧各读回多少行、比对时算作存活/已选用的有多少。',
      properties: {
        asset_list_rows: { type: 'integer', required: true, description: 'asset/list 读回的行数（含已删除）。' },
        material_list_rows: { type: 'integer', required: true, description: 'material/list 读回的行数。' },
        remote_alive: { type: 'integer', required: true, description: 'delFlag == "0" 的资产数。' },
        remote_used: { type: 'integer', required: true,
          description: 'isUsed == 1、hsAssetStatus == "Active" 且资产仍在的资产数。' },
      } },
    manifest: { type: 'object', additionalProperties: false,
      description: 'reconcile 报告：清单这一侧读到了什么。',
      properties: {
        items: { type: 'integer', required: true, description: 'assets_manifest.json 的 items 记录数。' },
        lead_readonly_records: { type: 'integer', required: true, description: 'lead_readonly_records 记录数。' },
        asset_ids: { type: 'integer', required: true, description: '两侧合起来去重后的 jubian_asset_id 数。' },
      } },
    matched: { type: 'integer', description: 'reconcile 报告：远端已选用且清单里也有的资产数。' },
    unregistered: { type: 'array', description: `reconcile 报告。${UNREGISTERED_NOTE}`,
      items: UNREGISTERED_ITEM_SCHEMA },
    dangling: { type: 'array',
      description: 'reconcile 报告：清单里有、远端 asset/list 里没有的记录，需要修。',
      items: DANGLING_ITEM_SCHEMA },
    policy: POLICY_SCHEMA,
    cross_project_note: { type: 'string',
      description: 'reconcile 报告：跨项目检索结论（人工填写），沿用证据里的值。' },
  },
} as const

/** Resolve and validate the matching-only deployment bounds. */
function matchLimits(config: Config): MatchLimits {
  const limits = { pageSize: config.matchPageSize ?? 1000, pageLimit: config.matchPageLimit ?? 100,
    requirementsLimit: config.matchRequirementLimit ?? 100 }
  if (!Object.values(limits).every(value => Number.isSafeInteger(value) && value > 0) || limits.pageSize > 1000) {
    throw new Error('Matching limits must be positive integers; matchPageSize must be at most 1000.')
  }
  return limits
}

/** What the model reads before calling: what each method does, the verdict rule, and what this tool never does. */
const DESCRIPTION = '短剧流水线的付费生成前资产对账（剧变）。'
  + 'reconcile=只读剧变、免费：把「剧变远端这个项目里已选用的资产」与「assets_manifest.json 里写了什么」逐条比一遍，'
  + '产出机读证据 <project_dir>/_probe/asset-reconcile.json。'
  + '判定口径：远端存活 = asset/list 里 delFlag == "0"；已选用 = material/list 里 isUsed == 1 且 hsAssetStatus == "Active"；'
  + 'unregistered = 已选用但清单里没有（不许直接生成，先登记复用或写明不需要）；'
  + 'dangling = 清单里有但远端没有；matched = 两端都有的数量。'
  + 'dispose=给某条 unregistered 写处置：status=registered（已登记进清单）或 ignored（确认不需要，必须带非空 note）；'
  + '只更新证据里的 disposition 并重算 blocking / ignored_without_note / ready，不重新对账、不联网。'
  + 'ready = issues 为空且 blocking 与 ignored_without_note 都为空，宿主侧的付费前置钩子只认这一条，证据 24 小时内有效。'
  + '清单读不全不报错、也不拒绝运行：缺 items 资产数组（或只写在 assets 键下）、缺 lead_readonly_records、'
  + '某条记录不是对象，都写进 issues 并让 ready=false，好让 agent 一次看全所有要修的地方。'
  + '为什么清单不够：清单只记录我们生成过什么，不等于剧变项目里已经有什么——'
  + '2026-09-20 就因为只看清单，给一张项目里早就存在的正式资产重新生成了两次（花掉 1.17 元）。'
  + 'match_preview=只读当前项目人物、场景与已认可声线；需要项目内 requirements_path，返回 reuse_ready/needs_review/missing/blocked 与证据。'
  + '它不写任何文件，不生成、不绑定、不审批；同名不能证明身份，分页不全或来源变化必须 blocked。missing 仅限当前项目，不允许据此直接付费生成。'
  + 'reuse_preview=集中归组并生成只读复用计划；可带 plan_path 预检各镜素材选择，保留无关素材和配置，失败即停止后续预检。'
  + '匹配预览 → 复用建议 → 用户确认 → 模型调用原有 jubian_storyboard.select_assets。'
  + 'reuse_ready、already_bound 和 fingerprint 不是审批；apply_allowed=false 只表示预览不授予写入权限。'
  + '用户授权后可按 shots 的有序 selections 调用原工具，继续实时身份、顺序和回读校验；未授权不得绑定。声线沿 audio_preview → audio_apply。'
  + 'shared_usage_preview=完整查询共享剧变项目的资产、材质、剧集和视频包，按实际绑定汇总不同包的引用数及集数；支持精确asset_id或character_id筛选。重复音频仅在同人物同人生时期归组，先迁移引用再清理；历史任务与其他账号本地计划未扫描，不授予删除权限。'
  + 'usage_preview=读取当前资产清单、项目声音和可选打包结果，按实际父资产/材质ID查询引用位置与缺失声线；支持asset_id筛选，不猜人物、不审批、不绑定、不收费。'
  + '下载成功视频后主动加载tweet-drama-voice-continuity，缺声线时用其prepare_voice_assets.py提取并登记候选；完整长音轨不直接作声线；实际讲话的2秒短参考可带背景声，同一包合计不超过15秒。'
  + '本工具绝不调用剧变的任何写方法、绝不计费：reconcile/dispose 本地只写 _probe/asset-reconcile.json，match_preview 完全只读。'

/**
 * Register the `drama_assets` tool.
 * @param ctx - Host context carrying the tool registry and the credential store.
 * @param config - Optional origin, timeout and workspace-secret overrides.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const limits = matchLimits(config)
  const client = configuredJubianClient(
    async () => (await ctx.credentials.resolve(credentialRef(JUBIAN_TOKEN_REF)))?.value ?? '', config, process.cwd())
  ctx.tools.register(defineTool({
    name: 'drama_assets',
    description: DESCRIPTION,
    parameters: {
      method: { type: 'string', required: true, enum: ['reconcile', 'dispose', 'match_preview', 'reuse_preview', 'usage_preview', 'shared_usage_preview'],
        description: 'reconcile=对账并写证据；dispose=只改处置记录；match_preview=只读人物、场景、声线匹配，不写文件、不审批。' },
      project_dir: { type: 'string', required: true,
        description: '项目根目录绝对路径；shared_usage_preview只需project_config.json中的jubian_script_id，其余方法需要assets_manifest.json。对账证据写在_probe/asset-reconcile.json。' },
      requirements_path: { type: 'string', description: 'match_preview/reuse_preview 必填：项目内 version=1 的需求 JSON，含 source_path、source_sha256 与 requirements；详情见工具 README。' },
      plan_path: { type: 'string', description: 'usage_preview 可选：项目内 version=1 的 documents JSON（path/sha256/episode）；reuse_preview 可选：项目内 version=1 的 shots JSON，含 storyboard_id、episode、episode_id 与 requirement_id/material_key 绑定映射；不得包含 approved 或审批字段。' },
      asset_id: { type: 'integer',
        description: 'usage_preview/shared_usage_preview 可选精确父资产筛选；dispose 必填：要处置的 unregistered 资产 ID（不是 material_id、不是任务 ID）。' },
      character_id: { type: 'string', description: 'shared_usage_preview 可选：精确稳定人物ID，查询此人的已明确登记妆造和不同人生时期声线；不按名字猜。' },
      output_offset: { type: 'integer', description: 'shared_usage_preview 输出分页偏移，默认0；后续页使用返回的pagination.next_offset及相同筛选条件，仅query_sha256相同才可拼接，不能把本页空数组当作资产不存在。' },
      status: { type: 'string', enum: ['registered', 'ignored'],
        description: 'dispose 必填：registered=已登记进清单（下次 reconcile 会自动确认）；'
          + 'ignored=确认不需要，必须同时给 note 说明原因。' },
      note: { type: 'string',
        description: 'dispose 可选但 status=ignored 时必填且非空：写清为什么这个资产不需要'
          + '（例如是别的剧的备选、失败遗留、废弃版本）。' },
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args, exec) => {
      const result = await runDramaAssets(client, args, limits, exec.signal)
      if (result.method === 'shared_usage_preview') return { ...result,
        assets: result.assets.map(row => ({ ...row })), uses: result.uses.map(row => ({ ...row })),
        duplicate_audio_groups: result.duplicate_audio_groups.map(row => ({ ...row })),
        totals: { ...result.totals }, coverage: { ...result.coverage }, pagination: { ...result.pagination } }
      if (result.method === 'usage_preview') return { ...result, usage_rows: result.usage_rows.map(row => ({ ...row })), voice_states: result.voice_states.map(row => ({ ...row })) }
      if (result.method === 'match_preview' || result.method === 'reuse_preview') return result
      return { ...result, disposition: Object.fromEntries(Object.entries(result.disposition).map(([key, value]) => [key, { ...value }])) }
    },
  }))
}
