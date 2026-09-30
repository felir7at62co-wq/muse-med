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
import type { ManifestRead } from './assets.ts'
import { readProjectDelivery } from './delivery.ts'
import {
  buildMatchedPayload,
  MIN_CONTENT_SECONDS,
  MIN_SUBMIT_SECONDS,
  NATURAL_HOLD_SECONDS,
  packEpisode,
  prepareShotPrompts,
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
  /** Episode number; required by `compile`, optional elsewhere for the episode-coverage check. */
  episode?: number
  /** Verified provider/board maximum duration, including the natural hold; required for packing. */
  max_submit_seconds?: number
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
  /** Absolute project root the call names, absent when it names none. */
  project?: string | undefined
  /** The episode the call names, absent when it names none. */
  episode?: number | undefined
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
 * the episode number it writes under. A `project` given to any method is kept, so
 * every method reads the project's own delivery requirements, and an `episode`
 * given to any method is kept, so every method can judge whether a bound asset's
 * registration covers the episode.
 * @param args - The dispatched arguments.
 * @returns The resolved script, manifest, project, episode, and compile destination.
 * @throws {Error} When the method's required arguments are missing or the episode number is not a positive integer.
 */
function resolveCall(args: DramaShotArguments): ResolvedCall {
  const script = resolve(args.script)
  const project = args.project === undefined ? undefined : resolve(args.project)
  const episode = args.episode
  if (episode !== undefined && (!Number.isSafeInteger(episode) || episode < 1)) {
    throw new Error(`drama_shot 的 episode 必须是正整数集号，收到 ${String(episode)}。`)
  }
  if (args.method === 'validate') {
    return args.assets === undefined
      ? { script, project, episode }
      : { script, assets: resolve(args.assets), project, episode }
  }
  if (args.assets === undefined) {
    throw new Error(`drama_shot ${args.method} 需要 assets：资产清单（assets_manifest.json）的路径，`
      + '它决定资产绑定与每包的场景边界。')
  }
  const assets = resolve(args.assets)
  if (args.method === 'preview') return { script, assets, project, episode }
  if (project === undefined || episode === undefined) {
    throw new Error('drama_shot compile 需要 project 与 episode：'
      + 'project 是项目根目录（含 episodes/、prompts/、matches/、episode_packages/），episode 是集号。')
  }
  const number = String(episode).padStart(2, '0')
  return {
    script,
    assets,
    project,
    episode,
    target: {
      project,
      episode: number,
      promptPath: join(project, 'prompts', `${number}.txt`),
      matchedPath: join(project, 'matches', `${number}.matched.json`),
    },
  }
}

/** Read and validate one project's asset manifest. */
async function readManifest(path: string): Promise<ManifestRead> {
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
function compileShots(
  shots: ReturnType<typeof parseShotScript>['shots'],
  manifest: ManifestAsset[] | undefined,
  episode: number | undefined,
): {
  compiled: CompiledShot[]
  issues: ShotIssue[]
} {
  const compiled: CompiledShot[] = []
  const issues: ShotIssue[] = []
  let cursor = 0
  for (const shot of shots) {
    const binding = manifest === undefined ? undefined : bindShot(shot, manifest, episode)
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
  return { compiled: prepareShotPrompts(compiled, manifest), issues }
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
  const delivery = await readProjectDelivery(call.script, call.project)
  const parsed = parseShotScript(scriptText, {
    actionShotSeconds: config.actionShotSeconds,
    maxEffectiveChars: delivery?.maxEffectiveChars,
  })
  const manifestRead = call.assets === undefined ? undefined : await readManifest(call.assets)
  const manifest = manifestRead?.assets
  const { compiled, issues: bindingIssues } = compileShots(parsed.shots, manifest, call.episode)
  const issues = [...parsed.issues, ...(manifestRead?.issues ?? []), ...bindingIssues]
  let maxContentSeconds = 0
  let tasks: PackedTask[] = []
  if (args.method !== 'validate') {
    const maximum = args.max_submit_seconds
    if (maximum === undefined || !Number.isSafeInteger(maximum) || maximum < MIN_SUBMIT_SECONDS) {
      throw new Error('preview/compile 需要 max_submit_seconds：单包提交时长上限（至少4秒，含收束秒），且在已确认模型能力内；不要默认取模型最大值。')
    }
    maxContentSeconds = maximum - NATURAL_HOLD_SECONDS
    for (const { shot } of compiled) {
      if (shot.durationSeconds > maxContentSeconds) {
        issues.push({ severity: 'failure', code: 'shot_exceeds_package_budget', shot: shot.shot, line: shot.line,
          message: `镜头${shot.shot}为${shot.durationSeconds}秒，超过本次内容预算${maxContentSeconds}秒（提交上限${maximum}秒，含${NATURAL_HOLD_SECONDS}秒收束）；请选择支持的分镜时长或按原文语义拆镜，不能截断。` })
      }
    }
    if (!issues.some(issue => issue.severity === 'failure')) {
      tasks = packEpisode(compiled, maxContentSeconds)
      for (const task of tasks) {
        if (task.contentSeconds >= MIN_CONTENT_SECONDS) continue
        const first = compiled.find(item => item.shot.shot === task.shots[0])
        /* v8 ignore next -- the packer numbers every package from these same shots. */
        if (first === undefined) continue
        issues.push({ severity: 'warning', code: 'package_below_minimum', shot: first.shot.shot, line: first.shot.line,
          message: `第${task.index}包只有${task.contentSeconds}秒内容（请求${task.submitSeconds}秒，镜头${task.shots.join('、')}），`
            + `已增加自然停留至${MIN_SUBMIT_SECONDS}秒请求下限，不新增台词；可优先并入同场连续的相邻包。` })
      }
    }
  }
  const failed = issues.some(issue => issue.severity === 'failure')
  if (failed) tasks = []
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
            description: 'dialogue=画面内台词；vo=画外发声，含旁白/心声；action=无发声。' },
          speaker: { type: 'string', required: true, description: '说话人；无声镜为空串。' },
          text: { type: 'string', required: true, description: '去掉说话人前缀后的台词原文；无声镜为空串。' },
          effective_chars: { type: 'integer', required: true, description: '有效字：汉字/字母/数字，标点与空格不计。' },
          duration_seconds: { type: 'integer', required: true, description: '本镜计入打包预算的整秒数。' },
          duration_source: { type: 'string', required: true, enum: ['speech', 'declared', 'complexity', 'default'],
            description: '时长来源：明确声明、9 有效字/秒估算、动作复杂度、或编译器默认值。' },
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
          content_seconds: { type: 'integer', required: true, description: '本包内容时长（整秒），加收束不超过 max_submit_seconds。' },
          content_duration_ms: { type: 'integer', required: true,
            description: '提交 jubian_storyboard generate 的 content_duration_ms（整千毫秒）。' },
          submit_seconds: { type: 'integer', required: true,
            description: '提交给剧变的整秒时长：内容时长 + 1 秒自然收束。' },
          natural_hold_seconds: { type: 'integer', required: true, description: '自然收束秒数，至少 1；短包增加停留以达到 4 秒最低提交时长。' },
          hold_instruction: { type: 'string', required: true, description: '写进提示词的收束要求，不新增台词。' },
          prompt: { type: 'string', required: true,
            description: '可直接保存到分镜 modelConfig.prompt 的完整镜头正文、已绑定素材映射与自然收束要求。' },
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
  + '时长：N秒的正整数声明优先；省略时按 9 有效字/秒估算。超过 15 字写作阈值或内建 36 字建议、偏离估算仅警告，可保留长慢镜头；'
  + '但项目在 project_config.json 的 delivery.max_effective_chars_per_shot 里声明了每镜上限时，超过该上限判失败'
  + '（按原文语义拆镜，或改掉该项目的这条要求），不删字、不改顺序、不换说话人；'
  + '无发声镜必须写 发声类型：action，时长由 动作复杂度（简单/一般/较复杂/复杂 = 1/2/3/4 秒）决定，'
  + '没写就按默认 2 秒计；'
  + '只在一个镜头块的字段里读到 台词：无、空台词行 或 出镜人物：无 时判失败：无声镜整行省略台词行与出镜人物，'
  + '不要用占位值占位；本说明、技能正文与检查清单里出现这些字样不算脚本违规，校验只看脚本里写了什么。'
  + '导演格式对白必须有说话人；说话人字段与台词角色前缀冲突时失败，不能静默换角色。'
  + '旁白/解说/心声/画外声/OS 作为 vo 画外发声保留原文与说话人，提醒核对项目配音；'
  + '风格/负面词缺失和正文秒数仅警告；只绑定 official=true 且有剧变 asset/material ID 与 URL 的资产；'
  + '角色状态在绑定前强制核对：每个入画角色都要在自己的 主体状态追踪 段落里写 '
  + '身体状态：【阶段（孕周/年龄段）；服装；发型】；'
  + '（孕八周记孕早期，没有体型变化写 非孕期），所挂资产的 state_or_costume（连同资产名）必须登记同一组维度，'
  + '资产还必须登记 episodes（本集号数组，或 ["all"] 全剧母版）；'
  + '任一侧没写、写了别的阶段、或本集不在登记集数里都判失败并点名资产 id，'
  + '清单里根本没有该状态的资产时给出补料需求（角色/阶段/服装/用于哪几集）与补料路径，不静默绑定。'
  + 'preview/compile 必填 max_submit_seconds：单包提交时长上限（至少4秒，在项目模型确认能力内），不是自动取模型最大值。'
  + '只合并同场连续完整镜头，内容加1秒收束不得超过该值，超长单镜拒绝，禁止截断。'
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
        description: '项目根目录（含 episodes/、prompts/、matches/、episode_packages/）；compile 必填。'
          + '给了它就读该项目的 project_config.json（每镜有效字上限等交付要求）；'
          + 'validate/preview 省略时，从脚本所在目录向上找最近的 project_config.json。' },
      max_submit_seconds: { type: 'integer',
        description: 'preview/compile 必填：本次打包的单包总时长上限，包含收束。项目模型 SD2.0 支持4–15秒，SD2.5 支持4–30秒；具体修订须已核实。按内容确定，不必取最大值；编译后将各包 submit_seconds 写入对应分镜。' },
      episode: { type: 'integer',
        description: '集号（正整数，如 3）；compile 必填，写入时补成两位，如 03。'
          + 'validate/preview 也接受：给了就同时判定所挂资产登记的 episodes 是否覆盖这一集。' },
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async args => await runDramaShot(args, resolved),
  }))
}
