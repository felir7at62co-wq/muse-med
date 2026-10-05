/** Resolve the bundled interpreter before download-tool presets are loaded. */

import { resolvePrimaryRuntime } from '@deepseek-ai/dsh-tool-workspace-dependencies'
import { accessSync, constants } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'

/**
 * @param name - media executable.
 * @param source - validated payload.
 * @param environment - deployment environment.
 * @returns existing executable only; never installs.
 */
function mediaExecutable(
  name: 'ffmpeg' | 'ffprobe',
  source: string,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const field = name === 'ffmpeg' ? 'DSH_FFMPEG_PATH' : 'DSH_FFPROBE_PATH'
  const configured = environment[field] ?? environment[name.toUpperCase() + '_PATH']
  if (configured !== undefined) return configured
  const executable = name + (process.platform === 'win32' ? '.exe' : '')
  const candidates = [
    join(dirname(source), 'media', 'ffmpeg', 'bin', executable),
    ...(environment.PATH ?? '')
      .split(delimiter)
      .filter(isAbsolute)
      .map(path => join(path, executable)),
  ]
  for (const path of candidates) {
    if (!isAbsolute(path)) continue
    try {
      accessSync(path, constants.X_OK)
      return path
    } catch (_error) {
      /* Missing optional media runtime remains unavailable. */
    }
  }
  return undefined
}

/**
 * Bind download tools to the validated primary payload without changing PATH.
 * @param source - Bundled primary-runtime directory.
 * @param environment - Host environment with any explicitly configured media executables.
 * @returns New environment containing the absolute bundled Python entry point.
 * @throws If payload metadata, target identifiers or declared files are invalid or missing.
 */
export async function desktopDownloadEnvironment(
  source: string,
  environment: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const runtime = await resolvePrimaryRuntime(source)
  return {
    ...environment,
    MUSE_DOUYIN_PYTHON_PATH: runtime.python,
    DSH_FFMPEG_PATH: mediaExecutable('ffmpeg', source, environment),
    DSH_FFPROBE_PATH: mediaExecutable('ffprobe', source, environment),
  }
}
