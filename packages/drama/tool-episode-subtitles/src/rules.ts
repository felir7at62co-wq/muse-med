/**
 * The shared correction and layout rules, run as the vendored Python module through one managed process per call.
 *
 * The rule files are byte copies of Jingliu's modules (`verify-subtitle-rules-copy`). Their digest is computed here
 * the same way `run.py` computes it, so per-shot caches can be checked before any process starts, and a result whose
 * reported digest differs is refused.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { default as SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { RulesShot, RulesShotResult, SubtitleRules } from './types.ts'

/** Files whose bytes define the rules, in digest order; must match `RULE_FILES` in `run.py`. */
export const RULE_FILES = ['subtitle_align.py', 'subtitle_cues.py', 'run.py'] as const

/**
 * Locate the vendored rules shipped in `@deepseek-ai/dsh-drama-skills`, outside `app.asar` in a packaged Desktop.
 * @returns The `subtitle_rules` directory.
 */
export function bundledRulesDirectory(): string {
  const manifest = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-drama-skills/package.json'))
    .replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2')
  return join(dirname(manifest), 'skills', 'tweet-drama-draft-build', 'scripts', 'subtitle_rules')
}

/**
 * Digest the rule files of one directory.
 * @param directory - The vendored `subtitle_rules` directory.
 * @returns Lowercase SHA-256 over each name and its bytes.
 */
export async function rulesDigest(directory: string): Promise<string> {
  const hash = createHash('sha256')
  for (const name of RULE_FILES) {
    hash.update(Buffer.concat([Buffer.from(`${name}\0`, 'utf8'), await readFile(join(directory, name)), Buffer.from('\0')]))
  }
  return hash.digest('hex')
}

/** Process settings of the rules runner. */
export interface PythonRulesOptions {
  readonly subprocess: SubprocessRuntime
  /** Resolve the interpreter that has the pinned `pypinyin`. */
  readonly python: () => Promise<string>
  /** The vendored `subtitle_rules` directory. */
  readonly directory: string
  readonly maxChars: number
  readonly spaceWidth: number
  readonly timeoutMs: number
  readonly graceMs: number
  readonly maxOutputBytes: number
}

/**
 * Run the rules through isolated Python with a UTF-8 JSON pipe.
 * @param options - Interpreter, directory, layout width and process limits.
 * @returns Rules whose failures name the interpreter and never yield partial subtitles.
 */
export function pythonRules(options: PythonRulesOptions): SubtitleRules {
  let digest: Promise<string> | undefined
  const rules: SubtitleRules = {
    digest: () => digest ??= rulesDigest(options.directory),
    run: async (shots: readonly RulesShot[], signal?: AbortSignal): Promise<RulesShotResult[]> => {
      if (shots.length === 0) return []
      const python = await options.python()
      const timeout = AbortSignal.timeout(options.timeoutMs)
      const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
      const handle = options.subprocess.spawn({
        argv: [python, '-B', '-I', '-X', 'utf8', join(options.directory, 'run.py')], cwd: options.directory,
        signal: combined, graceMs: options.graceMs,
        stdio: { stdin: { data: JSON.stringify({ max_chars: options.maxChars, space_width: options.spaceWidth, shots }) },
          stdout: { maxBytes: options.maxOutputBytes }, stderr: { maxBytes: 65_536 } },
      })
      try { await handle.done } finally { await handle.waitForExit() }
      signal?.throwIfAborted()
      if (timeout.aborted) throw new HarnessError(`字幕规则超过 ${String(options.timeoutMs)} 毫秒未完成（Python：${python}）。`, 'EPISODE_SUBTITLES_RULES_TIMEOUT')
      const stdout = handle.collected.stdout?.readFrom(0)
      if (stdout === undefined || stdout.lossy || !stdout.text.trim()) {
        const stderr = handle.collected.stderr?.readFrom(0).text.trim()
        throw new HarnessError(`字幕规则没有返回结果（Python：${python}）：${stderr || '没有诊断输出'}`, 'EPISODE_SUBTITLES_RULES_UNAVAILABLE')
      }
      const value = JSON.parse(stdout.text) as {
        error?: { code: string; message: string }
        rules_sha256?: string
        shots?: RulesShotResult[]
      }
      if (value.error !== undefined) {
        throw new HarnessError(`字幕规则无法运行（Python：${python}）：${value.error.message}`, 'EPISODE_SUBTITLES_RULES_UNAVAILABLE')
      }
      if (value.rules_sha256 !== await rules.digest() || !Array.isArray(value.shots) || value.shots.length !== shots.length) {
        throw new HarnessError('字幕规则返回的规则摘要或镜头数与请求不符，请重新安装 Muse。', 'EPISODE_SUBTITLES_RULES_MISMATCH')
      }
      return value.shots
    },
  }
  return rules
}
