/** BGM candidates from measured emotions, optional explicit story intent and project feedback. */
import { createHash } from 'node:crypto'
import { readFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  licenseRiskWarnings, normalizeLicenseInfo, parseBgmUsage, type BgmUsage, type LicenseInfo,
} from '@deepseek-ai/dsh-bgm-license-info'
import { EmotionWorker } from './worker.ts'
import { resolvePython, resolveWeights, defaultWeightsPath, defaultIndexPath, resolveCatalogConfig,
  type BgmConfig } from './config.ts'
import { loadCatalog, downloadTrack } from './catalog.ts'
import type { CatalogTrack } from './types.ts'
import { musicPreferenceFor, parseContextTags, readProjectMusicFeedback } from './preferences.ts'
import { compareStoryFits, parseStory, storyFit, storyGuidance, STORY_TAGS, type StoryFit, type StoryRequest } from './story.ts'
import { continuityFit, resolveContinuityPolicy, type ContinuityPolicy, type ContinuityTrack } from './continuity.ts'
import { groundStory } from './story-evidence.ts'

export const name = 'perception-bgm'
export const inject = ['tools']

const SCRIPT = fileURLToPath(new URL('../python/worker_main.py', import.meta.url))
const DATA_DIR = fileURLToPath(new URL('../python/data', import.meta.url))
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg', '.opus'])

/** One analysed track, as stored in the index. */
interface TrackEmotion {
  path: string
  sha256: string
  bytes: number
  modified_ms: number
  valence: number
  arousal: number
  moods: string[]
  license_info: LicenseInfo
  license_warnings: string[]
}

interface RawAnalysis {
  valence: number
  arousal: number
  moods: string[]
  dropped_trailing_samples?: number
}

/** Recursively list audio files, sorted so an interrupted index resumes predictably. */
async function listAudio(directory: string, signal: AbortSignal): Promise<string[]> {
  signal.throwIfAborted()
  const found: string[] = []
  const entries = await readdir(directory, { withFileTypes: true })
  signal.throwIfAborted()
  for (const entry of entries) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...await listAudio(full, signal))
    else if (AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) found.push(full)
  }
  return found.sort()
}

async function loadIndex(path: string, signal: AbortSignal): Promise<TrackEmotion[]> {
  let parsed: unknown
  try { parsed = JSON.parse(await readFile(path, { encoding: 'utf8', signal })) }
  catch { signal.throwIfAborted(); return [] }
  return Array.isArray(parsed) ? parsed.map((track: TrackEmotion) => {
    const licenseInfo = normalizeLicenseInfo(track.license_info)
    return { ...track, license_info: licenseInfo, license_warnings: licenseRiskWarnings(licenseInfo, 'unknown') }
  }) : []
}

async function saveIndex(path: string, tracks: TrackEmotion[], signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await mkdir(dirname(path), { recursive: true })
  signal.throwIfAborted()
  // An admitted write completes before cancellation is reported.
  await writeFile(path, `${JSON.stringify(tracks, null, 2)}\n`, 'utf8')
  signal.throwIfAborted()
}

async function hashFile(path: string, signal: AbortSignal): Promise<string> {
  return `sha256:${createHash('sha256').update(await readFile(path, { signal })).digest('hex')}`
}

function normalizedTrackId(value: string): string {
  return /^(?:sha256:)?[a-f0-9]{64}$/iu.test(value) ? `sha256:${value.replace(/^sha256:/iu, '').toLowerCase()}` : value
}

function adjacentTrackIds(value: readonly string[] | undefined): Set<string> {
  if (value === undefined) return new Set()
  return new Set(value.map((id) => {
    if (!id.trim()) throw new Error('adjacent_episode_track_ids must contain nonempty track IDs')
    return normalizedTrackId(id.trim())
  }))
}

/** Legacy local index files can omit the content hash. */
function matchingTrackId(track: TrackEmotion | CatalogTrack): string | undefined {
  return 'id' in track ? track.id : typeof track.sha256 === 'string' ? track.sha256 : undefined
}

/** Preserve measured distance while applying explicit story, continuity and adjacent-episode preferences. */
function rank(tracks: (TrackEmotion | CatalogTrack)[], target: { valence: number; arousal: number },
  limit: number, intendedUse: BgmUsage, story?: StoryRequest,
  previous?: ContinuityTrack, policy: ContinuityPolicy = resolveContinuityPolicy({}),
  adjacentIds: ReadonlySet<string> = new Set(), repeatPenalty = 0,
): { value: Record<string, JsonValue>; fit: StoryFit | undefined }[] {
  return tracks
    .map(track => ({ track,
      identity: matchingTrackId(track),
      reused: adjacentIds.has(normalizedTrackId(matchingTrackId(track) ?? '')),
      continuity: previous === undefined ? undefined : continuityFit(previous, {
        valence: track.valence, arousal: track.arousal,
        tags: 'audio_profile' in track ? track.audio_profile.tags.map(tag => tag.tag) : track.moods,
      }, policy),
      fit: story === undefined ? undefined : storyFit('name' in track ? track.name : track.path.split(/[\\/]/).slice(-1).join(''),
        track.moods, story, 'audio_profile' in track ? track.audio_profile.tags.map(tag => tag.tag) : undefined),
      distance: Math.abs(track.valence - target.valence) + Math.abs(track.arousal - target.arousal) }))
    .sort((left, right) => {
      if ((left.continuity && right.continuity) || adjacentIds.size) {
        const primary = story?.desired_tags[0]
        const supports = (fit: StoryFit | undefined) => primary !== undefined && fit !== undefined
          && [...fit.audio_matches, ...fit.title_matches, ...fit.mood_matches].includes(primary)
        const primaryOrder = Number(supports(right.fit)) - Number(supports(left.fit))
        if (primaryOrder) return primaryOrder
        const transitionOrder = Number(left.continuity?.status === 'review_required')
          - Number(right.continuity?.status === 'review_required')
        if (transitionOrder) return transitionOrder
      }
      if (adjacentIds.size) {
        if (left.fit && right.fit && story) {
          const conflictOrder = Number(left.fit.audio_conflicts.length > 0 || left.fit.mood_conflicts.length > 0)
            - Number(right.fit.audio_conflicts.length > 0 || right.fit.mood_conflicts.length > 0)
          if (conflictOrder) return conflictOrder
          for (const tag of story.desired_tags) {
            const audioOrder = Number(right.fit.audio_matches.includes(tag)) - Number(left.fit.audio_matches.includes(tag))
            if (audioOrder) return audioOrder
          }
        }
        const adjusted = left.distance + (left.reused ? repeatPenalty : 0) - right.distance - (right.reused ? repeatPenalty : 0)
        if (adjusted) return adjusted
      }
      const storyOrder = left.fit && right.fit && story ? compareStoryFits(left.fit, right.fit, story) : 0
      if (storyOrder) return storyOrder
      return left.distance - right.distance
    })
    .slice(0, limit)
    .map(({ track, distance, fit, continuity, identity, reused }) => ({ fit, value: {
      ...('id' in track ? { track_id: track.id, name: track.name, url: track.url }
        : { path: track.path, ...(typeof track.sha256 === 'string' ? { source_sha256: track.sha256 } : {}) }),
      valence: Number(track.valence.toFixed(2)),
      arousal: Number(track.arousal.toFixed(2)),
      moods: [...track.moods],
      ...('audio_profile' in track ? { audio_profile: { ...track.audio_profile } } : {}),
      license_info: { ...track.license_info },
      license_warnings: licenseRiskWarnings(track.license_info, intendedUse),
      distance: Number(distance.toFixed(2)),
      ...(fit === undefined ? {} : { story_fit: { ...fit } }),
      ...(continuity === undefined ? {} : { continuity_fit: { ...continuity } }),
      ...(adjacentIds.size === 0 ? {} : { adjacent_episode_reuse: {
        status: identity === undefined ? 'unknown_identity' : reused ? 'used_in_adjacent_episode' : 'not_listed',
        ranking_penalty: reused ? repeatPenalty : 0,
      } }),
    } }))
}

export function apply(ctx: Context, config: BgmConfig = {}): void {
  const python = resolvePython(config.pythonExecutable)
  const weights = resolveWeights(config.weightsPath)
  const dataDir = config.dataDir ?? DATA_DIR
  const indexPath = config.indexPath ?? defaultIndexPath()
  const catalog = resolveCatalogConfig(config)
  const continuityPolicy = resolveContinuityPolicy(config)
  const requireStoryEvidence = config.requireStoryEvidence ?? false
  if (typeof requireStoryEvidence !== 'boolean') throw new Error('requireStoryEvidence must be boolean')
  const repeatPenalty = config.adjacentEpisodeRepeatPenalty ?? 2
  if (!Number.isFinite(repeatPenalty) || repeatPenalty < 0 || repeatPenalty > 16) {
    throw new Error('adjacentEpisodeRepeatPenalty must be between 0 and 16')
  }
  const lifetime = new AbortController()
  const pending = new Set<Promise<Record<string, JsonValue>>>()

  let worker: EmotionWorker | undefined

  /** One process, started at most once, with a dependency handshake before use. */
  const ensureWorker = async (signal: AbortSignal): Promise<EmotionWorker> => {
    signal.throwIfAborted()
    if (python === '') {
      throw new Error('perception-bgm: no usable Python interpreter is configured '
        + '(set pythonExecutable, or the DSH_PERCEPTION_PYTHON environment variable)')
    }
    // Reuse the live process; otherwise start exactly one, even if several calls
    // arrive together.
    const existing = worker
    if (existing !== undefined && existing.alive) return existing
    const created = existing ?? new EmotionWorker({ pythonExecutable: python, scriptPath: SCRIPT,
      // No forced `HF_HUB_OFFLINE` here. The backbone is ~360 MB and a fresh host is
      // expected to fetch it on first use; pinning offline would turn that into a
      // "model not found" error instead of a download. A deployment that has
      // pre-seeded the cache can set it through `env`, which also carries `HF_HOME`.
      env: { HF_HUB_DISABLE_TELEMETRY: '1', ...config.env },
      ...(config.callTimeoutMs === undefined ? {} : { callTimeoutMs: config.callTimeoutMs }) })
    worker = created
    const ready = await created.start()
    signal.throwIfAborted()
    if (!ready.ready) {
      throw new Error(`perception-bgm: the worker cannot import its dependencies: ${ready.missing.join('; ')}`)
    }
    return created
  }

  ctx.effect(() => async () => {
    lifetime.abort(new Error('perception-bgm: plugin unloaded'))
    try { await worker?.dispose() }
    finally { await Promise.allSettled([...pending]) }
  }, 'perception-bgm: worker and operations')

  const analyseOne = async (file: string, signal: AbortSignal): Promise<RawAnalysis> => {
    const active = await ensureWorker(signal)
    signal.throwIfAborted()
    const result = await active.call('analyse', {
      audio_path: file, weights_path: weights, data_dir: dataDir,
    }) as RawAnalysis
    signal.throwIfAborted()
    return result
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'bgm_match',
    description: '在本地索引或部署配置的公开 BGM 库里按情绪选曲。'
      + 'match：给出目标「愉悦度」与「能量」（都用 1–9 的刻度，1=最消极/最平静，9=最积极/最激烈），'
      + '返回最接近的候选及每首的实际测量值。'
      + '剧情配乐先读剧本与实际时间线，按情节转折分别传 story：intent 说明观众应感受到什么，desired_tags/avoid_tags 声明希望或避免的音乐气质，dialogue_density 声明对白密度。'
      + '生产选曲给 story.evidence（requireStoryEvidence 部署开启时必需）：引用当前项目剧本中的真实对白/动作，以及实际画面检查记录里的原文。工具逐次读取文件核对引用，不接受凭空编造对白；缺依据或引用不符时先修正来源，不给正式选曲建议。人物嚣张发笑不代表观众应当觉得好笑；场景名称、题材和音乐标签不能替代本段情节。逐段检索，不把情绪不同的几场戏塞进同一次请求。'
      + 'intent 须综合前后情节推进、人物关系和对白真正含义，不能只按哭笑、打斗词或整集平均情绪选曲。连续情绪段传上一段实际采用的 previous_track_id；在符合本段主要剧情意图的候选中优先情绪/标签衔接平缓者，返回 continuity_fit。'
      + '剧情有明确转折时可解释较大变化；先检查整条配乐序列和真实切点，不因每句台词或换镜头就换音乐。continuity_fit 是元数据建议，不是试听通过或新门禁。'
      + '相邻两集尽量不用同一首：读取当前项目上一集及已制作下一集的真实配乐计划，传 adjacent_episode_track_ids。剧情与衔接条件相当时优先换曲；复用只增加公开的排序惩罚，保留实际情绪距离和候选，不封禁曲目。确需跨集延续时记录剧情依据。'
      + '有 audio_profile 时先按已绑定音频摘要的抽样模型标签排序，再按曲名意图线索、宽泛 moods、原始情绪距离排序，同类证据按 desired_tags 先后优先；曲名冲突进入 review_candidates，音频/情绪标签冲突只提示。'
      + 'audio_profile 返回实际采样窗、音频标签、配器/人声推断、时长和估计节奏，human_reviewed=false 表示未人工试听；similarity 是原始相似度，不是置信度或适配保证。曲名和标签不能证明配器、人声或时代适配，须试听真实片段与混音。'
      + 'index：扫描一个目录，逐首分析情绪并入库；约 15–30 秒一首，按内容哈希增量更新，可随时中断续跑。'
      + 'inspect：只分析一首并返回它的数值。'
      + '公开库 match 返回 track_id/name/url、测量值与授权声明，不自动下载；选定后用 download + track_id 下载并校验，返回可供配乐合成使用的真实本地 path。match/download 不需要 Python。'
      + 'match/download 返回 license_info 与 license_warnings；intended_use 只声明本次用途，缺失授权保持 unknown，风险提示不阻断。'
      + '选曲报告保留来源、许可、署名与范围；unknown 不表示可商用，declared 也不表示已核验授权。'
      + '**返回的是候选排序，不是决定**——最终选哪首由你判断；核对每首附带的 valence/arousal 原值与剧情证据。'
      + '选曲前传 project 读取 project_config.json/project_bible.bgm_feedback，并传当前剧情的 context_tags。'
      + '只有反馈的全部场景标签命中才暂不推荐已否决曲目；其他场景仍展示历史供你判断，不是全局黑名单。'
      + '用户明确改口应通过 drama_project 追加新反馈，不能把 Agent 的偏好写成用户意见。'
      + '被暂不推荐的曲目仍在 withheld_candidates 中可审查；保留原情绪距离，不臆造语义相似度。'
      + '根据对白密度、情绪、配器、切点与许可判断，一首或无后加配乐都是正常交付；低信心时集中一次试听反馈，不为凑数硬配乐。'
      + '**注意：底层音乐理解骨干 m-a-p/MERT-v1-95M 采用 CC-BY-NC-4.0 许可，仅限非商业用途。**'
      + '分析模型许可与曲目使用许可分别判断；match/download 不运行该分析模型，曲目授权也不能代替模型使用许可。',
    parameters: {
      method: { type: 'string', required: true, enum: ['match', 'index', 'inspect', 'download'],
        description: 'match=按情绪坐标与可选剧情意图排序候选；index=扫描目录建库（可续跑）；inspect=分析单个音频文件；download=下载公开库中明确选定的 track_id。' },
      intended_use: { type: 'string', enum: ['commercial', 'non_commercial', 'unknown'],
        description: 'match/download 可选：本次用途，默认 unknown；只影响授权风险提示，不声明或授予版权。' },
      track_id: { type: 'string', description: 'download 必填：公开库 match 返回的 track_id；不接受任意 URL。' },
      directory: { type: 'string', description: 'index 必填：要扫描的音乐目录。' },
      audio_path: { type: 'string', description: 'inspect 必填：单个音频文件的路径。' },
      valence: { type: 'number', description: 'match 必填：目标愉悦度，1–9。' },
      arousal: { type: 'number', description: 'match 必填：目标能量，1–9。' },
      limit: { type: 'number', description: 'match 可选：返回候选数，默认 5，上限 20。' },
      project: { type: 'string', description: 'match 推荐提供：项目目录（相对当前工作目录或绝对路径）。每次只读最新 project_bible.bgm_feedback；不使用其他项目或全局偏好。' },
      context_tags: { type: 'array', items: { type: 'string' }, description: 'match 可选：当前场景显式标签，例如堂屋、家庭冲突。复用项目反馈的相同标签；不是自动文本语义匹配。未提供时只展示反馈，不自动排除。' },
      previous_track_id: { type: 'string', description: 'match 连续配乐时提供：上一段实际采用的曲库 track_id 或本地 source_sha256。按同库实测情绪和音频标签比较，不编造上一段数值。换场不自动意味着情绪重置。' },
      adjacent_episode_track_ids: { type: 'array', items: { type: 'string' },
        description: 'match 可选：当前项目编号相邻两集（N−1 和已制作的 N+1）实际使用的曲库 track_id 或 source_sha256。尽量避免复用，同集上一段仍用 previous_track_id；不按曲名猜测，也不包含其他项目。' },
      story: { type: 'object', description: 'match 剧情配乐推荐提供：根据本段剧本与实际时间线明确音乐意图，不照搬台词里的动作词。省略则保留旧情绪距离排序。',
        properties: {
          intent: { type: 'string', required: true, description: '1–600 字符：本段希望观众感受到什么、人物关系与情节目的；这是 Agent 的剧本解读记录，不是自动文本检索。' },
          desired_tags: { type: 'array', required: true, items: { type: 'string', enum: [...STORY_TAGS] }, description: '1–8 个希望的音乐意图，按重要性从高到低排列：亲情为主、舒缓为辅用 family、gentle。克制争执可用 restrained；威胁未动手不自动选 action。' },
          avoid_tags: { type: 'array', items: { type: 'string', enum: [...STORY_TAGS] }, description: '0–8 个本段应避免的音乐意图，与 desired_tags 不重叠。' },
          dialogue_density: { type: 'string', enum: ['none', 'sparse', 'dense', 'unknown'], description: '本段实际对白密度；缺省 unknown，dense 提醒重点试听对白遮盖。' },
          evidence: { type: 'array', description: '1–8 条项目内 UTF-8 依据。生产预设要求 script 和 visual_review；后者为 JSON，含 video、video_sha256、observations，先实际检查采用视频再记录。工具核验原文和视频版本，不冒充画面语义或试听验收。',
            items: { type: 'object', additionalProperties: false, properties: {
              kind: { type: 'string', required: true, enum: ['script', 'transcript', 'visual_review'] },
              file: { type: 'string', required: true, description: '项目内文本路径，相对 project 或绝对路径。' },
              quotes: { type: 'array', required: true, items: { type: 'string' }, description: '1–8 段真实原文，每段最多 800 字符；无对白时引用真实动作。' },
            } } },
        }, additionalProperties: false },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 30 * 60 * 1000,
    async execute(args, exec): Promise<Record<string, JsonValue>> {
      const signal = AbortSignal.any([exec.signal, lifetime.signal])
      const operation = async (): Promise<Record<string, JsonValue>> => {
        signal.throwIfAborted()
        const networkSignal = (timeoutMs: number): AbortSignal => AbortSignal.any([
          signal, AbortSignal.timeout(timeoutMs),
        ])
        switch (args.method) {
          case 'download': {
            const intendedUse = parseBgmUsage(args.intended_use)
            if (!catalog) throw new Error('download requires a configured catalogUrl')
            if (typeof args.track_id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(args.track_id)) {
              throw new Error('download requires a catalog track_id (sha256:64 lowercase hex)')
            }
            const result = await downloadTrack(catalog, args.track_id, networkSignal(catalog.networkTimeoutMs), intendedUse)
            return { ...result, license_info: { ...result.license_info } }
          }
          case 'match': {
            const intendedUse = parseBgmUsage(args.intended_use)
            if (typeof args.valence !== 'number' || typeof args.arousal !== 'number'
              || !Number.isFinite(args.valence) || !Number.isFinite(args.arousal)
              || args.valence < 1 || args.valence > 9 || args.arousal < 1 || args.arousal > 9) {
              throw new Error('match requires numeric valence and arousal on the 1–9 scale')
            }
            const contextTags = parseContextTags(args.context_tags)
            const story = parseStory(args.story)
            const grounding = story !== undefined && (requireStoryEvidence || story.evidence !== undefined)
              ? await groundStory(args.project, story.evidence, requireStoryEvidence, signal) : undefined
            if (grounding !== undefined && grounding.status !== 'quotes_matched') {
              return { target: { valence: args.valence, arousal: args.arousal }, evaluated_tracks: 0, candidates: [],
                selection_status: grounding.status === 'missing_evidence' ? 'needs_source_evidence' : 'needs_source_correction',
                story_grounding: grounding,
                recommendation: 'Read the current script and inspect the adopted video. Supply real quotes from this segment and a visual-review JSON with video, video_sha256 and observations. If the video changed, inspect it again instead of only replacing the hash. Correct the interpretation and retry; retain original sound while unresolved.' }
            }
            if (args.context_tags !== undefined && args.project === undefined) throw new Error('context_tags requires project so user feedback can be read before selection')
            const feedback = args.project === undefined ? undefined : await readProjectMusicFeedback(args.project, signal)
            const tracks = catalog ? await loadCatalog(catalog, networkSignal(catalog.networkTimeoutMs))
              : await loadIndex(indexPath, signal)
            signal.throwIfAborted()
            if (tracks.length === 0) {
              if (feedback !== undefined || story !== undefined) return { target: { valence: args.valence, arousal: args.arousal },
                evaluated_tracks: 0, candidates: [], withheld_candidates: [], withheld_count: 0, music_optional: true,
                ...(feedback === undefined ? {} : { project_preferences: { config_path: feedback.config_path, status: feedback.status,
                  feedback_count: feedback.records.length, context_tags: contextTags } }),
                ...(story === undefined ? {} : { ...storyGuidance(story), review_candidates: [], review_count: 0 }),
                recommendation: 'No indexed music candidate is available; deliver without added BGM and explain the missing library. Do not invent a track or permission.',
                note: 'No suitable candidate is a normal production outcome, not a requirement to add music.' }
              throw new Error(catalog ? 'no tracks in the configured BGM catalog'
                : `no indexed tracks at ${indexPath}; run index on a music directory first`)
            }
            const limit = Math.min(Math.max(Math.trunc(args.limit ?? 5), 1), 20)
            const adjacentIds = adjacentTrackIds(args.adjacent_episode_track_ids)
            const previous = args.previous_track_id === undefined ? undefined
              : tracks.find(track => ('id' in track ? track.id : track.sha256) === args.previous_track_id)
            const continuityReference = previous === undefined ? undefined : {
              valence: previous.valence, arousal: previous.arousal,
              tags: 'audio_profile' in previous ? previous.audio_profile.tags.map(tag => tag.tag) : previous.moods,
            }
            const ranked = rank(tracks, { valence: args.valence, arousal: args.arousal },
              feedback || story || previous ? tracks.length : limit, intendedUse, story, continuityReference,
              continuityPolicy, adjacentIds, repeatPenalty)
            const reviewed = ranked.map(candidate => ({ candidate,
              preference: feedback === undefined ? undefined : musicPreferenceFor({
                ...(typeof candidate.value.track_id === 'string' ? { track_id: candidate.value.track_id } : {}),
                ...(typeof candidate.value.source_sha256 === 'string' ? { source_sha256: candidate.value.source_sha256 }
                  : typeof candidate.value.track_id === 'string' && candidate.value.track_id.startsWith('sha256:') ? { source_sha256: candidate.value.track_id } : {}),
              }, feedback, contextTags) }))
            const withheld = reviewed.filter(row => row.preference?.decision === 'reject')
            const remaining = reviewed.filter(row => !withheld.includes(row))
            const conflicts = remaining.filter(row => row.candidate.fit?.status === 'title_conflict')
            const candidates = remaining.filter(row => !conflicts.includes(row))
            const present = (row: typeof reviewed[number]): Record<string, JsonValue> => ({ ...row.candidate.value,
              ...(row.preference === undefined ? {} : { project_preference: row.preference }) })
            return {
              target: { valence: args.valence, arousal: args.arousal },
              evaluated_tracks: tracks.length,
              ...(grounding === undefined ? requireStoryEvidence ? { selection_status: 'reference_only' } : {}
                : { selection_status: 'evidence_matched', story_grounding: grounding }),
              ...(adjacentIds.size === 0 ? {} : { adjacent_episode_preference: {
                track_ids: [...adjacentIds], repeat_penalty: repeatPenalty,
                note: 'Caller supplies actual neighboring-episode IDs. Primary intent, continuity and audio evidence precede the ranking penalty. Measured distance and permission to reuse remain unchanged.',
              } }),
              ...(args.previous_track_id === undefined ? {} : { continuity_reference: {
                track_id: args.previous_track_id, status: previous === undefined ? 'missing_from_library' : 'ready',
                ...(continuityReference === undefined ? {} : continuityReference),
                max_emotion_distance: continuityPolicy.maxEmotionDistance, min_tag_overlap: continuityPolicy.minTagOverlap,
                note: 'Compare both neighboring cues against actual plot development and dialogue meaning. Metadata does not establish a natural musical phrase or human approval.',
              } }),
              candidates: candidates.slice(0, limit).map(present),
              ...(feedback === undefined ? {} : {
                project_preferences: { config_path: feedback.config_path, status: feedback.status,
                  feedback_count: feedback.records.length, context_tags: contextTags,
                  matching_rule: 'stable track ID or SHA-256; every feedback context tag must match; latest appended applicable user decision wins',
                  scope_note: 'Other-context feedback is advisory history, not a global blacklist. Read drama_project before mapping similar story contexts.' },
                withheld_candidates: withheld.slice(0, limit).map(present), withheld_count: withheld.length,
                music_optional: true,
                ...(reviewed.length === withheld.length ? { recommendation: 'No unrejected candidate in this scene; deliver without added BGM or ask once for an explicit user change.' } : {}),
              }),
              note: adjacentIds.size ? 'Measured distance is unchanged; adjacent-episode reuse adds a disclosed ranking penalty. Reuse remains available.'
                : 'candidates are ranked by measured distance; choose one yourself.',
              ...(story === undefined ? {} : { ...storyGuidance(story),
                review_candidates: conflicts.slice(0, limit).map(present), review_count: conflicts.length, music_optional: true,
                ...(candidates.some(row => row.candidate.fit?.status === 'supported') ? {} : {
                  recommendation: 'No unrejected candidate has positive story evidence without an explicit title conflict. Consider delivery without added BGM; unconfirmed/review candidates remain available for actual audition, not automatic selection.' }),
              }),
            }
          }

          case 'index': {
            if (args.directory === undefined || args.directory.trim() === '') {
              throw new Error('index requires directory')
            }
            const root = resolve(args.directory)
            const files = await listAudio(root, signal)
            const tracks = await loadIndex(indexPath, signal)
            signal.throwIfAborted()
            const byPath = new Map(tracks.map(track => [track.path, track]))
            const failures: { path: string; error: string }[] = []
            let analysed = 0
            let unchanged = 0

            for (const file of files) {
              const info = await stat(file)
              signal.throwIfAborted()
              const known = byPath.get(file)
              // Rights declarations stay bound to bytes even when size and modification time are unchanged.
              const sha256 = await hashFile(file, signal)
              signal.throwIfAborted()
              if (known !== undefined && known.sha256 === sha256) {
                byPath.set(file, { ...known, bytes: info.size, modified_ms: info.mtimeMs })
                unchanged += 1
                continue
              }
              const licenseInfo = normalizeLicenseInfo(undefined)
              const licenseWarnings = licenseRiskWarnings(licenseInfo, 'unknown')
              // A failed re-analysis must not retain the changed file's previous rights declaration.
              if (known !== undefined) byPath.set(file, { ...known, license_info: licenseInfo, license_warnings: licenseWarnings })
              try {
                const analysis = await analyseOne(file, signal)
                byPath.set(file, { path: file, sha256, bytes: info.size, modified_ms: info.mtimeMs,
                  valence: analysis.valence, arousal: analysis.arousal, moods: analysis.moods,
                  license_info: licenseInfo, license_warnings: licenseWarnings })
                analysed += 1
              } catch (error) {
                signal.throwIfAborted()
                // One unreadable track must never end the run; it is recorded and skipped.
                failures.push({ path: file, error: error instanceof Error ? error.message : String(error) })
              }
              // Persist after every track so an interruption resumes instead of restarting.
              await saveIndex(indexPath, [...byPath.values()], signal)
            }
            const finalTracks = [...byPath.values()]
            await saveIndex(indexPath, finalTracks, signal)
            return { scanned: files.length, indexed: finalTracks.length, analysed, unchanged,
              failures, index_path: indexPath }
          }

          case 'inspect': {
            if (args.audio_path === undefined || args.audio_path.trim() === '') {
              throw new Error('inspect requires audio_path')
            }
            const file = resolve(args.audio_path)
            const analysis = await analyseOne(file, signal)
            return { path: file, valence: Number(analysis.valence.toFixed(4)),
              arousal: Number(analysis.arousal.toFixed(4)), moods: analysis.moods,
              dropped_trailing_samples: analysis.dropped_trailing_samples ?? 0 }
          }
        }
      }
      const work = operation()
      pending.add(work)
      try { return await work }
      finally { pending.delete(work) }
    },
  })), 'perception-bgm: model tool')
}

/** Exposed for diagnostics: where the plugin looks for the emotion head. */
export { defaultWeightsPath }
