/**
 * BGM matching: rank a local library by emotional distance to a target, and report
 * what each track actually measures.
 *
 * Two facts live in the tool description rather than in the code, because a model
 * reads the description and not the source: the backbone behind these numbers is
 * **non-commercial**, and the output is a ranked list of candidates rather than a
 * decision. The second matters — an agent that reads "matched" stops thinking,
 * while an agent that reads measured valence/arousal still has to choose.
 *
 * Ranking is by valence/arousal distance. A 57-track × 15-query evaluation scored
 * that 15/15 while the best text-embedding variant scored 14/15, and every text
 * variant's similarities sat in a 0.33–0.62 band — too narrow to order on.
 */
import { createHash } from 'node:crypto'
import { readFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { EmotionWorker } from './worker.ts'
import { resolvePython, resolveWeights, defaultWeightsPath, defaultIndexPath, resolveCatalogConfig,
  type BgmConfig } from './config.ts'
import { loadCatalog, downloadTrack } from './catalog.ts'
import type { CatalogTrack } from './types.ts'

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
}

interface RawAnalysis {
  valence: number
  arousal: number
  moods: string[]
  dropped_trailing_samples?: number
}

/** Recursively list audio files, sorted so an interrupted index resumes predictably. */
async function listAudio(directory: string): Promise<string[]> {
  const found: string[] = []
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...await listAudio(full))
    else if (AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) found.push(full)
  }
  return found.sort()
}

async function loadIndex(path: string): Promise<TrackEmotion[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return Array.isArray(parsed) ? parsed as TrackEmotion[] : []
  } catch { return [] }
}

async function saveIndex(path: string, tracks: TrackEmotion[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(tracks, null, 2)}\n`, 'utf8')
}

async function hashFile(path: string): Promise<string> {
  return `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`
}

/** Rank by distance to a target point; the scale is the model's own 1–9. */
function rank(tracks: (TrackEmotion | CatalogTrack)[], target: { valence: number; arousal: number },
  limit: number): Record<string, JsonValue>[] {
  return tracks
    .map(track => ({ track,
      distance: Math.abs(track.valence - target.valence) + Math.abs(track.arousal - target.arousal) }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, limit)
    .map(({ track, distance }) => ({
      ...('id' in track ? { track_id: track.id, name: track.name, url: track.url } : { path: track.path }),
      valence: Number(track.valence.toFixed(2)),
      arousal: Number(track.arousal.toFixed(2)),
      moods: [...track.moods],
      distance: Number(distance.toFixed(2)),
    }))
}

export function apply(ctx: Context, config: BgmConfig = {}): void {
  const python = resolvePython(config.pythonExecutable)
  const weights = resolveWeights(config.weightsPath)
  const dataDir = config.dataDir ?? DATA_DIR
  const indexPath = config.indexPath ?? defaultIndexPath()
  const catalog = resolveCatalogConfig(config)
  const lifetime = new AbortController()

  let worker: EmotionWorker | undefined

  /** One process, started at most once, with a dependency handshake before use. */
  const ensureWorker = async (): Promise<EmotionWorker> => {
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
    if (!ready.ready) {
      throw new Error(`perception-bgm: the worker cannot import its dependencies: ${ready.missing.join('; ')}`)
    }
    return created
  }

  ctx.effect(() => () => { lifetime.abort(); void worker?.dispose() }, 'perception-bgm: worker and downloads')

  const analyseOne = async (file: string): Promise<RawAnalysis> => {
    const active = await ensureWorker()
    return await active.call('analyse', {
      audio_path: file, weights_path: weights, data_dir: dataDir,
    }) as RawAnalysis
  }

  ctx.tools.register(defineTool({
    name: 'bgm_match',
    description: '在本地索引或部署配置的公开 BGM 库里按情绪选曲。'
      + 'match：给出目标「愉悦度」与「能量」（都用 1–9 的刻度，1=最消极/最平静，9=最积极/最激烈），'
      + '返回最接近的候选及每首的实际测量值。'
      + 'index：扫描一个目录，逐首分析情绪并入库；约 15–30 秒一首，按内容哈希增量更新，可随时中断续跑。'
      + 'inspect：只分析一首并返回它的数值。'
      + '公开库 match 仅返回 track_id/name/url 和测量值，不自动下载；选定后用 download + track_id 下载并校验，返回可供配乐合成使用的真实本地 path。match/download 不需要 Python。'
      + '**返回的是候选排序，不是决定**——最终选哪首由你判断；每首附带的 valence/arousal 原值就是判断依据。'
      + '**注意：底层音乐理解骨干 m-a-p/MERT-v1-95M 采用 CC-BY-NC-4.0 许可，仅限非商业用途。**',
    parameters: {
      method: { type: 'string', required: true, enum: ['match', 'index', 'inspect', 'download'],
        description: 'match=按坐标排序候选；index=扫描目录建库（可续跑）；inspect=分析单个音频文件；download=下载公开库中明确选定的 track_id。' },
      track_id: { type: 'string', description: 'download 必填：公开库 match 返回的 track_id；不接受任意 URL。' },
      directory: { type: 'string', description: 'index 必填：要扫描的音乐目录。' },
      audio_path: { type: 'string', description: 'inspect 必填：单个音频文件的路径。' },
      valence: { type: 'number', description: 'match 必填：目标愉悦度，1–9。' },
      arousal: { type: 'number', description: 'match 必填：目标能量，1–9。' },
      limit: { type: 'number', description: 'match 可选：返回候选数，默认 5，上限 20。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 30 * 60 * 1000,
    async execute(args, exec): Promise<Record<string, JsonValue>> {
      const networkSignal = (timeoutMs: number): AbortSignal => AbortSignal.any([
        exec.signal, lifetime.signal, AbortSignal.timeout(timeoutMs),
      ])
      switch (args.method) {
        case 'download': {
          if (!catalog) throw new Error('download requires a configured catalogUrl')
          if (typeof args.track_id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(args.track_id)) {
            throw new Error('download requires a catalog track_id (sha256:64 lowercase hex)')
          }
          return await downloadTrack(catalog, args.track_id, networkSignal(catalog.networkTimeoutMs))
        }
        case 'match': {
          if (typeof args.valence !== 'number' || typeof args.arousal !== 'number'
            || !Number.isFinite(args.valence) || !Number.isFinite(args.arousal)
            || args.valence < 1 || args.valence > 9 || args.arousal < 1 || args.arousal > 9) {
            throw new Error('match requires numeric valence and arousal on the 1–9 scale')
          }
          const tracks = catalog ? await loadCatalog(catalog, networkSignal(catalog.networkTimeoutMs)) : await loadIndex(indexPath)
          if (tracks.length === 0) {
            throw new Error(catalog ? 'no tracks in the configured BGM catalog'
              : `no indexed tracks at ${indexPath}; run index on a music directory first`)
          }
          const limit = Math.min(Math.max(Math.trunc(args.limit ?? 5), 1), 20)
          return {
            target: { valence: args.valence, arousal: args.arousal },
            evaluated_tracks: tracks.length,
            candidates: rank(tracks, { valence: args.valence, arousal: args.arousal }, limit),
            note: 'candidates are ranked by measured distance; choose one yourself.',
          }
        }

        case 'index': {
          if (args.directory === undefined || args.directory.trim() === '') {
            throw new Error('index requires directory')
          }
          const root = resolve(args.directory)
          const files = await listAudio(root)
          const tracks = await loadIndex(indexPath)
          const byPath = new Map(tracks.map(track => [track.path, track]))
          const failures: { path: string; error: string }[] = []
          let analysed = 0
          let unchanged = 0

          for (const file of files) {
            const info = await stat(file)
            const known = byPath.get(file)
            // Cheap pre-filter first: identical size and mtime cannot hide new
            // content in practice, and this keeps a re-index from reading 200 MB of
            // audio only to compute hashes it already has.
            if (known !== undefined && known.bytes === info.size && known.modified_ms === info.mtimeMs) {
              unchanged += 1
              continue
            }
            const sha256 = await hashFile(file)
            if (known !== undefined && known.sha256 === sha256) {
              byPath.set(file, { ...known, bytes: info.size, modified_ms: info.mtimeMs })
              unchanged += 1
              continue
            }
            try {
              const analysis = await analyseOne(file)
              byPath.set(file, { path: file, sha256, bytes: info.size, modified_ms: info.mtimeMs,
                valence: analysis.valence, arousal: analysis.arousal, moods: analysis.moods })
              analysed += 1
            } catch (error) {
              // One unreadable track must never end the run; it is recorded and skipped.
              failures.push({ path: file, error: error instanceof Error ? error.message : String(error) })
            }
            // Persist after every track so an interruption resumes instead of restarting.
            await saveIndex(indexPath, [...byPath.values()])
          }
          const finalTracks = [...byPath.values()]
          await saveIndex(indexPath, finalTracks)
          return { scanned: files.length, indexed: finalTracks.length, analysed, unchanged,
            failures, index_path: indexPath }
        }

        case 'inspect': {
          if (args.audio_path === undefined || args.audio_path.trim() === '') {
            throw new Error('inspect requires audio_path')
          }
          const file = resolve(args.audio_path)
          const analysis = await analyseOne(file)
          return { path: file, valence: Number(analysis.valence.toFixed(4)),
            arousal: Number(analysis.arousal.toFixed(4)), moods: analysis.moods,
            dropped_trailing_samples: analysis.dropped_trailing_samples ?? 0 }
        }
      }
    },
  }))
}

/** Exposed for diagnostics: where the plugin looks for the emotion head. */
export { defaultWeightsPath }
