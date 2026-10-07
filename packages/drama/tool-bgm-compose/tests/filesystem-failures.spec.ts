/** Filesystem failures retain existing deliveries and surface cleanup failures. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runDramaBgm } from '../src/compose.ts'
import { publishNoClobber } from '../src/media.ts'
import type { ProcessChannel } from '../src/types.ts'

const faults = vi.hoisted(() => ({ stat: '', unlink: '', unavailableAncestors: false, rollback: '' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      if (String(args[0]) === faults.stat) throw Object.assign(new Error('delivery access denied'), { code: 'EACCES' })
      return await actual.stat(...args)
    },
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      if (faults.unavailableAncestors) throw Object.assign(new Error('filesystem root unavailable'), { code: 'ENOENT' })
      return await actual.realpath(...args)
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      const path = String(args[0])
      if (faults.unlink && basename(path).startsWith(faults.unlink)) throw Object.assign(new Error('temporary cleanup denied'), { code: 'EACCES' })
      if (path === faults.rollback) {
        await actual.unlink(...args)
        throw Object.assign(new Error('concurrent removal'), { code: 'ENOENT' })
      }
      await actual.unlink(...args)
    },
  }
})

const roots: string[] = []
afterEach(async () => {
  faults.stat = ''; faults.unlink = ''; faults.rollback = ''; faults.unavailableAncestors = false
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const project = await mkdtemp(join(tmpdir(), 'bgm-filesystem-'))
  roots.push(project)
  const source = join(project, 'source.mp3'), timeline = join(project, 'timeline.json'), plan = join(project, 'plan.json')
  const output = join(project, 'audio', 'bgm', '01.wav')
  await writeFile(source, 'music')
  await writeFile(timeline, '{"body_end":10,"clips":[{"start_us":0}]}')
  await writeFile(plan, JSON.stringify({ episodes: [{ episode: '01', body_duration_seconds: 10,
    segments: [{ track: 'music', source, start_seconds: 0, end_seconds: 10, reason: 'scene', source_start_seconds: 0 }] }] }))
  const channel: ProcessChannel = { run: async (command, args) => {
    if (command === 'ffprobe') return { code: 0, stderr: '', stdout: JSON.stringify({
      format: { format_name: 'wav', duration: '10', size: '5' },
      streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '48000', channels: 2 }],
    }) }
    if (args.includes('volumedetect')) return { code: 0, stdout: '', stderr: 'mean_volume: -20 dB' }
    const target = args[args.length - 1]
    if (target === undefined) throw new Error('missing mix target')
    await writeFile(target, 'wav')
    return { code: 0, stdout: '', stderr: '' }
  } }
  const args = { method: 'compose' as const, project, episode: 1, timeline, plan, output }
  return { project, output, channel, args, settings: { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', channel } }
}

it('reports an inaccessible existing delivery without replacing or publishing it', async () => {
  const f = await fixture()
  await mkdir(dirname(f.output), { recursive: true }); await writeFile(f.output, 'retained delivery')
  faults.stat = f.output
  await expect(runDramaBgm(f.args, f.settings)).rejects.toThrow('delivery access denied')
  expect(await readFile(f.output, 'utf8')).toBe('retained delivery')
})

it('preserves a plan access failure and does not create a delivery', async () => {
  const f = await fixture()
  faults.stat = f.args.plan
  await expect(runDramaBgm(f.args, f.settings)).rejects.toThrow('delivery access denied')
  expect(await readFile(join(f.project, 'source.mp3'), 'utf8')).toBe('music')
  expect(await readdir(f.project)).toEqual(['plan.json', 'source.mp3', 'timeline.json'])
})

it('stops creating directories when the filesystem loses all existing ancestors', async () => {
  const f = await fixture()
  const channel: ProcessChannel = { run: async (command, args, signal) => {
    const result = await f.channel.run(command, args, signal)
    if (args.includes('volumedetect')) faults.unavailableAncestors = true
    return result
  } }
  await expect(runDramaBgm(f.args, { ...f.settings, channel })).rejects.toThrow('filesystem root unavailable')
  expect(await readdir(f.project)).toEqual(['plan.json', 'source.mp3', 'timeline.json'])
})

it('surfaces a failed temporary cleanup after the media command fails', async () => {
  const f = await fixture()
  faults.unlink = '.01-'
  const channel: ProcessChannel = { run: async (command, args, signal) => {
    if (command === 'ffmpeg' && !args.includes('volumedetect')) throw new Error('mix failed')
    return await f.channel.run(command, args, signal)
  } }
  await expect(runDramaBgm(f.args, { ...f.settings, channel })).rejects.toThrow('temporary cleanup denied')
  expect((await readdir(dirname(f.output))).every(path => path.startsWith('.01-'))).toBe(true)
})

it('accepts a concurrent removal of its own rollback destination while retaining the original conflict', async () => {
  const f = await fixture()
  const staged = join(f.project, 'staged.wav'), conflict = join(f.project, 'conflict.json')
  await writeFile(staged, 'wav'); await writeFile(conflict, 'retained report')
  const final = join(f.project, 'published.wav')
  faults.rollback = final
  await expect(publishNoClobber([[staged, final], [staged, conflict]])).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(conflict, 'utf8')).toBe('retained report')
  expect(await readFile(staged, 'utf8')).toBe('wav')
})

it('surfaces an inaccessible rollback destination instead of hiding an incomplete rollback', async () => {
  const f = await fixture()
  const staged = join(f.project, 'staged.wav'), conflict = join(f.project, 'conflict.json')
  await writeFile(staged, 'wav'); await writeFile(conflict, 'retained report')
  const final = join(f.project, '.blocked-published.wav')
  faults.unlink = '.blocked-'
  await expect(publishNoClobber([[staged, final], [staged, conflict]])).rejects.toThrow('temporary cleanup denied')
  expect(await readFile(final, 'utf8')).toBe('wav')
  expect(await readFile(conflict, 'utf8')).toBe('retained report')
})
