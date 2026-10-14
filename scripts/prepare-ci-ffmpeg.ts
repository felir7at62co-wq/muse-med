/** Prepare hash-locked FFmpeg/ffprobe for Windows source CI without a package feed. */

import * as childProcess from 'node:child_process'
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { obtain, unzip, type MediaResource } from '../apps/desktop/scripts/media-resources.ts'
import { validateMediaLock } from '../apps/desktop/scripts/prepare-media-runtime.ts'

async function execute(binary: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await promisify(childProcess.execFile)(binary, args, { cwd, encoding: 'utf8' })
  return stdout
}

function requireMediaStreams(stdout: string): void {
  const value: unknown = JSON.parse(stdout)
  if (typeof value !== 'object' || value === null || !('streams' in value) || !Array.isArray(value.streams)
    || value.streams.length !== 2 || !value.streams.every((stream: unknown) =>
    typeof stream === 'object' && stream !== null && 'codec_name' in stream
    && (stream.codec_name === 'h264' || stream.codec_name === 'aac'))
    || !value.streams.some((stream: { codec_name: string }) => stream.codec_name === 'h264')
    || !value.streams.some((stream: { codec_name: string }) => stream.codec_name === 'aac')) {
    throw new Error('CI FFmpeg smoke did not produce H264/AAC streams')
  }
}

/**
 * Download and qualify the locked Windows executables before adding their directory to the job path.
 * @param parent - Existing runner-owned temporary directory; preparation allocates a private child.
 * @param pathFile - GitHub Actions path file, appended only after both executables and media smoke pass.
 * @param resource - Validated desktop FFmpeg resource with exact archive size and SHA-256.
 * @returns Qualified executable directory retained under runner cleanup; failures remove its private child.
 */
export async function prepareCiFfmpeg(parent: string, pathFile: string, resource: MediaResource): Promise<string> {
  const root = await mkdtemp(join(parent, 'dsh-ci-ffmpeg-'))
  try {
    const archive = await obtain(resource, root)
    await unzip(archive, join(root, 'runtime'))
    const bin = join(root, 'runtime', 'ffmpeg', 'bin')
    for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
      const binary = join(bin, name)
      if (!(await stat(binary)).isFile()) throw new Error(`CI media executable is not a regular file: ${name}`)
      await execute(binary, ['-version'], root)
    }
    await writeFile(join(root, 'captions.srt'), '1\n00:00:00,000 --> 00:00:00,400\nCI media smoke\n', 'utf8')
    await execute(join(bin, 'ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'color=c=black:s=64x48:r=5:d=0.4', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '0.4',
      '-vf', 'subtitles=captions.srt', '-af', 'loudnorm', '-c:v', 'libx264', '-threads', '1',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', 'smoke.mp4'], root)
    requireMediaStreams(await execute(join(bin, 'ffprobe.exe'), ['-v', 'error', '-show_entries',
      'stream=codec_name', '-of', 'json', 'smoke.mp4'], root))
    await appendFile(pathFile, `${bin}\n`, 'utf8')
    return bin
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function main(): Promise<void> {
  const { RUNNER_TEMP, GITHUB_PATH } = process.env
  if (!RUNNER_TEMP || !GITHUB_PATH) throw new Error('CI FFmpeg preparation requires RUNNER_TEMP and GITHUB_PATH')
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('CI FFmpeg preparation requires Windows x64')
  const lock = validateMediaLock(JSON.parse(await readFile(
    new URL('../apps/desktop/scripts/media-runtime.lock.json', import.meta.url), 'utf8')))
  const bin = await prepareCiFfmpeg(RUNNER_TEMP, GITHUB_PATH, lock.ffmpeg)
  console.log(`CI FFmpeg/ffprobe, H264/AAC, subtitles and loudnorm qualified: ${bin}`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) await main()
