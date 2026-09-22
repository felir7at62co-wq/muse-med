/** Public preview through a Loader-owned tool registration and injected subprocess service. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessTerminalEnvironment,
} from '@deepseek-ai/dsh-subprocess'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { validateJsonSchemaValue, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { expect, it } from 'vitest'
import * as Bgm from '../src/index.ts'

class Reader implements SubprocessOutputReader {
  constructor(private readonly text: string) {}
  readFrom(_fromByte: number): SubprocessOutputRead {
    return { text: this.text, nextOffset: Buffer.byteLength(this.text), lossy: false }
  }
}

class Handle implements SubprocessHandle {
  readonly control = undefined
  readonly stdin = undefined
  readonly stdout = undefined
  readonly stderr = undefined
  readonly done: Promise<SubprocessOutcome> = Promise.resolve({ exitCode: 0, signal: null })
  readonly collected: SubprocessCollectedOutputs
  constructor(stdout: string, stderr: string) {
    this.collected = { stdout: new Reader(stdout), stderr: new Reader(stderr) }
  }
  terminate(): void {}
  waitForExit(): Promise<boolean> { return Promise.resolve(true) }
}

class FakeSubprocess extends SubprocessRuntime {
  override resolveExecutable(command: string): Promise<string> { return Promise.resolve(command) }
  override terminalEnvironment(): Promise<SubprocessTerminalEnvironment> {
    return Promise.resolve({ platform: 'posix' })
  }
  override spawnTerminal(): Promise<never> { return Promise.reject(new Error('not used')) }
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (spec.argv[0] === 'ffprobe') {
      return new Handle(JSON.stringify({
        format: { format_name: 'mp3', duration: '120', size: '1000' },
        streams: [{ codec_type: 'audio', codec_name: 'mp3', sample_rate: '44100', channels: 2 }],
      }), '')
    }
    if (spec.argv.includes('silencedetect=noise=-45dB:d=0.08')) {
      return new Handle('', 'silence_start: 0\nsilence_end: 0.75 | silence_duration: 0.75\n')
    }
    if (spec.argv.includes('volumedetect')) return new Handle('', 'mean_volume: -20.0 dB\n')
    throw new Error(`unexpected command: ${spec.argv.join(' ')}`)
  }
}

function runContext(): ToolRunContext {
  return {
    callId: 'drama-bgm-loader-spec', rootCallId: 'drama-bgm-loader-spec', name: 'drama_bgm',
    arguments: {}, signal: new AbortController().signal, token: 'drama-bgm-loader-spec',
    deferContext: () => {}, concludeTurn: () => {},
  } as unknown as ToolRunContext
}

it('loads the composer, previews public arguments, and removes its tool on disposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bgm-loader-'))
  const ctx = new Context()
  try {
    await mkdir(join(root, 'editing'), { recursive: true })
    await mkdir(join(root, 'music'), { recursive: true })
    await writeFile(join(root, 'music', 'cue.mp3'), 'cue bytes')
    await writeFile(join(root, 'music', 'tail.mp3'), 'tail bytes')
    // The batch gate wants two tracks per episode and a cut on a package
    // boundary, so the fixture carries both.
    await writeFile(join(root, 'editing', '01-timeline.json'), JSON.stringify({
      body_end: 12, clips: [{ shot: 1, start_us: 0 }, { shot: 2, start_us: 6_000_000 }],
    }))
    await writeFile(join(root, 'editing', 'bgm-plan.json'), JSON.stringify({ episodes: [{
      episode: '01', body_duration_seconds: 12,
      segments: [
        { track: 'cue', source: 'music/cue.mp3', start_seconds: 0, end_seconds: 6, reason: '开场' },
        { track: 'tail', source: 'music/tail.mp3', start_seconds: 6, end_seconds: 12, reason: '收束' },
      ],
    }] }))
    const config = join(root, 'cordis.yml')
    await writeFile(config, [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-subprocess-test'",
      "- name: '@deepseek-ai/dsh-tool-bgm-compose'",
      '',
    ].join('\n'))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', Tools],
      ['@deepseek-ai/dsh-subprocess-test', FakeSubprocess],
      ['@deepseek-ai/dsh-tool-bgm-compose', Bgm],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected module: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    const tool = ctx.tools.get('drama_bgm')
    expect(tool).toBeDefined()
    if (tool === undefined) throw new Error('missing drama_bgm')
    const args = {
      method: 'preview', project: root, episode: 1,
      timeline: 'editing/01-timeline.json', plan: 'editing/bgm-plan.json',
    }
    expect(validateJsonSchemaValue(tool.parameters, args, '')).toEqual([])
    const report = await tool.execute(args, runContext())
    expect(validateJsonSchemaValue(tool.output.schema, report, '')).toEqual([])
    expect(report).toMatchObject({
      method: 'preview', episode: '01', body_duration_seconds: 12, crossfade_seconds: 1.5,
      batch_episodes: ['01'],
      segments: [
        { track: 'cue', source_start_seconds: 1.75, source_start_kind: 'onset',
          source_mean_db: -20, applied_gain_db: 2.5, reason: '开场' },
        { track: 'tail', source_start_seconds: 1.75, source_start_kind: 'onset',
          source_mean_db: -20, applied_gain_db: 2.5, reason: '收束' },
      ],
      media: { codec: '', sample_rate: 0, channels: 0, duration_seconds: 0, size_bytes: 0, sha256: '' },
    })
    const entry = [...ctx.loader.entries()].find(row => row.options.name === '@deepseek-ai/dsh-tool-bgm-compose')
    await entry?.fiber?.dispose()
    expect(ctx.tools.get('drama_bgm')).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
