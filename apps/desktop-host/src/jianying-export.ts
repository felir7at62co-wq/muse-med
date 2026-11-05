/** Render an approved draft through the installed Windows editor. */
import { access, lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { default as SubprocessRuntime, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'

/** Exact saved draft and unique output selected by the delivery service. */
export interface JianyingExportInput {
  readonly draftName: string
  readonly draftPath: string
  readonly outputPath: string
}

/** Managed PowerShell selection and process limits for native export. */
export interface JianyingExportConfig {
  readonly timeoutMs: number
  readonly graceMs: number
  readonly windowsPowerShellPath?: string
  /** PID of the Supermuse window owner, eligible to hand focus to Jianying. */
  readonly ownerPid?: number
}

async function assertRegularPath(path: string, kind: 'directory' | 'file'): Promise<void> {
  const entry = await lstat(path)
  if ((kind === 'file' ? !entry.isFile() : !entry.isDirectory())
    || relative(path, await realpath(path)) !== '') {
    throw new Error('Jianying export requires regular local draft and output paths')
  }
}

async function assertNewFile(path: string): Promise<void> {
  try { await lstat(path) }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  throw new Error('The Jianying export destination already exists')
}

/**
 * Render a new native MP4, using only the verified editor window and requested destination.
 * @param subprocess - Managed process owner.
 * @param input - Exact saved draft and absolute path of the new output.
 * @param config - Runtime selection and operation deadline.
 * @param signal - Optional cancellation of native editor automation.
 * @returns The new export path after the editor has completed writing.
 */
export async function exportJianyingDraft(subprocess: SubprocessRuntime, input: JianyingExportInput,
  config: JianyingExportConfig, signal?: AbortSignal): Promise<{ path: string }> {
  if (process.platform !== 'win32') throw new Error('Native Jianying export requires Windows')
  if (!isAbsolute(input.draftPath) || !isAbsolute(input.outputPath)
    || basename(input.draftPath) !== input.draftName || !/^[a-zA-Z0-9_-]{1,120}$/u.test(input.draftName)
    || !/^[a-z0-9_-]{1,120}\.mp4$/iu.test(basename(input.outputPath))) {
    throw new Error('Jianying export needs an exact draft and a new absolute MP4 path')
  }
  const directory = dirname(input.outputPath)
  await assertRegularPath(input.draftPath, 'directory')
  await assertRegularPath(join(input.draftPath, 'draft_content.json'), 'file')
  await assertRegularPath(directory, 'directory')
  await assertNewFile(input.outputPath)
  const systemRoot = process.env.SystemRoot
  if (config.windowsPowerShellPath === undefined && systemRoot === undefined) {
    throw new Error('Windows PowerShell is unavailable')
  }
  const powershell = config.windowsPowerShellPath ?? join(systemRoot ?? '', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (!isAbsolute(powershell)) throw new Error('Windows PowerShell must use an absolute executable path')
  await access(powershell)
  const manifest = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-drama-skills/package.json'))
    .replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2')
  const script = join(dirname(manifest), 'skills', 'tweet-drama-draft-build', 'scripts', 'windows', 'native-export.ps1')
  const deadline = AbortSignal.timeout(config.timeoutMs)
  const combined = signal === undefined ? deadline : AbortSignal.any([deadline, signal])
  combined.throwIfAborted()
  const child = subprocess.spawn({
    argv: [powershell, '-NoProfile', '-NonInteractive', '-STA', '-File', script, '-DraftName', input.draftName,
      '-DraftPath', input.draftPath, '-OutputPath', input.outputPath, '-TimeoutMs', String(config.timeoutMs),
      ...(config.ownerPid === undefined ? [] : ['-OwnerPid', String(config.ownerPid)])],
    cwd: directory, signal: combined, graceMs: config.graceMs,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 8192 } },
  })
  let outcome: SubprocessOutcome
  try { outcome = await child.done } finally { await child.waitForExit() }
  combined.throwIfAborted()
  const receipt = child.collected.stdout?.readFrom(0)
  if (outcome.exitCode !== 0 || outcome.signal || receipt?.lossy || receipt?.text.trim() !== 'NATIVE_EXPORT_COMPLETE') {
    const diagnostic = child.collected.stderr?.readFrom(0).text.trim()
    throw new Error(diagnostic || 'Native Jianying export did not finish')
  }
  await assertRegularPath(input.outputPath, 'file')
  if ((await lstat(input.outputPath)).size === 0) throw new Error('Jianying returned an empty MP4')
  return { path: input.outputPath }
}
