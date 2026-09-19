/**
 * `drama_shot`: the short-drama pipeline's shot-script gate and episode compiler,
 * as one model-facing tool.
 *
 * The pipeline's hard rules used to live in skill prose, where a model could skip
 * them. They are decidable — a rule is enforced here exactly when the script
 * text, the asset manifest, and the package budget settle it — so this plugin
 * judges them in the operation that produces the artifact. Creative guidance
 * (how a shot should read, how a cut should feel) stays in the skills.
 *
 * `validate` and `preview` read only; `compile` writes the matched JSON and the
 * episode package, and a script with any failure-severity issue writes nothing.
 *
 * @module @deepseek-ai/dsh-tool-shot-script
 */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { bindShot, parseAssetManifest } from './assets.ts'
import {
  buildMatchedPayload,
  MAX_CONTENT_SECONDS,
  packEpisode,
  writeEpisode,
} from './episode.ts'
import { buildReport } from './report.ts'
import { parseShotScript } from './script.ts'
import type { CompiledShot, DramaShotMethod, DramaShotReport, ManifestAsset, PackedTask, ShotIssue } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-shot-script'

/** The tool registry this plugin contributes `drama_shot` to. */
export const inject = ['tools']

/** Seconds a silent shot takes when it declares no `动作复杂度`; the schema default too. */
const DEFAULT_ACTION_SHOT_SECONDS = 2

/**
 * Plugin config. `actionShotSeconds` is the only deployment-varying choice: it is
 * the packing budget for a silent shot that carries no `动作复杂度` label, matching
 * the compiler flag the drama skills used to pass.
 */
export interface Config {
  /** Seconds charged to a silent shot without a complexity label, 1–4; defaults to 2. */
  actionShotSeconds?: number
}

/** Validated config schema: the fallback budget must stay inside the 1–4 second shot rule. */
export const Config: z<Config> = z.object({
  actionShotSeconds: z.number().step(1).min(1).max(4).default(DEFAULT_ACTION_SHOT_SECONDS),
})

/** One resolved compiler configuration. */
interface ResolvedConfig {
  /** Seconds charged to a silent shot without a complexity label. */
  actionShotSeconds: number
}

/** One call's arguments, exactly as the parameter schema declares them. */
interface DramaShotArguments {
  /** The operation to run. */
  method: DramaShotMethod
  /** Path of the shot script. */
  script: string
  /** Path of the asset manifest; required by `preview` and `compile`. */
  assets?: string
  /** Project root; required by `compile`. */
  project?: string
  /** Episode number; required by `compile`. */
  episode?: number
}

/** Where `compile` writes one episode. */
interface EpisodeTarget {
  /** Absolute project root. */
  project: string
  /** Two-digit episode number. */
  episode: string
  /** Absolute path of the compiled prompt file. */
  promptPath: string
  /** Absolute path of the matched JSON. */
  matchedPath: string
}

/** One call's resolved inputs. */
interface ResolvedCall {
  /** Absolute path of the shot script. */
  script: string
  /** Absolute path of the asset manifest, absent when the caller gave none. */
  assets?: string
  /** Compile destination, absent for `validate` and `preview`. */
  target?: EpisodeTarget
}

/** Read one file as UTF-8 text without a byte-order mark. */
async function readText(path: string): Promise<string> {
  const text = await readFile(path, 'utf8')
  return text.startsWith('\ufeff') ? text.slice(1) : text
}

/**
 * Narrow one call's arguments to the paths its method cannot run without.
 *
 * `validate` needs only the script; `preview` adds the asset manifest, because
 * the scene key decides package boundaries; `compile` adds the project root and
 * the episode number it writes under.
 * @param args - The dispatched arguments.
 * @returns The resolved script, manifest, and compile destination.
 * @throws {Error} When the method's required arguments are missing or the episode number is not a positive integer.
 */
function resolveCall(args: DramaShotArguments): ResolvedCall {
  const script = resolve(args.script)
  if (args.method === 'validate') {
    return args.assets === undefined ? { script } : { script, assets: resolve(args.assets) }
  }
  if (args.assets === undefined) {
    throw new Error(`drama_shot ${args.method} 需要 assets：资产清单（assets_manifest.json）的路径，`
      + '它决定资产绑定与每包的场景边界。')
  }
  const assets = resolve(args.assets)
  if (args.method === 'preview') return { script, assets }
  const { project, episode } = args
  if (project === undefined || episode === undefined) {
    throw new Error('drama_shot compile 需要 project 与 episode：'
      + 'project 是项目根目录（含 episodes/、prompts/、matches/、episode_packages/），episode 是集号。')
  }
  if (episode < 1) {
    throw new Error(`drama_shot compile 的 episode 必须是正整数集号，收到 ${episode}。`)
  }
  const root = resolve(project)
  const number = String(episode).padStart(2, '0')
  return {
    script,
    assets,
    target: {
      project: root,
      episode: number,
      promptPath: join(root, 'prompts', `${number}.txt`),
      matchedPath: join(root, 'matches', `${number}.matched.json`),
    },
  }
}

/** Read and validate one project's asset manifest. */
async function readManifest(path: string): Promise<ManifestAsset[]> {
  const text = await readText(path)
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw new Error(`${path}: 资产清单不是合法 JSON。`
      + '请确认它是 UTF-8 的 assets_manifest.json，顶层为 {"assets": [...]}。', { cause: error })
  }
  return parseAssetManifest(document, path)
}

/** Bind every parsed shot and lay the episode timeline out from the derived durations. */
function compileShots(shots: ReturnType<typeof parseShotScript>['shots'], manifest: ManifestAsset[] | undefined): {
  compiled: CompiledShot[]
  issues: ShotIssue[]
} {
  const compiled: CompiledShot[] = []
  const issues: ShotIssue[] = []
  let cursor = 0
  for (const shot of shots) {
    const binding = manifest === undefined ? undefined : bindShot(shot, manifest)
    if (binding !== undefined) issues.push(...binding.issues)
    compiled.push({
      shot,
      characters: binding?.characters ?? [],
      scene: binding?.scene ?? '',
      props: binding?.props ?? [],
      assets: binding?.assets ?? [],
      start: cursor,
      end: cursor + shot.durationSeconds,
    })
    cursor += shot.durationSeconds
  }
  return { compiled, issues }
}

/**
 * Write the compiled episode into its project.
 * @param call - The resolved call, whose compile destination must be present.
 * @param compiled - Compiled shots in script order.
 * @param tasks - Packages in submission order.
 * @param failed - Whether a failure-severity issue blocks the write.
 * @returns Absolute paths this call created or overwrote, or none when nothing may be written.
 */
async function writeTarget(
  call: ResolvedCall,
  compiled: CompiledShot[],
  tasks: PackedTask[],
  failed: boolean,
): Promise<string[]> {
  const target = call.target
  if (failed || target === undefined) return []
  const payload = buildMatchedPayload({
    episode: target.episode,
    promptFile: target.promptPath,
    shots: compiled,
    tasks,
  })
  return await writeEpisode({ ...target, scriptPath: call.script, payload, shots: compiled })
}

/**
 * Judge, and for `compile` write, one episode of the short-drama pipeline.
 * @param args - The dispatched arguments.
 * @param config - The resolved compiler configuration.
 * @returns The canonical result; a script with failures never reaches the filesystem.
 */
async function runDramaShot(args: DramaShotArguments, config: ResolvedConfig): Promise<DramaShotReport> {
  const call = resolveCall(args)
  const scriptText = await readText(call.script)
  const parsed = parseShotScript(scriptText, { actionShotSeconds: config.actionShotSeconds })
  const manifest = call.assets === undefined ? undefined : await readManifest(call.assets)
  const { compiled, issues: bindingIssues } = compileShots(parsed.shots, manifest)
  const issues = [...parsed.issues, ...bindingIssues]
  const failed = issues.some(issue => issue.severity === 'failure')
  const tasks = args.method === 'validate' || failed ? [] : packEpisode(compiled, MAX_CONTENT_SECONDS)
  const written = args.method === 'compile' ? await writeTarget(call, compiled, tasks, failed) : []
  return buildReport({
    method: args.method,
    script: call.script,
    assetsManifest: call.assets ?? '',
    assetsChecked: manifest !== undefined,
    shots: compiled,
    issues,
    tasks,
    written,
  })
}

/** The one sentence every issue-field description repeats. */
const ISSUE_SHAPE = 'severity=failure 表示必须先修好再编译，warning 不阻塞编译。'

/** Model-facing result schema: every field of the canonical report, all of them always present. */
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    method: { type: 'string', required: true, enum: ['validate', 'preview', 'compile'],
      description: '产生本结果的操作。' },
    ok: { type: 'boolean', required: true,
      description: '是否通过全部硬失败；false 时没有写任何文件、也没有打包方案。' },
    script: { type: 'string', required: true, description: '被判定镜头脚本的绝对路径。' },
    assets_manifest: { type: 'string', required: true,
      description: '资产清单绝对路径；空串表示本次没有给清单（validate 未做资产绑定判定）。' },
    assets_checked: { type: 'boolean', required: true, description: '是否判定过资产绑定。' },
    shots: { type: 'array', required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          shot: { type: 'integer', required: true, description: '镜头号。' },
          line: { type: 'integer', required: true, description: '【镜头N】在脚本里的行号。' },
          voice_type: { type: 'string', required: true, enum: ['dialogue', 'vo', 'action'],
            description: 'dialogue=画面内台词；vo=同场画外音；action=无发声。' },
          speaker: { type: 'string', required: true, description: '说话人；无声镜为空串。' },
          text: { type: 'string', required: true, description: '去掉说话人前缀后的台词原文；无声镜为空串。' },
          effective_chars: { type: 'integer', required: true, description: '有效字：汉字/字母/数字，标点与空格不计。' },
          duration_seconds: { type: 'integer', required: true, description: '本镜计入打包预算的整秒数。' },
          duration_source: { type: 'string', required: true, enum: ['speech', 'complexity', 'default'],
            description: '时长来源：9 有效字/秒推导、动作复杂度、或编译器默认值。' },
          offscreen: { type: 'boolean', required: true, description: '是否是同场画外音。' },
          characters_field: { type: 'string', required: true, description: '出镜人物 字段原文；整行省略时为空串。' },
          scene: { type: 'string', required: true, description: '绑定到的正式场景名；空串表示没有绑定场景。' },
          props_field: { type: 'string', required: true, description: '关键道具 字段原文；整行省略时为空串。' },
          bindings: { type: 'array', required: true,
            description: '本镜绑定的资产，顺序为 人物 → 场景 → 道具。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true, description: '资产正式名。' },
                type: { type: 'string', required: true, description: '资产类型。' },
                official: { type: 'boolean', required: true, description: '是否 official=true。' },
                asset_id: { type: 'string', required: true, description: '剧变父资产 ID；缺失为空串。' },
                material_id: { type: 'string', required: true, description: '剧变生成材质 ID；缺失为空串。' },
                url: { type: 'string', required: true, description: '剧变资产 URL；缺失为空串。' },
              },
            } },
        },
      } },
    packages: { type: 'array', required: true,
      description: '每包对应一次剧变提交；硬失败时为空数组。',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'integer', required: true, description: '包序号，从 1 开始。' },
          shots: { type: 'array', required: true, items: { type: 'integer' },
            description: '本包镜头号，按脚本顺序。' },
          content_seconds: { type: 'integer', required: true, description: '本包内容时长（整秒），不超过 14。' },
          content_duration_ms: { type: 'integer', required: true,
            description: '提交 jubian_storyboard generate 的 content_duration_ms（整千毫秒）。' },
          submit_seconds: { type: 'integer', required: true,
            description: '提交给剧变的整秒时长：内容时长 + 1 秒自然收束。' },
          natural_hold_seconds: { type: 'integer', required: true, description: '自然收束秒数，固定 1。' },
          hold_instruction: { type: 'string', required: true, description: '写进提示词的收束要求，不新增台词。' },
          material_keys: { type: 'array', required: true, items: { type: 'string' },
            description: '本包提示词里 @[名称](key) 的 key，按出现顺序去重；select_assets 必须按这个顺序提交。' },
          material_names: { type: 'array', required: true, items: { type: 'string' },
            description: '本包镜头绑定的资产名，按镜头顺序去重。' },
        },
      } },
    failures: { type: 'array', required: true, description: ISSUE_SHAPE,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', required: true, enum: ['failure', 'warning'], description: ISSUE_SHAPE },
          code: { type: 'string', required: true, description: '稳定的规则代码（见包 README 的代码表）。' },
          line: { type: 'integer', required: true, description: '脚本行号；0 表示整篇问题。' },
          shot: { type: 'integer', required: true, description: '镜头号；0 表示整篇问题。' },
          message: { type: 'string', required: true, description: '中文说明：指出违规值并给出修法。' },
        },
      } },
    warnings: { type: 'array', required: true, description: ISSUE_SHAPE,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', required: true, enum: ['failure', 'warning'], description: ISSUE_SHAPE },
          code: { type: 'string', required: true, description: '稳定的规则代码（见包 README 的代码表）。' },
          line: { type: 'integer', required: true, description: '脚本行号；0 表示整篇问题。' },
          shot: { type: 'integer', required: true, description: '镜头号；0 表示整篇问题。' },
          message: { type: 'string', required: true, description: '中文说明：指出违规值并给出修法。' },
        },
      } },
    written: { type: 'array', required: true, items: { type: 'string' },
      description: '本次写入的绝对路径；只有 compile 通过后才非空。' },
    summary: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        shots: { type: 'integer', required: true, description: '镜头数。' },
        packages: { type: 'integer', required: true, description: '包数。' },
        content_seconds: { type: 'integer', required: true, description: '全部包的内容时长之和。' },
        failures: { type: 'integer', required: true, description: '硬失败条数。' },
        warnings: { type: 'integer', required: true, description: '警告条数。' },
      },
    },
  },
} as const

/** What the model reads before calling: what each method does and which rules decide the verdict. */
const DESCRIPTION = '短剧镜头脚本的判定与编译（剧变流水线）。'
  + 'validate=只读校验：逐镜给出推导时长（9 有效字/秒）、有效字、发声类型、画外音合法性、资产绑定，'
  + '硬失败与警告分开列出；'
  + 'preview=只读预算：在 validate 之上算出每包内容时长与打包方案，不落盘，用于提交前看预算；'
  + 'compile=判定通过后写入 matched JSON（matches/<集号>.matched.json）与单集 package'
  + '（prompts/<集号>.txt、episode_packages/<集号>/），并回报每包的 content_duration_ms、'
  + '提交给剧变的整秒时长与素材键顺序。'
  + '判定规则：单镜 1–4 整数秒；有台词的镜头按 9 有效字/秒推导，超过 15 有效字给警告，超过 36 有效字判失败；'
  + '无发声镜必须写 发声类型：action，时长由 动作复杂度（简单/一般/较复杂/复杂 = 1/2/3/4 秒）决定，'
  + '没写就按默认 2 秒计；'
  + '台词：无、空台词行、出镜人物：无 一律判失败（无声镜整行省略台词行与出镜人物）；'
  + '旁白/解说/心声/画外声/OS 判失败，但同一句话没说完就切镜时写成 台词：角色名（画外音）：原文 是允许的；'
  + '脚本与提示词里都不得出现任何秒数；只绑定 official=true 且有剧变 asset/material ID 与 URL 的资产；'
  + '只合并同场戏的连续完整镜头，每包内容 ≤14 秒，另加 1 秒自然收束，禁止截断镜头凑时长。'
  + '硬失败时不会写任何文件，也不给打包方案。'

/**
 * Register the `drama_shot` tool.
 * @param ctx - Host context carrying the tool registry.
 * @param config - The silent-shot budget for shots without a complexity label.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved: ResolvedConfig = {
    actionShotSeconds: config.actionShotSeconds ?? DEFAULT_ACTION_SHOT_SECONDS,
  }
  ctx.tools.register(defineTool({
    name: 'drama_shot',
    description: DESCRIPTION,
    parameters: {
      method: { type: 'string', required: true, enum: ['validate', 'preview', 'compile'],
        description: 'validate=只读校验；preview=只读预算（不落盘）；compile=判定通过后写入 matched JSON 与单集 package。' },
      script: { type: 'string', required: true,
        description: '镜头脚本路径（绝对，或相对当前工作目录）。' },
      assets: { type: 'string',
        description: '资产清单 assets_manifest.json 的路径；preview 与 compile 必填，'
          + 'validate 可选——给了才判定资产绑定。' },
      project: { type: 'string',
        description: '项目根目录（含 episodes/、prompts/、matches/、episode_packages/）；compile 必填。' },
      episode: { type: 'integer',
        description: '集号（正整数，如 3）；compile 必填，写入时补成两位，如 03。' },
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async args => await runDramaShot(args, resolved),
  }))
}
