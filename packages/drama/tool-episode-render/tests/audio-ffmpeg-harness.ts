/** Host-qualified FFmpeg discovery and instance-owned offline media children. */

import { execFile, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { dirname, isAbsolute, join } from 'node:path'
import type { ProcessChannel } from '../src/types.ts'

export const ffmpeg = process.env.MUSE_FFMPEG_EXECUTABLE || process.env.FFMPEG_PATH || 'ffmpeg'
export const ffprobe = process.env.FFPROBE_PATH || (isAbsolute(ffmpeg)
  ? join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe')
export const hasFfmpeg = spawnSync(ffmpeg, ['-version'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 }).status === 0

/** Create a per-test runner; dispose and await it in afterEach/finally. */
export function createMediaRunner() {
  const active = new Map<ChildProcess, Promise<void>>()
  const runCommand = async (command: string, args: readonly string[]) => await new Promise<{
    code: number
    stdout: string
    stderr: string
    interrupted: boolean
    signal: string | null
  }>((resolve) => {
    const environment = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/iu.test(key)))
    const child = execFile(command, [...args], {
      windowsHide: true, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: environment,
    }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 127,
        stdout, stderr, interrupted: error?.killed ?? false, signal: error?.signal ?? null })
    })
    const closed = new Promise<void>((done) => { child.once('close', () => { active.delete(child); done() }) })
    active.set(child, closed)
  })
  return {
    runCommand,
    channel: { run: runCommand } satisfies ProcessChannel,
    dispose: async (): Promise<void> => {
      const remaining = [...active]
      for (const [child] of remaining) child.kill()
      await Promise.all(remaining.map(([, closed]) => closed))
    },
  }
}
