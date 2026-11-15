/** The current renderer ProcessChannel backed by guardian subprocess. */
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { ProcessChannel, MediaCommandOutcome } from '@deepseek-ai/dsh-tool-episode-render'
import type { GuardianMedia, JoinedMedia } from './episode-guardian-fence.ts'

interface Observation {
  readonly done: PromiseSettledResult<SubprocessOutcome>
  readonly range: PromiseSettledResult<boolean>
}

/** Every created handle stays owned until the final execution drain. */
export class GuardianMediaChannel implements ProcessChannel, GuardianMedia {
  private readonly controller = new AbortController()
  private readonly handles = new Map<SubprocessHandle, Promise<Observation>>()
  private accepting = true
  private untrackedSpawn = false
  private joining: Promise<JoinedMedia> | undefined

  constructor(private readonly input: {
    readonly subprocess: SubprocessRuntime
    readonly cwd: string
    readonly ffmpeg: string
    readonly ffprobe: string
    readonly graceMs: number
    readonly stdoutBytes: number
    readonly stderrBytes: number
    readonly signal: AbortSignal
  }) {
    input.signal.addEventListener('abort', this.abort, { once: true })
    if (input.signal.aborted) this.abort()
  }

  private readonly abort = (): void => { this.controller.abort() }

  /** @inheritdoc */
  async run(command: string, args: readonly string[]): Promise<MediaCommandOutcome> {
    if (!this.accepting) throw new Error('episode guardian: media channel is closed')
    this.controller.signal.throwIfAborted()
    if (command !== this.input.ffmpeg && command !== this.input.ffprobe) {
      throw new Error('episode guardian: renderer requested an uncaptured media executable')
    }
    this.untrackedSpawn = true
    let handle: SubprocessHandle
    try { handle = this.input.subprocess.spawn({
      argv: [command, ...args], cwd: this.input.cwd, graceMs: this.input.graceMs,
      signal: this.controller.signal,
      stdio: { stdin: 'ignore', stdout: { maxBytes: this.input.stdoutBytes },
        stderr: { maxBytes: this.input.stderrBytes } },
    }) } catch (error) {
      this.accepting = false
      throw error
    }
    this.untrackedSpawn = false
    // These waits are independent; a failed done must not skip range observation.
    const observed = Promise.allSettled([handle.done, Promise.resolve().then(async () => await handle.waitForExit())] as const)
      .then(([done, range]) => ({ done, range }))
    this.handles.set(handle, observed)
    const observation = await observed
    if (observation.done.status === 'rejected') throw observation.done.reason
    if (observation.range.status === 'rejected') throw observation.range.reason
    // No request-aborted signal is passed to waitForExit. Its normal result is true.
    if (!observation.range.value) throw new Error('episode guardian: media range is not empty')
    this.controller.signal.throwIfAborted()
    const stdout = handle.collected.stdout?.readFrom(0)
    const stderr = handle.collected.stderr?.readFrom(0)
    if (stdout === undefined || stderr === undefined || stdout.lossy || stderr.lossy) {
      throw new Error('episode guardian: complete media output exceeded the configured capture limit')
    }
    return { code: observation.done.value.exitCode ?? 1, stdout: stdout.text, stderr: stderr.text }
  }

  /** Stop admission and await all managed ranges without the request abort signal.
   * @returns Empty only when all completion and range observations succeeded. */
  stopAndJoin(): Promise<JoinedMedia> {
    return this.joining ??= (async () => {
      this.accepting = false
      this.input.signal.removeEventListener('abort', this.abort)
      this.controller.abort()
      const failures: string[] = []
      for (const handle of this.handles.keys()) {
        try { handle.terminate() } catch (error) { failures.push(String(error)) }
      }
      const observations = await Promise.all(this.handles.values())
      for (const observation of observations) {
        if (observation.done.status === 'rejected') failures.push(String(observation.done.reason))
        if (observation.range.status === 'rejected') failures.push(String(observation.range.reason))
        else if (!observation.range.value) failures.push('managed range was not proven empty')
      }
      if (this.untrackedSpawn) failures.push('spawn threw before publishing its managed handle')
      if (failures.length > 0) return { kind: 'unknown', diagnostic: 'media completion or managed-range observation failed' }
      return { kind: 'empty', commands: this.handles.size }
    })()
  }
}
