/**
 * Batch Jianying drafts for local projects: one verified, prepared and generated draft per episode.
 *
 * Each episode needs the version 2 clock receipt `episode_subtitles` wrote. A shot whose duration, picture or sound
 * changed since that build refuses the episode with `subtitles_stale` and the changed shots; offsets are never
 * patched here. Generated drafts are recorded in `editing/drafts.json` by input digest, so repeating a call returns
 * `existing` and changed inputs create a new, uniquely named candidate without overwriting any draft.
 */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { changedShots, createMediaToolkit, ENDING_AUDIO_ASSET, ENDING_EFFECT_ASSET, episodeNumberOf, episodePaths, fileSha256,
  prepareEpisode, readSubtitleClockReceipt, subtitleClockPath, subtitleClockRows, type MediaToolkit }
  from '@deepseek-ai/dsh-tool-episode-render/subtitles'
import { localEpisodeSelection } from '@deepseek-ai/dsh-tool-episode-subtitles/selection'

/** Switches of one batch; omitted values keep the project's delivery policy. */
export interface DraftSwitches {
  readonly subtitles?: boolean | undefined
  readonly music?: boolean | undefined
  readonly ending?: boolean | undefined
  readonly watermark?: boolean | undefined
  readonly watermark_text?: string | undefined
}

/** One batch call after argument checks. */
export interface DraftBatch {
  readonly project: string
  readonly display: string
  readonly episodes: readonly number[]
  readonly switches: DraftSwitches
  readonly namePrefix: string
  readonly draftsDir: string
}

/** What one generated episode reports back. */
export interface GeneratedDraft {
  readonly path: string
  readonly musicMissing: boolean
}

/** Services of a batch. */
export interface DraftBatchServices {
  readonly toolkit?: MediaToolkit
  readonly ffmpegPath: string
  readonly ffprobePath: string
  /** Directory of the bundled skills, holding the shipped ending assets. */
  readonly skillsDir: string
  readonly maxEpisodesPerCall: number
  readonly defaultSubtitleVisual?: Parameters<typeof prepareEpisode>[0]['defaultSubtitleVisual']
  readonly enforceSubtitleVisual?: boolean
  /** Generate one draft from a written request file. */
  readonly generate: (requestFile: string, draftsDir: string, signal?: AbortSignal) => Promise<GeneratedDraft>
}

type Refusal = 'subtitles_missing' | 'subtitles_stale' | 'subtitles_unverified' | 'not_selected' | 'draft_failed'
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

interface Ledger { version: 1; episodes: Record<string, { inputs_sha256: string; path: string; name_prefix: string }[]> }

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/**
 * Generate drafts for the requested episodes, in order, up to the per-call limit.
 * @param batch - Project, episodes, switches, name prefix and draft root.
 * @param services - Media executables, bundled assets and the generator.
 * @param signal - Owning call cancellation.
 * @returns Episodes grouped by outcome, with the next call when work remains.
 */
export async function runDraftBatch(batch: DraftBatch, services: DraftBatchServices,
  signal?: AbortSignal): Promise<{ [key: string]: Json }> {
  const toolkit = services.toolkit ?? createMediaToolkit({ ffmpeg: services.ffmpegPath, ffprobe: services.ffprobePath })
  const created: Json[] = [], existing: Json[] = [], refused: Json[] = []
  const needsReview: number[] = [], musicMissing: number[] = []
  const now = batch.episodes.slice(0, services.maxEpisodesPerCall), later = batch.episodes.slice(services.maxEpisodesPerCall)
  await mkdir(join(batch.project, 'editing'), { recursive: true })
  await withFileLock(join(batch.project, 'editing', '.jianying-batch'), async () => {
    const ledgerPath = join(batch.project, 'editing', 'drafts.json')
    const ledger: Ledger = await exists(ledgerPath)
      ? JSON.parse(await readFile(ledgerPath, 'utf8')) as Ledger : { version: 1, episodes: {} }
    for (const episode of now) {
      signal?.throwIfAborted()
      const code = episodeNumberOf(episode)
      const paths = episodePaths(batch.project, code)
      const refuse = (reason: Refusal, extra: { [key: string]: Json } = {}) => { refused.push({ episode, reason, ...extra }) }
      const selection = await localEpisodeSelection(batch.project, episode, toolkit)
      if (selection.kind === 'blocked') { refuse('not_selected', { detail: selection.reason, shots: [...selection.shots] }); continue }
      const manifestPath = selection.manifest
      if (!await exists(paths.subtitle)) { refuse('subtitles_missing'); continue }
      const read = await readSubtitleClockReceipt(paths.subtitle, signal)
      if (read?.receipt.version !== 2 || await fileSha256(paths.subtitle, signal) !== read.receipt.srt_sha256) {
        refuse('subtitles_unverified')
        continue
      }
      const receipt = read.receipt
      const changed = changedShots(receipt, await subtitleClockRows(selection.clock, signal))
      if (changed.length > 0) { refuse('subtitles_stale', { changed_shots: changed }); continue }
      if (receipt.review_pending > 0) needsReview.push(episode)

      const bgmPath = join(batch.project, 'editing', `${code}-bgm.wav`)
      const bgm = batch.switches.music !== false && await exists(bgmPath) ? bgmPath : undefined
      const audioMode = process.platform === 'win32' ? 'embedded' : 'independent'
      const inputs = digest([receipt.srt_sha256, receipt.source_clock_sha256, batch.switches, batch.namePrefix, audioMode,
        bgm === undefined ? null : await fileSha256(bgm, signal)])
      const prior = (ledger.episodes[code] ?? []).find(row => row.inputs_sha256 === inputs)
      if (prior !== undefined && await exists(prior.path)) { existing.push({ episode, path: prior.path }); continue }

      try {
        const stamp = new Date().toISOString().replace(/[-:.]/gu, '')
        const requests = join(batch.project, 'drafts', 'requests')
        await mkdir(requests, { recursive: true })
        const staged = join(requests, `${code}-${stamp}.srt`)
        await copyFile(paths.subtitle, staged)
        await copyFile(subtitleClockPath(paths.subtitle), subtitleClockPath(staged))
        const prepared = await prepareEpisode({ toolkit, project: batch.project, episode: code, shotsPath: manifestPath,
          subtitleSrt: staged,
          ...(services.defaultSubtitleVisual === undefined ? {} : { defaultSubtitleVisual: services.defaultSubtitleVisual }),
          ...(services.enforceSubtitleVisual === undefined ? {} : { enforceSubtitleVisual: services.enforceSubtitleVisual }) })
        let prefix = batch.namePrefix
        for (let version = 2; await exists(join(batch.draftsDir, `${prefix}${code}`)); version++) prefix = `${batch.namePrefix}v${String(version)}-`
        const request = { project: batch.project, episode, name_prefix: prefix,
          videos: prepared.shots.map(shot => join(paths.videoDir, `shot_${String(shot.source.shot).padStart(3, '0')}.mp4`)),
          ...(audioMode === 'embedded' ? { audio_mode: 'embedded' } : { audio: paths.masterAudio }),
          subtitle_srt: paths.subtitle, timeline: paths.timeline,
          ...(bgm === undefined ? {} : { bgm, bgm_role: 'music_only' }),
          ...(batch.switches.music === false ? { music_decision: 'none', decision_reason: '用户在批量导出中关闭了配乐。' } : {}),
          ...(batch.switches.ending === false ? {} : { ending_audio: join(services.skillsDir, ENDING_AUDIO_ASSET.file),
            ending_effect: join(services.skillsDir, ENDING_EFFECT_ASSET.file) }),
          ...(batch.switches.ending === undefined ? {} : { ending: batch.switches.ending }),
          ...(batch.switches.watermark === undefined ? {} : { watermark: batch.switches.watermark }) }
        const requestFile = join(requests, `${code}-${stamp}.json`)
        await writeFileAtomic(requestFile, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
        const draft = await services.generate(requestFile, batch.draftsDir, signal)
        if (draft.musicMissing) musicMissing.push(episode)
        ledger.episodes[code] = [...(ledger.episodes[code] ?? []), { inputs_sha256: inputs, path: draft.path, name_prefix: prefix }]
        await writeFileAtomic(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
        created.push({ episode, path: draft.path })
      } catch (error) {
        signal?.throwIfAborted()
        refuse('draft_failed', { error: (error instanceof Error ? error.message : String(error)).slice(0, 300) })
      }
    }
  }, { waitMs: 600_000, ...(signal === undefined ? {} : { signal }) })
  const stale = refused.flatMap(row => typeof row === 'object' && row !== null && !Array.isArray(row)
    && (row.reason === 'subtitles_stale' || row.reason === 'subtitles_missing' || row.reason === 'subtitles_unverified')
    && typeof row.episode === 'number' ? [row.episode] : [])
  const next = later.length > 0 ? { tool: 'jianying_draft', args: { source: 'local', project: batch.display, episodes: later } }
    : stale.length > 0 ? { tool: 'episode_subtitles', args: { method: 'build', source: 'local', project: batch.display, episodes: stale } }
      : undefined
  return { created, existing, refused, needs_review: needsReview, music_missing: musicMissing, not_started: later,
    ...(batch.switches.watermark_text === undefined ? {} : { unsupported: ['watermark_text'] }),
    ...(next === undefined ? {} : { next }) }
}

/**
 * Default draft name prefix of a project.
 * @param project - Absolute project root.
 * @returns `<project folder>-`.
 */
export function defaultNamePrefix(project: string): string {
  return `${basename(project)}-`
}
