/**
 * The drama pipeline's decidable gate rules.
 *
 * Every rule here is answerable from the tool name, its parsed arguments, and
 * files this plugin may read. A rule that needed pixels, taste, or a judgement
 * about the story is deliberately absent: the gate's whole value is that a
 * refusal is a fact the model can act on, and a gate that guessed would block
 * correct work. What is not decidable at this granularity is recorded in the
 * package README instead of being approximated here.
 *
 * @module @deepseek-ai/dsh-guard-drama/src/rules
 */

import { isAbsolute, join, relative, resolve } from 'node:path'
import { checkMatchedJsonText, checkShotScriptText } from './shot-script.ts'

/** A gate outcome: the call proceeds, or it is refused with model-facing Chinese guidance. */
export type GateDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }

/**
 * The read-only file access the rules use. Both methods are total: a missing,
 * unreadable, or malformed path is a value, never a throw, because a gate that
 * crashed on a half-written project would break the session it guards.
 */
export interface GateReader {
  /**
   * Read one UTF-8 text file.
   * @param path - the absolute path to read.
   * @returns the file text, or undefined when it is absent or unreadable.
   */
  readText(path: string): string | undefined
  /**
   * List the immediate child directory names of one directory.
   * @param path - the absolute directory path to list.
   * @returns the child names, or an empty list when the directory is absent or unreadable.
   */
  listDirectoryNames(path: string): readonly string[]
}

/** Per-rule switches; every rule ships enabled and a deployment turns one off explicitly. */
export interface RuleSwitches {
  /** Refuse a Jubian write/paid method that carries no `idempotency_key`. */
  readonly idempotencyKey: boolean
  /** Refuse a write/edit that would land an invalid shot script or matched JSON. */
  readonly shotScript: boolean
  /** Refuse a paid storyboard submission while no `official=true` asset record exists. */
  readonly officialAssets: boolean
  /** Explain a call to a retired MUSE tool name instead of a bare `UNKNOWN_TOOL`. */
  readonly museToolNames: boolean
}

/** Everything one pending call needs; the evaluator performs no I/O of its own. */
export interface GateCall {
  /** The tool name exactly as the model called it. */
  readonly toolName: string
  /** The parsed arguments the registry already materialized. */
  readonly arguments: unknown
  /** Injected file access, so tests drive the rules without a real project. */
  readonly reader: GateReader
  /** The enabled rules. */
  readonly switches: RuleSwitches
  /** The calling session's absolute working directory, when it stated one. */
  readonly sessionCwd?: string | undefined
  /** The configured absolute workspace root, used only when the session states no cwd. */
  readonly configuredRoot?: string | undefined
  /** The workshop directory name below the workspace root. */
  readonly workshopDir: string
  /** An absolute project root that overrides the workshop-root derivation. */
  readonly projectRoot?: string | undefined
  /** Whether the tool registry resolves this name for the calling scope. */
  readonly registered: boolean
}

/** Jubian methods that write or bill, and therefore require an idempotency key. */
const WRITE_METHODS: Readonly<Record<string, readonly string[]>> = {
  jubian_storyboard: ['create', 'save', 'generate', 'erase_subtitle'],
  jubian_video: ['image_generate', 'upscale'],
  jubian_asset: ['confirm_casting', 'remove'],
}

/** Jubian methods that spend money on the storyboard, which may only follow confirmed official assets. */
const PAID_SUBMISSIONS: Readonly<Record<string, readonly string[]>> = {
  jubian_storyboard: ['generate'],
}

/** The retired MUSE tool names the drama skills replaced; they resolve to nothing in this deployment. */
const RETIRED_TOOL_NAMES: readonly string[] = ['drama', 'asset', 'shot', 'project', 'timeline', 'delivery']

/** File-writing tools whose full written text the content rules inspect by name. */
const WRITE_TOOL = 'write'
const EDIT_TOOL = 'edit'

/** The canonical project artifacts the official-asset gate reads. */
const ASSETS_MANIFEST = 'assets_manifest.json'
const PIPELINE_STATE = 'pipeline_state.json'

/** The stage whose completion is accepted as official-asset evidence when no manifest exists. */
const OFFICIAL_STAGE = 'official_assets'

/**
 * Judge one pending tool call.
 * @param call - the tool name, its arguments, and the injected readers and switches.
 * @returns `allow`, or a `deny` whose reason is the Chinese repair instruction the model reads.
 */
export function evaluateCall(call: GateCall): GateDecision {
  const refusals = [
    call.switches.museToolNames ? retiredToolRefusal(call) : undefined,
    call.switches.idempotencyKey ? idempotencyRefusal(call) : undefined,
    call.switches.officialAssets ? officialAssetRefusal(call) : undefined,
    call.switches.shotScript ? shotContentRefusal(call) : undefined,
  ]
  const reason = refusals.find((refusal): refusal is string => refusal !== undefined)
  return reason === undefined ? { kind: 'allow' } : { kind: 'deny', reason }
}

/** Refuse a call to a retired MUSE tool name with the replacement surface, never a bare unknown-tool error. */
function retiredToolRefusal(call: GateCall): string | undefined {
  if (call.registered || !RETIRED_TOOL_NAMES.includes(call.toolName)) return undefined
  return `没有名为「${call.toolName}」的工具：这是已下线的 MUSE 工具名，本模式不再提供。`
    + '请改用剧变工具（jubian_catalog / jubian_asset / jubian_storyboard / jubian_video / jubian_media）'
    + '以及 tweet-drama-* 技能脚本。'
}

/** Refuse a Jubian write/paid method that carries no usable idempotency key. */
function idempotencyRefusal(call: GateCall): string | undefined {
  const methods = WRITE_METHODS[call.toolName]
  const method = calledMethod(call)
  if (methods === undefined || method === undefined || !methods.includes(method)) return undefined
  const key = record(call.arguments)?.['idempotency_key']
  if (typeof key === 'string' && key.trim().length > 0) return undefined
  return `${call.toolName}.${method} 是写/计费方法，必须带 idempotency_key。`
    + '补上 idempotency_key 后重发；如果上一次调用的结果不明，用同一个 key 再调一次，不要换 key 重发。'
}

/** Refuse a paid storyboard submission while the workshop holds no official asset record. */
function officialAssetRefusal(call: GateCall): string | undefined {
  const methods = PAID_SUBMISSIONS[call.toolName]
  const method = calledMethod(call)
  if (methods === undefined || method === undefined || !methods.includes(method)) return undefined
  const workspace = workspaceRoot(call)
  // Without a root there is nothing to read, and a gate that refused every paid
  // call in a deployment whose sessions state no cwd would be a worse defect
  // than the one it prevents. The README records the boundary.
  if (workspace === undefined) return undefined
  const workshopRoot = resolve(workspace, call.workshopDir)
  const roots = projectRoots(call, workshopRoot)
  if (hasOfficialAssetEvidence(roots, call.reader)) return undefined
  return `${call.toolName}.${method} 会真实计费，但工作间里找不到 official=true 的正式资产记录`
    + `（已查：${roots.join('、')}）。镜头与视频只能引用 official=true 且有剧变 asset/material id 与 URL 的资产；`
    + '先走资产三阶段门禁（写提示词 → 生图 → 候选审核 → 确认出演 / isLocal 主体设定门禁），'
    + '把 official 记录写进 assets_manifest.json 后再提交。'
}

/** Refuse a write/edit whose resulting text would violate the shot-script or matched-JSON contract. */
function shotContentRefusal(call: GateCall): string | undefined {
  if (call.toolName !== WRITE_TOOL && call.toolName !== EDIT_TOOL) return undefined
  const workspace = workspaceRoot(call)
  if (workspace === undefined) return undefined
  const args = record(call.arguments)
  const filePath = args?.['file_path']
  if (args === undefined || typeof filePath !== 'string' || filePath.trim().length === 0) return undefined
  const target = isAbsolute(filePath) ? resolve(filePath) : resolve(workspace, filePath)
  const kind = shotTarget(resolve(workspace, call.workshopDir), target)
  if (kind === undefined) return undefined
  const text = call.toolName === WRITE_TOOL
    ? writtenText(args)
    : editedText(args, call.reader, target)
  if (text === undefined) return undefined
  const refusal = kind === 'script' ? checkShotScriptText(text) : checkMatchedJsonText(text)
  if (refusal === undefined) return undefined
  return `短剧门禁拦下这次 ${call.toolName}（${target}）：${refusal}`
}

/** The text a `write` call would commit, or undefined when the argument is not a string. */
function writtenText(args: Record<string, unknown>): string | undefined {
  const content = args['content']
  return typeof content === 'string' ? content : undefined
}

/**
 * The text an `edit` call would commit, reconstructed from the file it names.
 * The reconstruction mirrors the tool's own literal semantics exactly — a
 * `split`/`join` with no `$&` expansion, a single match required unless
 * `replace_all` is set — and an edit the tool itself would refuse (a missing or
 * ambiguous match, an unreadable target) yields no text to judge, because
 * nothing would be written.
 */
function editedText(args: Record<string, unknown>, reader: GateReader, path: string): string | undefined {
  const oldString = args['old_string']
  const newString = args['new_string']
  if (typeof oldString !== 'string' || typeof newString !== 'string' || oldString.length === 0) return undefined
  const current = reader.readText(path)
  if (current === undefined) return undefined
  const occurrences = current.split(oldString).length - 1
  if (occurrences === 0 || (args['replace_all'] !== true && occurrences > 1)) return undefined
  return current.split(oldString).join(newString)
}

/** Classify a path below the workshop as a gated shot script or matched JSON, or neither. */
function shotTarget(workshopRoot: string, target: string): 'script' | 'matched' | undefined {
  const rel = relative(workshopRoot, target)
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return undefined
  const segments = rel.split(/[\\/]/)
  const base = (segments.at(-1) ?? '').toLowerCase()
  const inPipelineDir = segments.slice(0, -1)
    .some(segment => ['prompts', 'matches', 'episode_packages'].includes(segment.toLowerCase()))
  if (!inPipelineDir) return undefined
  if (base.endsWith('.matched.json') || base === 'matched.json' || base === 'package.json') return 'matched'
  return base.endsWith('.txt') ? 'script' : undefined
}

/** The tool's `method` argument, normalized, or undefined when the call states none. */
function calledMethod(call: GateCall): string | undefined {
  const method = record(call.arguments)?.['method']
  if (typeof method !== 'string') return undefined
  const normalized = method.trim().toLowerCase()
  return normalized.length === 0 ? undefined : normalized
}

/** The root the gate resolves paths against: the session's stated cwd, then the configured fallback. */
function workspaceRoot(call: GateCall): string | undefined {
  const stated = call.sessionCwd
  if (typeof stated === 'string' && stated.trim().length > 0 && isAbsolute(stated)) return resolve(stated)
  const configured = call.configuredRoot
  if (typeof configured === 'string' && configured.trim().length > 0 && isAbsolute(configured)) return resolve(configured)
  return undefined
}

/** Every project root worth reading: the explicit one, the workshop root, then each immediate child. */
function projectRoots(call: GateCall, workshopRoot: string): string[] {
  const roots: string[] = []
  const explicit = call.projectRoot
  if (typeof explicit === 'string' && explicit.trim().length > 0 && isAbsolute(explicit)) roots.push(resolve(explicit))
  for (const candidate of [workshopRoot, ...call.reader.listDirectoryNames(workshopRoot).map(name => resolve(workshopRoot, name))]) {
    if (!roots.includes(candidate)) roots.push(candidate)
  }
  return roots
}

/** Whether any candidate root carries an official-asset record, preferring a manifest over a state file. */
function hasOfficialAssetEvidence(roots: readonly string[], reader: GateReader): boolean {
  if (roots.some(root => manifestHasOfficial(join(root, ASSETS_MANIFEST), reader))) return true
  return roots.some(root => stateReportsOfficialAssets(join(root, PIPELINE_STATE), reader))
}

/** Whether `assets_manifest.json` carries at least one `official: true` asset record. */
function manifestHasOfficial(path: string, reader: GateReader): boolean {
  const parsed = parsedJson(reader.readText(path))
  const container = Array.isArray(parsed) ? parsed : record(parsed)?.['assets']
  const entries = Array.isArray(container) ? container : Object.values(record(container) ?? {})
  return entries.some(entry => record(entry)?.['official'] === true)
}

/** Whether `pipeline_state.json` records the official-asset stage as completed for the project or an episode. */
function stateReportsOfficialAssets(path: string, reader: GateReader): boolean {
  const parsed = record(parsedJson(reader.readText(path)))
  if (parsed === undefined) return false
  const episodes = record(parsed['episodes'])
  return stageStatus(record(parsed['stages'])?.[OFFICIAL_STAGE]) === 'completed'
    || (episodes !== undefined
      && Object.values(episodes).some(episode => stageStatus(record(episode)?.[OFFICIAL_STAGE]) === 'completed'))
}

/** The `status` one optional stage record carries. */
function stageStatus(stage: unknown): unknown {
  return record(stage)?.['status']
}

/** Parse one optional JSON document, treating unreadable or malformed text as absent. */
function parsedJson(text: string | undefined): unknown {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Narrow one parsed JSON value to a string-keyed record. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
