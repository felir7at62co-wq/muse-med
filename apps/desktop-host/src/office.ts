/**
 * Desktop screenplay revision and authoring tools. Desktop Host mounts this plugin in code with its primary runtime;
 * a deployment without Desktop Host declares it as `@deepseek-ai/dsh-desktop-host/office` with the same config.
 */

import type { Context } from '@deepseek-ai/cordis'
import * as screenplayDocx from './screenplay-docx.ts'
import * as manuscriptRevisions from './manuscript-revisions.ts'
import * as sourceRecovery from './source-recovery.ts'
import * as jianyingDraft from './jianying-draft.ts'
import * as episodeSubtitles from '@deepseek-ai/dsh-tool-episode-subtitles'

/** Loader identity for the application-owned Office composition. */
export const name = 'desktop-office'
/** Application-selected bundled payload and creative tool settings. */
export interface Config {
  /** Bundled primary runtime directory. */
  readonly source: string
  /** Total Markdown byte limit for one Word export. */
  readonly docxMaxInputBytes?: number
  /** Word conversion process deadline in milliseconds. */
  readonly docxTimeoutMs?: number
  /** Maximum managed screenplay project/verification bytes read per file. */
  readonly docxMaxProjectBytes?: number
  /** Creative review policy for screenplay export and final delivery; omission retains strict approval. */
  readonly docxReviewMode?: screenplayDocx.Config['reviewMode']
  /** Word layout of episode headings; omission selects continuous episodes. */
  readonly docxEpisodeLayout?: screenplayDocx.Config['episodeLayout']
  /** Optional manuscript revision budgets; source snapshots remain workspace-local. */
  readonly manuscriptRevisions?: Partial<manuscriptRevisions.Config>
  /** Optional historical read recovery limits; false disables the recovery tool and notices. */
  readonly sourceRecovery?: false | Partial<sourceRecovery.Config>
  /** Optional interpreter override and limits for the bundled editable-draft builder. */
  readonly jianyingDraft?: Partial<Omit<jianyingDraft.Config, 'source'>>
  /** Optional episode subtitle settings; it shares the draft builder's runtime, interpreter and media executables. */
  readonly episodeSubtitles?: Omit<episodeSubtitles.Config, 'source'>
}

/**
 * Register Muse's screenplay and draft tools alongside the profile's Office tools.
 * @param ctx - Profile scope; child plugins declare their own service requirements.
 * @param config - Bundled payload source and creative tool settings.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.plugin(manuscriptRevisions, config.manuscriptRevisions ?? {})
  if (config.sourceRecovery !== false) await ctx.plugin(sourceRecovery, config.sourceRecovery ?? {})
  const ffmpegPath = config.jianyingDraft?.ffmpegPath ?? process.env.DSH_FFMPEG_PATH ?? 'ffmpeg'
  const ffprobePath = config.jianyingDraft?.ffprobePath ?? process.env.DSH_FFPROBE_PATH ?? 'ffprobe'
  await ctx.plugin(jianyingDraft, { source: config.source, timeoutMs: 600_000, graceMs: 1000,
    ffmpegPath, ffprobePath, maxInputBytes: 1024 * 1024, maxOutputBytes: 1024 * 1024, maxBgmGain: 1, ...config.jianyingDraft })
  // Registered once the Muse account service exists; Desktop provides it application-wide.
  void ctx.plugin(episodeSubtitles, { source: config.source, ffmpegPath, ffprobePath,
    ...(config.jianyingDraft?.pythonPath === undefined ? {} : { pythonPath: config.jianyingDraft.pythonPath }),
    ...config.episodeSubtitles })
  await ctx.plugin(screenplayDocx, { source: config.source,
    reviewMode: config.docxReviewMode ?? 'strict', episodeLayout: config.docxEpisodeLayout ?? 'continuous',
    maxInputBytes: config.docxMaxInputBytes ?? 16 * 1024 * 1024, timeoutMs: config.docxTimeoutMs ?? 120_000,
    maxProjectBytes: config.docxMaxProjectBytes ?? 32 * 1024 * 1024 })
}
