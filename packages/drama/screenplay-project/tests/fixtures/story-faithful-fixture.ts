/** Shared real headless launch and original synthetic media for screenplay and Host delivery tests. */
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { z } from 'zod'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { PROJECT_FILE } from '../../src/schema.ts'

/** Actual user request deliberately limited to this synthetic work, not future projects. */
export const STORY_FIXTURE_REQUEST = '把这个原创合成视频写成故事忠实剧本，允许表演细节、短OS和承接对白；保留关键事件、关系、条件和揭晓。'
/** Supported Loader patch for the real project/video tools and keyless Adapter. */
export const STORY_FIXTURE_PATCH = fileURLToPath(new URL('./story-faithful.cordis.yml', import.meta.url))

/**
 * Generate a 128-second original tiny blue/red video and an explicitly authored synthetic transcript.
 * @param cwd - Caller-owned isolated workspace; no real/private source media is used.
 */
export async function prepareStoryFixture(cwd: string): Promise<void> {
  await mkdir(cwd, { recursive: true })
  await promisify(execFile)('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:size=64x48:rate=1:d=64',
    '-f', 'lavfi', '-i', 'color=c=red:size=64x48:rate=1:d=64', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(cwd, 'original.mp4')], { timeout: 20_000 })
  await writeFile(join(cwd, 'authored-transcript.json'), JSON.stringify([
    { start: 30, end: 32, speaker_id: '阿岚', text: '别把我当外人。屏幕变红，我就走。' },
    { start: 65, end: 67, speaker_id: '阿远', text: '别走。红屏只是警报，不是赶你走。' },
  ]))
  await writeFile(join(cwd, 'synthetic-source-disclosure.txt'), 'Original synthetic 128-second blue/red color video; no actual actors or audio. The transcript is authored test input, not ASR. Semantic reports are fixed synthetic judgments; the application checks exact locations, hashes, actual model rounds and declared deviations, not story meaning.\n')
}

/** Optional persistent control and an additional Host-owned Loader overlay. */
export interface StoryFixtureRunOptions {
  phase?: 'full' | 'checkpoint' | 'resume-pending' | 'accepted-cold' | 'export-negative'
  sessionId?: string
  prompt?: string
  patches?: string[]
  expectedError?: string
  env?: NodeJS.ProcessEnv
}

/**
 * Start the supported dsh headless profile in the same home and persistent Session store.
 * @param cwd - Original media, .dsh attachment store, and .sessions logs remain here.
 * @param options - Keyless fixture phase, existing Session identity, and optional extra patches.
 * @returns Captured process output; the caller owns cleanup of cwd.
 */
export async function runStoryFixture(cwd: string, options: StoryFixtureRunOptions = {}) {
  return runLoaderSmoke({ label: `story-faithful ${options.phase ?? 'full'} headless PTC`, cwd,
    binScript: fileURLToPath(new URL('../../../../../apps/cli/src/bin.ts', import.meta.url)), configPath: STORY_FIXTURE_PATCH,
    tsconfigPath: fileURLToPath(new URL('../../../../../tsconfig.json', import.meta.url)), sourceImport: 'tsx/esm', mode: 'src',
    processTimeoutMs: 90_000,
    env: { SCREENPLAY_STORY_FIXTURE_MODE: options.phase ?? 'full',
      ...options.expectedError === undefined ? {} : { SCREENPLAY_STORY_EXPECTED_ERROR: options.expectedError }, ...options.env },
    binArgs: ['--profile', 'headless', '--patch', STORY_FIXTURE_PATCH, ...options.patches?.flatMap(patch => ['--patch', patch]) ?? [],
      ...options.sessionId === undefined ? [] : ['--session-id', options.sessionId], '--json', options.prompt ?? STORY_FIXTURE_REQUEST],
  })
}

/**
 * Read real fixture output and original durable-store paths for a subsequent Host-owned headless task.
 * @param cwd - Workspace passed to runStoryFixture.
 * @param stdout - Headless process output that contains its actual Session identity.
 * @returns Current project, paths, and real Session id; no proof or log fields are synthesized.
 */
export async function readStoryFixture(cwd: string, stdout: string) {
  const session = stdout.split('\n').map((line) => { try { return z.unknown().parse(JSON.parse(line)) } catch { return undefined } })
    .map(value => z.object({ type: z.literal('session'), sessionId: z.string() }).safeParse(value)).find(value => value.success)
  if (!session?.success) throw Error('story fixture omitted its actual headless Session identity')
  const projectPath = join(cwd, 'project.json'), project = PROJECT_FILE.parse(JSON.parse(await readFile(projectPath, 'utf8')))
  const candidate = project.candidates.at(-1)
  const stem = candidate === undefined ? undefined : `episode-${candidate.episode}-${candidate.id.slice(2)}`
  return { cwd, root: cwd, projectPath, project, sessionId: session.data.sessionId,
    home: join(cwd, '.dsh'), logs: join(cwd, '.sessions'),
    input: stem === undefined ? undefined : join(cwd, 'delivery', `${stem}.md`),
    report: stem === undefined ? undefined : join(cwd, 'delivery', `${stem}.modification-notes.md`) }
}
