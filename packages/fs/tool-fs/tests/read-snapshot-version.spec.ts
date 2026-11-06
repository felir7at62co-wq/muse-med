/** The read snapshot fixture preserves real I/O and changes its version with seed contents. */

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import z from '@deepseek-ai/schemastery'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as ReadSnapshotVersion from './fixtures/read-snapshot-version.mjs'

let cwd: string
let ctx: Context
let fibers: Awaited<ReturnType<Context['plugin']>>[]

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-read-snapshot-version-'))
  ctx = new Context()
  fibers = [await ctx.plugin(LocalFileSystem, { cwd })]
  await writeFile(join(cwd, 'greeting.txt'), 'hello\n')
})

afterEach(async () => {
  for (const fiber of fibers.toReversed()) await fiber.dispose()
  await rm(cwd, { recursive: true, force: true })
})

it('keeps identical bytes stable across file metadata changes and changes the token for different bytes', async () => {
  fibers.push(await ctx.plugin(ReadSnapshotVersion, { files: ['greeting.txt'] }))
  const target = await ctx.fs.resolve('greeting.txt')
  const first = await ctx.fs.stat(target)
  expect(first?.version).toMatch(/^fixture-sha256:[a-f0-9]{64}$/u)
  const timestamp = new Date('2000-01-01T00:00:00.000Z')
  await utimes(join(cwd, 'greeting.txt'), timestamp, timestamp)
  expect((await ctx.fs.stat(target))?.version).toBe(first?.version)
  await writeFile(join(cwd, 'greeting.txt'), 'other\n')
  await utimes(join(cwd, 'greeting.txt'), timestamp, timestamp)
  expect((await ctx.fs.stat(target))?.version).not.toBe(first?.version)
  expect(await ctx.fs.readText(target)).toBe('other\n')
})

it('delegates unowned files, directories, missing paths, and restores the original stat on disposal', async () => {
  await writeFile(join(cwd, 'other.txt'), 'hello\n')
  await mkdir(join(cwd, 'directory'))
  await writeFile(join(cwd, 'directory', 'greeting.txt'), 'hello\n')
  const paths = ['other.txt', 'directory/greeting.txt', 'directory', 'missing.txt']
  const targets = await Promise.all(paths.map(path => ctx.fs.resolve(path)))
  const before = await Promise.all(targets.map(target => ctx.fs.stat(target)))
  const seed = await ctx.fs.resolve('greeting.txt')
  const original = await ctx.fs.stat(seed)
  const fiber = await ctx.plugin(ReadSnapshotVersion, { files: ['greeting.txt', 'directory'] })
  fibers.push(fiber)
  expect(await Promise.all(targets.map(target => ctx.fs.stat(target)))).toEqual(before)
  await ctx.fs.writeText(targets[0]!, 'unowned update\n')
  expect(await ctx.fs.readText(targets[0]!)).toBe('unowned update\n')
  await fiber.dispose()
  expect(await ctx.fs.stat(seed)).toEqual(original)
})

it('rejects a seed that grows beyond the fixture byte bound', async () => {
  fibers.push(await ctx.plugin(ReadSnapshotVersion, { files: ['greeting.txt'] }))
  const target = await ctx.fs.resolve('greeting.txt')
  await writeFile(join(cwd, 'greeting.txt'), 'a'.repeat(1025))
  await expect(ctx.fs.stat(target)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
})

it('hashes generated files within an explicit larger budget and rejects excess bytes', async () => {
  fibers.push(await ctx.plugin(ReadSnapshotVersion, { files: ['director.txt'], maxBytes: 2048 }))
  const target = await ctx.fs.resolve('director.txt')
  await writeFile(join(cwd, 'director.txt'), 'a'.repeat(1500))
  const first = await ctx.fs.stat(target)
  expect(first?.version).toMatch(/^fixture-sha256:[a-f0-9]{64}$/u)
  await writeFile(join(cwd, 'director.txt'), 'b'.repeat(1500))
  expect((await ctx.fs.stat(target))?.version).not.toBe(first?.version)
  await writeFile(join(cwd, 'director.txt'), 'b'.repeat(2049))
  await expect(ctx.fs.stat(target)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
})

it('rejects an invalid configured byte budget before installing a stat effect', async () => {
  await expect(ReadSnapshotVersion.apply(ctx, { files: ['greeting.txt'], maxBytes: 0 }))
    .rejects.toThrow('maxBytes must be a positive safe integer')
})

it('translates observed content versions for guarded mutations while retaining native stale checks', async () => {
  fibers.push(await ctx.plugin(ReadSnapshotVersion, { files: ['greeting.txt'] }))
  const target = await ctx.fs.resolve('greeting.txt')
  const first = await ctx.fs.stat(target)
  if (first?.type !== 'file') throw new Error('Missing fixture file')
  await expect(ctx.fs.writeText(target, 'invalid\n', { kind: 'replaceIfVersion',
    version: FsVersion(`fixture-sha256:${'0'.repeat(64)}`) })).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  const written = await ctx.fs.writeText(target, 'first\n', { kind: 'replaceIfVersion', version: first.version })
  await ctx.fs.writeText(target, 'second\n', { kind: 'replaceIfVersion', version: written.version })
  const second = await ctx.fs.stat(target)
  if (second?.type !== 'file') throw new Error('Missing changed fixture file')
  await writeFile(join(cwd, 'greeting.txt'), 'external\n')
  await expect(ctx.fs.writeText(target, 'lost\n', { kind: 'replaceIfVersion', version: second.version }))
    .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  await expect(ctx.fs.editText(target, { oldString: 'external', newString: 'lost', replaceAll: false }, { version: second.version }))
    .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  const current = await ctx.fs.stat(target)
  if (current?.type !== 'file') throw new Error('Missing external fixture file')
  await ctx.fs.editText(target, { oldString: 'external', newString: 'edited', replaceAll: false }, { version: current.version })
  expect(await ctx.fs.readText(target)).toBe('edited\n')
})

it('keeps report path versions portable across fresh runs without changing file contents or business text', async () => {
  const config = { files: ['report.json'], maxBytes: 4096, reportFiles: ['report.json'] }
  const firstRun = await ctx.plugin(ReadSnapshotVersion, config)
  fibers.push(firstRun)
  const target = await ctx.fs.resolve('report.json')
  const report = { script: join(cwd, 'director.txt'), assets_manifest: join(cwd, 'assets.json'),
    written: [join(cwd, 'review.json')], note: `keep ${cwd}` }
  await writeFile(join(cwd, 'report.json'), JSON.stringify(report))
  const first = await ctx.fs.stat(target)
  await firstRun.dispose()
  const portableReport = { ...report, script: '{{cwd}}/director.txt', assets_manifest: '{{cwd}}/assets.json', written: ['{{cwd}}/review.json'] }
  const portable = JSON.stringify(portableReport)
  await writeFile(join(cwd, 'report.json'), portable)
  const secondRun = await ctx.plugin(ReadSnapshotVersion, config)
  fibers.push(secondRun)
  expect((await ctx.fs.stat(target))?.version).toBe(first?.version)
  expect(await ctx.fs.readText(target)).toBe(portable)
  await writeFile(join(cwd, 'report.json'), JSON.stringify({ ...portableReport, note: 'keep {{cwd}}' }))
  expect((await ctx.fs.stat(target))?.version).not.toBe(first?.version)
})

it('hashes all bytes in non-report files and preserves undeclared and external report values', async () => {
  fibers.push(await ctx.plugin(ReadSnapshotVersion, { files: ['report.json', 'greeting.txt'], maxBytes: 4096, reportFiles: ['report.json'] }))
  const greeting = await ctx.fs.resolve('greeting.txt')
  await writeFile(join(cwd, 'greeting.txt'), `path: ${cwd}`)
  const original = await ctx.fs.stat(greeting)
  await writeFile(join(cwd, 'greeting.txt'), 'path: {{cwd}}')
  expect((await ctx.fs.stat(greeting))?.version).not.toBe(original?.version)
  const target = await ctx.fs.resolve('report.json')
  const report = { script: `${cwd}-other/director.txt`, assets_manifest: join(cwd, 'assets.json'), written: [],
    business: { path: join(cwd, 'plot.txt') } }
  await writeFile(join(cwd, 'report.json'), JSON.stringify(report))
  const first = await ctx.fs.stat(target)
  await writeFile(join(cwd, 'report.json'), JSON.stringify({ ...report, script: '{{cwd}}-other/director.txt' }))
  expect((await ctx.fs.stat(target))?.version).not.toBe(first?.version)
  await writeFile(join(cwd, 'report.json'), JSON.stringify({ ...report, business: { path: '{{cwd}}/plot.txt' } }))
  expect((await ctx.fs.stat(target))?.version).not.toBe(first?.version)
})

it('rejects undeclared report paths and malformed report path fields', async () => {
  await expect(ReadSnapshotVersion.apply(ctx, { files: ['greeting.txt'], maxBytes: 4096, reportFiles: ['report.json'] }))
    .rejects.toThrow('reportFiles must also be listed in files')
  fibers.push(await ctx.plugin(ReadSnapshotVersion, { files: ['report.json'], maxBytes: 4096, reportFiles: ['report.json'] }))
  await writeFile(join(cwd, 'report.json'), JSON.stringify({ script: 'director.txt', assets_manifest: 'assets.json', written: [1] }))
  await expect(ctx.fs.stat(await ctx.fs.resolve('report.json'))).rejects.toThrow()
})

it('refuses upgrading an old observation when another reader observes different raw report bytes with the same portable version', async () => {
  fibers.push(await ctx.plugin(ReadSnapshotVersion, { files: ['report.json'], maxBytes: 4096, reportFiles: ['report.json'] }))
  const target = await ctx.fs.resolve('report.json')
  const report = { script: join(cwd, 'director.txt'), assets_manifest: join(cwd, 'assets.json'), written: [] }
  await writeFile(join(cwd, 'report.json'), JSON.stringify(report))
  const first = await ctx.fs.stat(target)
  if (first?.type !== 'file') throw new Error('Missing report')
  const observed = Promise.withResolvers<undefined>()
  const changed = (async () => {
    await observed.promise
    await writeFile(join(cwd, 'report.json'), JSON.stringify({ ...report, script: '{{cwd}}/director.txt' }))
    return ctx.fs.stat(target)
  })()
  observed.resolve(undefined)
  const competitor = await Promise.allSettled([changed])
  await expect(ctx.fs.writeText(target, 'must not overwrite', { kind: 'replaceIfVersion', version: first.version }))
    .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  expect(competitor).toMatchObject([{ status: 'rejected', reason: { code: 'FS_STALE_VERSION' } }])
  expect(await ctx.fs.readText(target)).toContain('{{cwd}}')
  await expect(ctx.fs.editText(target, { oldString: 'director', newString: 'lost', replaceAll: false }, { version: first.version }))
    .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  await writeFile(join(cwd, 'report.json'), JSON.stringify(report))
  await expect(ctx.fs.stat(target)).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
})

it('rejects a real read when normalized-equivalent report bytes change between its initial stat and text read', async () => {
  fibers.push(await ctx.plugin(SystemPrompt), await ctx.plugin(ToolRuntime), await ctx.plugin(ToolFs))
  fibers.push(await ctx.plugin(ReadSnapshotVersion, { files: ['report.json'], maxBytes: 4096, reportFiles: ['report.json'] }))
  const target = await ctx.fs.resolve('report.json')
  const report = { script: join(cwd, 'director.txt'), assets_manifest: join(cwd, 'assets.json'), written: [] }
  await writeFile(join(cwd, 'report.json'), JSON.stringify(report))
  const reading = Promise.withResolvers<undefined>()
  const resume = Promise.withResolvers<undefined>()
  const originalRead = ctx.fs.readText.bind(ctx.fs)
  const paused = vi.spyOn(ctx.fs, 'readText').mockImplementation(async (subject, signal) => {
    reading.resolve(undefined)
    await resume.promise
    return originalRead(subject, signal)
  })
  const pending = ctx.tools.execute({ name: 'read', arguments: { file_path: 'report.json' },
    callId: ToolCallId('read-report-race'), signal: new AbortController().signal })
  try {
    await reading.promise
    await writeFile(join(cwd, 'report.json'), JSON.stringify({ ...report, script: '{{cwd}}/director.txt' }))
    const competitor = await Promise.allSettled([ctx.fs.stat(target)])
    resume.resolve(undefined)
    expect(await pending).toMatchObject({ isError: true, error: { info: { code: 'FS_STALE_VERSION' } } })
    expect(competitor).toMatchObject([{ status: 'rejected', reason: { code: 'FS_STALE_VERSION' } }])
  } finally {
    resume.resolve(undefined)
    await pending
    paused.mockRestore()
  }
})

it('rejects a real continuation after another reader observes normalized-equivalent raw changes', async () => {
  fibers.push(await ctx.plugin(SystemPrompt), await ctx.plugin(ToolRuntime), await ctx.plugin(ToolFs))
  fibers.push(await ctx.plugin(ReadSnapshotVersion, { files: ['report.json'], maxBytes: 4096, reportFiles: ['report.json'] }))
  const report = { script: join(cwd, 'director.txt'), assets_manifest: join(cwd, 'assets.json'), written: [] }
  await writeFile(join(cwd, 'report.json'), JSON.stringify(report, null, 2))
  const first = await ctx.tools.execute({ name: 'read', arguments: { file_path: 'report.json', limit: 1 },
    callId: ToolCallId('read-report-first-page'), signal: new AbortController().signal })
  expect(first.isError).toBe(false)
  if (typeof first.value !== 'object' || first.value === null || Array.isArray(first.value)) throw new Error('Missing read page')
  const page = z.object({ version: z.string().required(),
    continuation: z.object({ offset: z.number().required(), column: z.number().required() }).required() })(first.value)
  const proceed = Promise.withResolvers<undefined>()
  const changed = (async () => {
    await proceed.promise
    await writeFile(join(cwd, 'report.json'), JSON.stringify({ ...report, script: '{{cwd}}/director.txt' }, null, 2))
    return ctx.fs.stat(await ctx.fs.resolve('report.json'))
  })()
  proceed.resolve(undefined)
  expect(await Promise.allSettled([changed])).toMatchObject([{ status: 'rejected', reason: { code: 'FS_STALE_VERSION' } }])
  const continued = await ctx.tools.execute({ name: 'read',
    arguments: { file_path: 'report.json', ...page.continuation, expected_version: page.version },
    callId: ToolCallId('read-report-continuation'), signal: new AbortController().signal })
  expect(continued).toMatchObject({ isError: true, error: { info: { code: 'FS_STALE_VERSION' } } })
})

it('rejects a native file change while computing its content version', async () => {
  fibers.push(await ctx.plugin(ReadSnapshotVersion, { files: ['greeting.txt'] }))
  const captured = Promise.withResolvers<undefined>(), resume = Promise.withResolvers<undefined>()
  const originalRead = ctx.fs.readBytes.bind(ctx.fs)
  const paused = vi.spyOn(ctx.fs, 'readBytes').mockImplementation(async (...args) => {
    const bytes = await originalRead(...args)
    captured.resolve(undefined)
    await resume.promise
    return bytes
  })
  const pending = ctx.fs.stat(await ctx.fs.resolve('greeting.txt'))
  try {
    await captured.promise
    await writeFile(join(cwd, 'greeting.txt'), 'changed during version read\n')
    const rejected = expect(pending).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    resume.resolve(undefined)
    await rejected
  } finally {
    resume.resolve(undefined)
    await Promise.allSettled([pending])
    paused.mockRestore()
  }
})
