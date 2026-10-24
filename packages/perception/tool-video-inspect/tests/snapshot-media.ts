/** Deterministic external media process output for the recorded Session composition. */
import { Readable } from 'node:stream'
import { basename } from 'node:path'
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
    const selectedIndex = spec.argv.join(' ').match(/select='eq\(n,(\d+)\)'/)
    const time = Number(spec.argv[spec.argv.indexOf('-ss') + 1]) + (selectedIndex === null ? 0 : Number(selectedIndex[1]) / 10)
    const scanning = spec.argv.some(value => value.includes('gte(scene,0)'))
    const thumbnails = spec.argv.includes('rawvideo')
    // Output cutoff can lag filter evaluation; only the analysis time predicate
    // excludes these lookahead frames from the recorded episode evidence.
    const filter = spec.argv[spec.argv.indexOf('-vf') + 1] ?? ''
    const bound = /lt\(t,([\d.e+-]+)\)/.exec(filter)
    const end = bound === null ? Infinity : Number(bound[1])
    const metadata = [{ index: 0, time: 0, score: 0 }, { index: 20, time: 2, score: 0.9 },
      { index: 39, time: 3.9, score: 0 }, { index: 41, time: 4.1, score: 0 }]
    const bytes = scanning ? Buffer.from(metadata.filter(frame => frame.time < end)
      .map(frame => `frame:${frame.index} pts:${frame.index} pts_time:${frame.time}\nlavfi.scene_score=${frame.score}\n`).join(''))
      : thumbnails ? Buffer.concat(Array.from({ length: 20 }, (_, i) => i).filter(i => i / 4 < end)
        .map(i => Buffer.alloc(48 * 32 * 3, i < 8 ? 0 : 255)))
        : probing ? Buffer.from(JSON.stringify({ format: { duration: '4' },
          streams: [{ codec_type: 'video', codec_name: 'h264', width: 1, height: 1 }] })) : PNG
    const diagnostic = probing ? '' : `[showinfo] pts_time:${time}`
    return { stdin: undefined, stdout: Readable.from([bytes]), stderr: undefined, control: undefined,
      collected: { stderr: { readFrom: () => ({ text: diagnostic, nextOffset: diagnostic.length, lossy: false }) } },
      done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {}, waitForExit: async () => true,
    }
  }
}

/** Test-only Loader contribution replacing media processes and stat versions of immutable workspace seeds. */
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
      const version = basename(target.displayPath) === 'fixture.mp4' ? 'fixture-video-version'
        : basename(target.displayPath) === 'episode.md' ? 'fixture-draft-version'
          : basename(target.displayPath) === 'transcript.json' ? 'fixture-transcript-version' : undefined
      return info && version !== undefined ? { ...info, version: FsVersion(version) } : info
    }
    return () => { ctx.fs.stat = original }
  })
}
