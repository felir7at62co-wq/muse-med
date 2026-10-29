/** Desktop Office skills and bundled authoring dependencies. */

import { realpathSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeArchivePath } from './office-engine.ts'
import type { Context } from '@deepseek-ai/cordis'
import * as screenplayDocx from './screenplay-docx.ts'
import * as manuscriptRevisions from './manuscript-revisions.ts'
import * as sourceRecovery from './source-recovery.ts'
import * as jianyingDraft from './jianying-draft.ts'
import * as officeSkills from '@deepseek-ai/dsh-skill-office'
import * as workspaceDependencies from '@deepseek-ai/dsh-tool-workspace-dependencies'

/** Loader identity for the application-owned Office composition. */
export const name = 'desktop-office'
/** Application-selected bundled payload and installation directories. */
export interface Config {
  /** Bundled payload directory. Missing sibling `office-skills` resources fail Host startup. */
  readonly source: string
  /** Harness-home directory where workspace dependencies are installed. */
  readonly root: string
  /** Prepared or ASAR-contained application dependency directory. */
  readonly runtimeDir: string
  /** Total Markdown byte limit for one Word export. */
  readonly docxMaxInputBytes?: number
  /** Word conversion process deadline in milliseconds. */
  readonly docxTimeoutMs?: number
  /** Maximum managed screenplay project/verification bytes read per file. */
  readonly docxMaxProjectBytes?: number
  /** Creative review policy for screenplay export and final delivery; omission retains strict approval. */
  readonly docxReviewMode?: screenplayDocx.Config['reviewMode']
  /** Optional manuscript revision budgets; source snapshots remain workspace-local. */
  readonly manuscriptRevisions?: Partial<manuscriptRevisions.Config>
  /** Optional historical read recovery limits; false disables the recovery tool and notices. */
  readonly sourceRecovery?: false | Partial<sourceRecovery.Config>
  /** Optional interpreter override and limits for the bundled editable-draft builder. */
  readonly jianyingDraft?: Partial<Omit<jianyingDraft.Config, 'source'>>
}

/**
 * Enable offline Office authoring and structural checks in the Desktop profile.
 * @param ctx - Profile scope; child plugins declare their own service requirements.
 * @param config - Bundled payload source and Harness-home installation root.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.plugin(workspaceDependencies, config)
  await ctx.plugin(manuscriptRevisions, config.manuscriptRevisions ?? {})
  if (config.sourceRecovery !== false) await ctx.plugin(sourceRecovery, config.sourceRecovery ?? {})
  await ctx.plugin(jianyingDraft, { source: config.source, timeoutMs: 600_000, graceMs: 1000,
    ffmpegPath: process.env.DSH_FFMPEG_PATH ?? 'ffmpeg', ffprobePath: process.env.DSH_FFPROBE_PATH ?? 'ffprobe',
    maxInputBytes: 1024 * 1024, maxOutputBytes: 1024 * 1024, maxBgmGain: 1, ...config.jianyingDraft })
  await ctx.plugin(screenplayDocx, { source: config.source,
    reviewMode: config.docxReviewMode ?? 'strict',
    maxInputBytes: config.docxMaxInputBytes ?? 16 * 1024 * 1024, timeoutMs: config.docxTimeoutMs ?? 120_000,
    maxProjectBytes: config.docxMaxProjectBytes ?? 32 * 1024 * 1024 })
  const archive = runtimeArchivePath(config.runtimeDir) === undefined ? undefined : dirname(realpathSync(config.runtimeDir))
  const manifest = fileURLToPath(import.meta.resolve('@deepseek-ai/libreoffice-kit/package.json'))
  const packageRoot = dirname(archive === undefined ? manifest : join(`${archive}.unpacked`, relative(archive, manifest)))
  await ctx.plugin(officeSkills, {
    assetRoot: join(dirname(config.source), 'office-skills'),
    node: join(config.source, 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
    cli: join(packageRoot, 'lib', 'cli.js'),
  })
}
