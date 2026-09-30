/** Deterministic external media process output for the recorded Session composition. */
import { Readable } from 'node:stream'
import { SubprocessRuntime, type SubprocessHandle, type SubprocessSpawnSpec,
  type SubprocessTerminalHandle, type SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import type { Context } from '@deepseek-ai/cordis'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')

class SnapshotMedia extends SubprocessRuntime {
  async resolveExecutable(command: string): Promise<string> { return command }
  async terminalEnvironment(): Promise<{ platform: 'posix' }> { return { platform: 'posix' } }
  async spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    throw new Error('The video snapshot fixture does not allocate terminals')
  }
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    spec.signal?.throwIfAborted()
    const probing = spec.argv[0] === 'ffprobe'
    const time = Number(spec.argv[spec.argv.indexOf('-ss') + 1])
    const bytes = probing ? Buffer.from(JSON.stringify({ format: { duration: '4' },
      streams: [{ codec_type: 'video', codec_name: 'h264', width: 1, height: 1 }] })) : PNG
    const diagnostic = probing ? '' : `[showinfo] pts_time:${time}`
    return { stdin: undefined, stdout: Readable.from([bytes]), stderr: undefined, control: undefined,
      collected: { stderr: { readFrom: () => ({ text: diagnostic, nextOffset: diagnostic.length, lossy: false }) } },
      done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {}, waitForExit: async () => true,
    }
  }
}

/** Test-only Loader contribution replacing media processes and one volatile source stat version. */
export const name = 'snapshot-video-media'

/** Filesystem stat is the only nondeterministic input replaced alongside external processes. */
export const inject = ['fs']

/**
 * Install deterministic media output while retaining real filesystem and attachment storage.
 * @param ctx - Recorded Session's Loader context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(SnapshotMedia)
  const original = ctx.fs.stat.bind(ctx.fs)
  ctx.effect(() => {
    ctx.fs.stat = async (target, signal) => {
      const info = await original(target, signal)
      return info && target.displayPath.endsWith('fixture.mp4') ? { ...info, version: FsVersion('fixture-video-version') } : info
    }
    return () => { ctx.fs.stat = original }
  })
}
