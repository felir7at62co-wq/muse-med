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

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { JUBIAN_TOKEN_REF, JubianClient, JubianError } from '@deepseek-ai/dsh-jubian'
import { disposeAsset, evidencePath, reconcileProject, resolveProjectDir } from './reconcile.ts'
import type { DisposedEvidence } from './reconcile.ts'
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
}

/** The workspace-relative secret file the pipeline skills and `tool-jubian` already use. */
const PIPELINE_ENV = join('.agents', 'secrets', 'pipeline.env')

/**
 * Read the pipeline token from the nearest workspace secret file.
 *
 * The credential store stays the source of truth: this runs only when that store
 * has no usable value, because the pipeline's own client resolves the same file
 * and a session that lost the store entry should not lose its login with it. The
 * value never enters a result, a log or a preview.
 * @param start - Directory to search upward from, normally the launch directory.
 * @returns The token, or an empty string when no file in the chain carries one.
 */
export async function workspacePipelineToken(start: string): Promise<string> {
  let directory = resolve(start)
  for (let hop = 0; hop < 12; hop += 1) {
    try {
      const text = await readFile(join(directory, PIPELINE_ENV), 'utf8')
      const values = new Map<string, string>()
      for (const line of text.split('\n')) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
        const key = match?.[1]
        const value = match?.[2]
        if (key === undefined || value === undefined) continue
        values.set(key, value.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'))
      }
      // The admin token is the pipeline's own name and the plain one is the older
      // spelling; an empty value falls through to the next name rather than winning.
      return values.get('JUBIANAI_ADMIN_TOKEN') || values.get('JUBIANAI_TOKEN') || ''
    } catch { /* keep walking up */ }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return ''
}

/** One call's arguments, exactly as the parameter schema declares them. */
interface DramaAssetsArguments {
  /** The operation to run. */
  method: DramaAssetsMethod
  /** Project root holding `assets_manifest.json`; the file is written below `_probe/` there. */
  project_dir?: string
  /** The unregistered asset a `dispose` call is about. */
  asset_id?: number
  /** The disposition a `dispose` call writes. */
  status?: string
  /** Why the asset is not needed; required and non-empty for `ignored`. */
  note?: string
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
  /** What this call leaves the caller to do, in one Chinese sentence. */
  readonly next: string
}

/**
 * The reason text for the two verdicts, in the pipeline's own words.
 *
 * Only the two lists are read: a report reaching here with either of them non-empty
 * and `ready: true` is not a state this package produces, so there is no third
 * message for it.
 * @param report - The two verdict lists the evidence carries.
 * @returns The Chinese reason the host gate reports for the same state.
 */
function readyReason(report: Pick<ReconcileReport, 'blocking' | 'ignored_without_note'>): string {
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
function nextStep(report: Pick<ReconcileReport, 'ready' | 'blocking' | 'ignored_without_note' | 'dangling'>): string {
  if (report.ready) {
    return report.dangling.length === 0
      ? '证据 ready=true：可以发起付费生图。'
      : `证据 ready=true：可以发起付费生图；但清单里还有 ${String(report.dangling.length)} 条悬空记录需要修。`
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
    disposition: report.disposition, blocking: report.blocking,
    ignored_without_note: report.ignored_without_note, policy: report.policy,
    cross_project_note: report.cross_project_note, next: nextStep(report) }
}

/**
 * Assemble one `dispose` call's result from the evidence as written.
 *
 * The comparison fields are absent rather than defaulted: this call never read the
 * remote project, and a count filled with zeros would read as a comparison that
 * found nothing. `reconcile` is what produces those fields.
 * @param projectDir - Resolved project directory holding the evidence.
 * @param assetId - The asset this call disposed of.
 * @param evidence - The evidence document {@link disposeAsset} wrote.
 * @returns The dispositions, the recomputed verdicts, and the path written to.
 */
function presentDispose(projectDir: string, assetId: number, evidence: DisposedEvidence): DramaAssetsDispose {
  const { disposition, blocking, ignored_without_note: ignoredWithoutNote } = evidence
  return { method: 'dispose', asset_id: assetId, ready: evidence.ready,
    ready_reason: readyReason({ blocking, ignored_without_note: ignoredWithoutNote }),
    evidence: evidencePath(projectDir), disposition, blocking, ignored_without_note: ignoredWithoutNote,
    next: '处置已写入证据：宿主付费钩子下次读到它就会按新的 blocking / ignored_without_note 判定；'
      + '要刷新远端比对结果与 ran_at，再跑一次 reconcile。' }
}

/**
 * Run one `drama_assets` call.
 * @param client - Jubian transport, used only by `reconcile`.
 * @param args - The dispatched arguments.
 * @returns The evidence this call wrote, summarized for the model.
 * @throws {JubianError} `INVALID_ARGUMENT` for a missing argument,
 *   `CONTRACT_CHANGED` for a manifest, a remote page, or existing evidence this call cannot read.
 */
export async function runDramaAssets(client: JubianClient,
  args: DramaAssetsArguments): Promise<PresentedReconcile | PresentedDispose> {
  const projectDir = resolveProjectDir(args.project_dir)
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
 * One flat object holds both methods' fields, and the two method-specific halves
 * are the ones this schema does not require: the parameter DSL rejects
 * `required` inside a `oneOf` branch, so a branch-per-method schema would compile
 * into branches that match nothing. Every field a call does report is required;
 * the fields a method does not report are simply absent from its value, which is
 * what the field descriptions say.
 */
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    method: { type: 'string', required: true, enum: ['reconcile', 'dispose'],
      description: '产生本结果的操作；两个方法的字段不同，本 schema 只强制共有字段。' },
    ready: { type: 'boolean', required: true,
      description: '证据是否已经可以让宿主钩子放行付费生图：blocking 与 ignored_without_note 都为空才为 true。' },
    ready_reason: { type: 'string', required: true, description: 'ready 的判定依据；放行时为 ok。' },
    evidence: { type: 'string', required: true,
      description: '本次写入的证据文件绝对路径（<project_dir>/_probe/asset-reconcile.json）；宿主钩子读的就是它。' },
    disposition: { type: 'object', required: true, additionalProperties: true,
      description: '每条未登记资产的处置记录，跨次运行保留；值是 {status, note}，'
        + 'status 为 pending / registered / ignored。' },
    blocking: { type: 'array', required: true, items: { type: 'integer' },
      description: '还没处置（不是 registered / ignored）的未登记资产 ID；非空即拒绝付费生图。' },
    ignored_without_note: { type: 'array', required: true, items: { type: 'integer' },
      description: '判为 ignored 但 note 为空的资产 ID；非空即拒绝付费生图。' },
    next: { type: 'string', required: true, description: '这次之后该做什么，一句中文。' },
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

/** What the model reads before calling: what each method does, the verdict rule, and what this tool never does. */
const DESCRIPTION = '短剧流水线的付费生成前资产对账（剧变）。'
  + 'reconcile=只读剧变、免费：把「剧变远端这个项目里已选用的资产」与「assets_manifest.json 里写了什么」逐条比一遍，'
  + '产出机读证据 <project_dir>/_probe/asset-reconcile.json。'
  + '判定口径：远端存活 = asset/list 里 delFlag == "0"；已选用 = material/list 里 isUsed == 1 且 hsAssetStatus == "Active"；'
  + 'unregistered = 已选用但清单里没有（不许直接生成，先登记复用或写明不需要）；'
  + 'dangling = 清单里有但远端没有；matched = 两端都有的数量。'
  + 'dispose=给某条 unregistered 写处置：status=registered（已登记进清单）或 ignored（确认不需要，必须带非空 note）；'
  + '只更新证据里的 disposition 并重算 blocking / ignored_without_note / ready，不重新对账、不联网。'
  + 'ready = blocking 与 ignored_without_note 都为空，宿主侧的付费前置钩子只认这一条，证据 24 小时内有效。'
  + '为什么清单不够：清单只记录我们生成过什么，不等于剧变项目里已经有什么——'
  + '2026-09-20 就因为只看清单，给一张项目里早就存在的正式资产重新生成了两次（花掉 1.17 元）。'
  + '本工具绝不调用剧变的任何写方法、绝不计费：远端只读，本地只写 _probe/asset-reconcile.json 这一个文件。'

/**
 * Present one result to the registry.
 *
 * The result types carry `disposition` as a map of `{status, note}` while the
 * schema declares the same map with open values, so the two are the same JSON
 * object and not the same TypeScript type. The cast is at this one seam, and both
 * the registry and this package's own suite validate the returned value against
 * the declared schema.
 * @param value - The canonical result this call computed.
 * @returns The value the registered executor returns.
 */
function asRegistered(value: PresentedReconcile | PresentedDispose): never {
  return value as unknown as never
}

/**
 * Register the `drama_assets` tool.
 * @param ctx - Host context carrying the tool registry and the credential store.
 * @param config - Optional origin, timeout and workspace-secret overrides.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const client = new JubianClient({
    credential: async () => {
      const stored = (await ctx.credentials.resolve(credentialRef(JUBIAN_TOKEN_REF)))?.value ?? ''
      if (stored.trim()) return stored
      return config.workspaceSecrets === false ? '' : await workspacePipelineToken(process.cwd())
    },
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
  })
  ctx.tools.register(defineTool({
    name: 'drama_assets',
    description: DESCRIPTION,
    parameters: {
      method: { type: 'string', required: true, enum: ['reconcile', 'dispose'],
        description: 'reconcile=只读剧变做对账并写证据（免费）；dispose=只改证据里的处置记录（不联网）。' },
      project_dir: { type: 'string', required: true,
        description: '项目根目录绝对路径，必须含 assets_manifest.json；证据写在它的 _probe/asset-reconcile.json。' },
      asset_id: { type: 'integer',
        description: 'dispose 必填：要处置的 unregistered 资产 ID（不是 material_id、不是任务 ID）。' },
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
    execute: async args => asRegistered(await runDramaAssets(client, args as DramaAssetsArguments)),
  }))
}
