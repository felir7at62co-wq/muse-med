/** Concurrent changes and filesystem failures do not replace subtitle evidence. */
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { resolveSubtitleOverlay } from '../src/subtitle-plan.ts'

const faults = vi.hoisted(() => ({ lstatPath: '', lstatAt: 0, lstatCount: 0,
  changeAtAllocation: '', report: '', output: '', mode: '', rollback: false, linkTarget: '' }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  const denied = () => Object.assign(new Error('subtitle access denied'), { code: 'EACCES' })
  return { ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (String(args[0]) === faults.lstatPath && ++faults.lstatCount === faults.lstatAt) throw denied()
      if (faults.rollback && faults.mode === 'rollback-error' && String(args[0]) === faults.output) throw denied()
      return await actual.lstat(...args)
    },
    mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
      const directory = await actual.mkdtemp(...args)
      if (faults.changeAtAllocation) {
        await actual.writeFile(faults.changeAtAllocation, 'changed during allocation')
        faults.changeAtAllocation = ''
      }
      return directory
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (args[0] !== faults.report || !faults.mode) {
        await actual.writeFile(...args)
        return
      }
      faults.rollback = true
      if (faults.mode === 'changed-output') await actual.writeFile(faults.output, 'concurrent subtitle')
      if (faults.mode === 'linked-output') {
        await actual.unlink(faults.output)
        await actual.symlink(faults.linkTarget, faults.output, process.platform === 'win32' ? 'junction' : 'dir')
      }
      if (faults.mode === 'concurrent-report') await actual.writeFile(faults.report, 'concurrent report', { flag: 'wx' })
      throw denied()
    },
  }
})
const roots: string[] = []
afterEach(async () => {
  Object.assign(faults, { lstatPath: '', lstatAt: 0, lstatCount: 0, changeAtAllocation: '',
    report: '', output: '', mode: '', rollback: false, linkTarget: '' })
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
async function fixture() {
  const project = await mkdtemp(join(tmpdir(), 'subtitle-failure-'))
  roots.push(project)
  const subtitleSrt = join(project, 'original.srt'), planPath = join(project, 'plan.json')
  const video = join(project, 'video/01/shot_001.mp4')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(project, 'video/01'), { recursive: true })
  await writeFile(video, 'source video')
  await writeFile(subtitleSrt, '1\n00:00:00,000 --> 00:00:01,000\n台词\n')
  await writeFile(planPath, JSON.stringify({ schema_version: 1, decisions: [{ shot: 1, source_sha256: digest('source video'),
    start_seconds: 0, end_seconds: 1, text: '台词', action: 'retain_embedded', reason: 'reviewed', evidence_paths: [] }] }))
  return { project, episode: '01', subtitleSrt, planPath, video,
    timeline: { clips: [{ shot: 1, startUs: 0, durationUs: 1_000_000 }], bodyEndSeconds: 1 } }
}

it.each([1, 2])('reports output inspection failure at stage %s without publishing subtitles', async (inspection) => {
  const input = await fixture(), outputSrt = join(input.project, 'out.srt')
  Object.assign(faults, { lstatPath: outputSrt, lstatAt: inspection })
  await expect(resolveSubtitleOverlay({ ...input, outputSrt })).rejects.toMatchObject({ code: 'EACCES' })
  faults.lstatPath = ''
  await expect(lstat(outputSrt)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['video', 'subtitleSrt', 'planPath'] as const)('refuses a changed %s before publishing a decision', async (field) => {
  const input = await fixture()
  faults.changeAtAllocation = input[field]
  await expect(resolveSubtitleOverlay(input)).rejects.toThrow(field === 'video' ? '源视频变化' : '字幕或计划变化')
})

it.each(['concurrent-report', 'changed-output', 'linked-output', 'rollback-error'])(
  'preserves concurrent artifacts when publishing the report fails: %s', async (mode) => {
    const input = await fixture(), outputSrt = join(input.project, 'out.srt')
    Object.assign(faults, { report: outputSrt + '.decision-report.json', output: outputSrt,
      mode, linkTarget: join(input.project, 'video') })
    const result = resolveSubtitleOverlay({ ...input, outputSrt })
    if (mode === 'rollback-error') await expect(result).rejects.toBeInstanceOf(AggregateError)
    else await expect(result).rejects.toMatchObject({ code: 'EACCES' })
    faults.rollback = false
    if (mode === 'concurrent-report') {
      expect(await readFile(faults.report, 'utf8')).toBe('concurrent report')
      await expect(lstat(outputSrt)).rejects.toMatchObject({ code: 'ENOENT' })
    } else if (mode === 'changed-output') expect(await readFile(outputSrt, 'utf8')).toBe('concurrent subtitle')
    else if (mode === 'linked-output') expect((await lstat(outputSrt)).isSymbolicLink()).toBe(true)
    else expect(await readFile(outputSrt, 'utf8')).toBe('\n')
    expect(await readFile(input.video, 'utf8')).toBe('source video')
  },
)
