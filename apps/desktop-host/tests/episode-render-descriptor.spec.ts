/** Exact descriptor files validate capture facts and private paths without executing the media worker. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Sha256 } from '@deepseek-ai/dsh-tool-jubian/episode-delivery'
import { expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { Config as ProviderConfig } from '../src/approved-episode-render.ts'
import { Config as WorkerConfig } from '../src/episode-render-worker.ts'
import { episodeConfigurationSchema, episodeDescriptorSchema, episodeFactsHash, insideEpisodeRoot,
  parseEpisodeRendererConfig, readEpisodeDescriptor, readEpisodeDescriptorV2 } from '../src/episode-render-descriptor.ts'

const hash = (bytes: Buffer | string): Sha256 => brandString<Sha256>(createHash('sha256').update(bytes).digest('hex'))
const object = (value: unknown): Record<string, unknown> => z.record(z.string(), z.unknown()).parse(value)

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-episode-descriptor-')))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project'), execution = randomUUID(), attempt = randomUUID()
  const attemptRoot = join(project, '.muse', 'episode-delivery', attempt), stageRoot = join(attemptRoot, execution, 'stage')
  await mkdir(stageRoot, { recursive: true })
  const file = async (path: string, bytes: string) => {
    await writeFile(path, bytes)
    return { path, bytes: Buffer.byteLength(bytes), sha256: hash(bytes) }
  }
  const projectFile = await file(join(project, 'project_config.json'), '{}\n')
  const code = await file(join(root, 'renderer.js'), 'export {}\n')
  const stagedProject = await file(join(stageRoot, 'project_config.json'), '{}\n')
  const source = await file(join(stageRoot, 'source.mp4'), 'descriptor fixture; not decoded media')
  const timeline = await file(join(stageRoot, 'timeline.json'), '{}\n')
  const subtitle = await file(join(stageRoot, 'subtitle.srt'), '1\n00:00:00,000 --> 00:00:01,000\nFixture\n')
  const mix = await file(join(stageRoot, 'mix.json'), '{"schema_version":1,"mode":"no_bgm"}\n')
  await mkdir(join(root, 'fonts')); await mkdir(join(stageRoot, 'fonts'))
  const font = await file(join(root, 'fonts', 'capture.ttf'), 'font fixture bytes')
  const privateFont = await file(join(stageRoot, 'fonts', 'capture.ttf'), 'font fixture bytes')
  const config = parseEpisodeRendererConfig({ fontsDir: join(root, 'fonts') })
  const configuration = episodeConfigurationSchema.parse({ projectDir: project, episode: 1, digest: hash('plan'), config,
    runtimeInputs: [{ ...code, owner: 'renderer' }, { ...font, owner: 'font' }], projectInputs: [projectFile] })
  const configurationSha256 = episodeFactsHash(configuration)
  const descriptor = episodeDescriptorSchema.parse({ version: 1, kind: 'approved-episode-render',
    identity: { attempt, rendererGeneration: randomUUID(), projectSha256: projectFile.sha256,
      planSha256: hash('logical selection'), configurationSha256 }, execution,
    renderer: { generation: randomUUID(), configurationSha256,
      codeSha256: episodeFactsHash(configuration.runtimeInputs.filter(entry => entry.owner === 'renderer')) },
    originalProject: project, attemptRoot, stageRoot, configuration,
    config: parseEpisodeRendererConfig({ fontsDir: join(stageRoot, 'fonts') }),
    stagedFiles: [stagedProject, source, timeline, subtitle, mix, privateFont],
    projectFiles: [{ ...stagedProject, originalPath: projectFile.path, role: 'project' }],
    stagedSources: [{ ...source, shot: 1, idempotencyKey: 'original-reference', digest: hash('review') }],
    timelinePath: timeline.path, subtitlePath: subtitle.path, mixProfilePath: mix.path,
    candidatePath: join(stageRoot, 'candidate.mp4'), candidateFactsPath: join(stageRoot, 'candidate-facts.json'),
    lastShot: 1, retry: 'initial' })
  const path = join(stageRoot, 'descriptor.json')
  const write = async (value: object | string) => {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value) + '\n')
    await writeFile(path, bytes)
    return { bytes, sha256: hash(bytes) }
  }
  const saved = await write(descriptor)
  return { root, project, path, descriptor, saved, write }
}

it('accepts exact bytes at their budget with distinct original and current renderer generations', async () => {
  const f = await fixture(), parsed = await readEpisodeDescriptor(f.path, f.saved.sha256, f.saved.bytes.length)
  expect(parsed).toEqual(f.descriptor)
  expect(parsed.identity.rendererGeneration).not.toBe(parsed.renderer.generation)
  expect(parsed.renderer.configurationSha256).toBe(episodeFactsHash(parsed.configuration))
  expect(parsed.projectFiles).toHaveLength(1)
  expect(parsed.stagedSources).toHaveLength(1)
  expect(await readFile(f.path)).toEqual(f.saved.bytes)
})

async function sourceClaimFixture() {
  const f = await fixture(), files = f.descriptor.stagedFiles
  const original = (index: number, roles: string[]) => {
    const file = files[index]
    if (file === undefined) throw new Error('missing fixture file')
    return { originalPath: index === 4 ? join(f.project, 'reviews', 'ep01-p01.json') : join(f.project, `source-${index}`),
      stagedPath: file.path, sha256: file.sha256, bytes: file.bytes, roles }
  }
  const filesForClaim = [
    original(0, ['ocr', 'inspection']), original(1, ['selected-video', 'source-audio']),
    original(2, ['source-manifest']), original(3, ['master-audio']), original(4, ['review-record', 'package-record']),
  ]
  const claim = { identity: f.descriptor.identity, execution: f.descriptor.execution, sessionId: 'original-session',
    workspaceRoot: f.project, subtitleClock: 'absent', files: filesForClaim,
    directories: [{ originalPath: join(f.project, 'reviews'), entries: ['ep01-p01.json'] }],
    bindings: [{ mediaOriginalPath: filesForClaim[1]!.originalPath, ocrOriginalPath: filesForClaim[0]!.originalPath,
      inspectionOriginalPath: filesForClaim[0]!.originalPath, reviewId: 'review' }] }
  const descriptor = { ...f.descriptor, version: 2, sourceClaim: claim }
  return { ...f, claim, descriptor }
}

it('decodes matching v2 claims but leaves the production v1 reader closed to v2', async () => {
  const f = await sourceClaimFixture(), saved = await f.write(f.descriptor)
  const result = await readEpisodeDescriptorV2(f.path, saved.sha256, saved.bytes.length)
  expect(result.sourceClaim.sessionId).toBe('original-session')
  await expect(readEpisodeDescriptor(f.path, saved.sha256, saved.bytes.length)).rejects.toThrow()
  await expect(readEpisodeDescriptorV2(f.path, f.saved.sha256, saved.bytes.length)).rejects.toThrow('descriptor bytes changed')
})

it('treats a syntactically valid Session claim as data rather than authenticating it', async () => {
  const f = await sourceClaimFixture(), saved = await f.write({ ...f.descriptor,
    sourceClaim: { ...f.claim, sessionId: 'untrusted-session' } })
  expect((await readEpisodeDescriptorV2(f.path, saved.sha256, saved.bytes.length)).sourceClaim.sessionId).toBe('untrusted-session')
  await expect(readEpisodeDescriptor(f.path, saved.sha256, saved.bytes.length)).rejects.toThrow()
})

it('rejects missing, misbound and ambiguous v2 source claims', async () => {
  const f = await sourceClaimFixture(), first = f.claim.files[0]!
  const examples = [
    { ...f.descriptor, sourceClaim: undefined },
    { ...f.descriptor, sourceClaim: { ...f.claim, sessionId: '' } },
    { ...f.descriptor, sourceClaim: { ...f.claim, execution: randomUUID() } },
    { ...f.descriptor, sourceClaim: { ...f.claim, identity: { ...f.claim.identity, projectSha256: hash('other project') } } },
    { ...f.descriptor, sourceClaim: { ...f.claim, files: [first, { ...first }, ...f.claim.files.slice(1)] } },
    { ...f.descriptor, sourceClaim: { ...f.claim, files: [{ ...first, stagedPath: join(f.root, 'outside') }, ...f.claim.files.slice(1)] } },
    { ...f.descriptor, sourceClaim: { ...f.claim, files: [{ ...first, sha256: hash('changed') }, ...f.claim.files.slice(1)] } },
    { ...f.descriptor, sourceClaim: { ...f.claim, files: f.claim.files.slice(0, 4) } },
    { ...f.descriptor, sourceClaim: { ...f.claim, subtitleClock: 'present' } },
    { ...f.descriptor, sourceClaim: { ...f.claim, files: [{ ...first, roles: ['ocr', 'ocr'] }, ...f.claim.files.slice(1)] } },
    { ...f.descriptor, sourceClaim: { ...f.claim, extra: true } },
  ]
  for (const example of examples) {
    const saved = await f.write(example)
    await expect(readEpisodeDescriptorV2(f.path, saved.sha256, saved.bytes.length)).rejects.toThrow()
  }
})

it('checks raw bytes before attempting to decode malformed JSON', async () => {
  const f = await fixture(), changed = await f.write('{"version":')
  await expect(readEpisodeDescriptor(f.path, f.saved.sha256, changed.bytes.length)).rejects.toThrow('descriptor bytes changed')
  await expect(readEpisodeDescriptor(f.path, changed.sha256, changed.bytes.length)).rejects.toThrow(SyntaxError)
  expect(await readFile(f.path)).toEqual(changed.bytes)
})

it('binds whitespace changes to the exact physical descriptor SHA', async () => {
  const f = await fixture(), changed = await f.write(JSON.stringify(f.descriptor, null, 2))
  expect(changed.sha256).not.toBe(f.saved.sha256)
  await expect(readEpisodeDescriptor(f.path, f.saved.sha256, changed.bytes.length)).rejects.toThrow('descriptor bytes changed')
  expect(await readEpisodeDescriptor(f.path, changed.sha256, changed.bytes.length)).toEqual(f.descriptor)
})

it('rejects over-budget, missing, directory and symlink descriptor inputs without changing their targets', async () => {
  const f = await fixture()
  await expect(readEpisodeDescriptor(f.path, f.saved.sha256, f.saved.bytes.length - 1)).rejects.toThrow('bounded regular file')
  await expect(readEpisodeDescriptor(join(f.root, 'absent.json'), f.saved.sha256, f.saved.bytes.length)).rejects.toThrow('descriptor bytes changed')
  await expect(readEpisodeDescriptor(f.root, f.saved.sha256, f.saved.bytes.length)).rejects.toThrow('bounded regular file')
  const alias = join(f.root, 'alias.json')
  await symlink(f.path, alias)
  await expect(readEpisodeDescriptor(alias, f.saved.sha256, f.saved.bytes.length)).rejects.toThrow('bounded regular file')
  expect(await readFile(f.path)).toEqual(f.saved.bytes)
})

const schemaFaults: { name: string; change: (record: Record<string, unknown>) => object }[] = [
  { name: 'unknown root field', change: record => ({ ...record, extra: true }) },
  { name: 'unsupported version', change: record => ({ ...record, version: 2 }) },
  { name: 'different kind', change: record => ({ ...record, kind: 'other-worker' }) },
  { name: 'missing project files', change: record => ({ ...record, projectFiles: undefined }) },
  { name: 'empty staged sources', change: record => ({ ...record, stagedSources: [] }) },
  { name: 'relative candidate', change: record => ({ ...record, candidatePath: 'candidate.mp4' }) },
  { name: 'invalid execution UUID', change: record => ({ ...record, execution: 'execution' }) },
  { name: 'zero last shot', change: record => ({ ...record, lastShot: 0 }) },
  { name: 'unknown configuration field', change: record => ({ ...record, configuration: { ...object(record.configuration), extra: true } }) },
  { name: 'empty runtime capture', change: record => ({ ...record, configuration: { ...object(record.configuration), runtimeInputs: [] } }) },
]
it.each(schemaFaults)('rejects $name from actual descriptor JSON', async ({ change }) => {
  const f = await fixture(), saved = await f.write(change(object(f.descriptor)))
  await expect(readEpisodeDescriptor(f.path, saved.sha256, saved.bytes.length)).rejects.toThrow()
  expect(await readFile(f.path)).toEqual(saved.bytes)
})

const captureFaults: { name: string; change: (record: Record<string, unknown>) => object }[] = [
  { name: 'renderer configuration differs from the original attempt', change: record => ({ ...record,
    renderer: { ...object(record.renderer), configurationSha256: hash('different config') } }) },
  { name: 'configuration facts no longer match their hash', change: record => ({ ...record,
    configuration: { ...object(record.configuration), digest: hash('different plan') } }) },
  { name: 'code facts no longer match their hash', change: record => ({ ...record,
    renderer: { ...object(record.renderer), codeSha256: hash('different code') } }) },
  { name: 'original project differs from capture', change: record => ({ ...record,
    originalProject: join(String(record.originalProject), 'another-project') }) },
]
it.each(captureFaults)('rejects $name', async ({ change }) => {
  const f = await fixture(), saved = await f.write(change(object(f.descriptor)))
  await expect(readEpisodeDescriptor(f.path, saved.sha256, saved.bytes.length)).rejects.toThrow('capture identity mismatch')
  expect(await readFile(f.path)).toEqual(saved.bytes)
})

it.each(['stageRoot', 'candidatePath', 'candidateFactsPath', 'timelinePath', 'subtitlePath', 'mixProfilePath',
  'bgmPath', 'endingAudio', 'endingEffect'] as const)('rejects an execution escape through %s', async (field) => {
  const f = await fixture(), saved = await f.write({ ...f.descriptor, [field]: join(f.root, 'outside') })
  await expect(readEpisodeDescriptor(f.path, saved.sha256, saved.bytes.length)).rejects.toThrow('escaped its private execution')
  expect(await readFile(f.path)).toEqual(saved.bytes)
})

it('rejects a staged input outside the private stage even when its JSON facts are valid', async () => {
  const f = await fixture(), saved = await f.write({ ...f.descriptor,
    stagedFiles: [{ path: join(f.root, 'outside.mp4'), bytes: 1, sha256: hash('x') }] })
  await expect(readEpisodeDescriptor(f.path, saved.sha256, saved.bytes.length)).rejects.toThrow('escaped its private execution')
  expect(await readFile(f.path)).toEqual(saved.bytes)
})

it('uses canonical fact hashing while retaining meaningful array order', () => {
  expect(episodeFactsHash({ path: '/project/file', bytes: 1 })).toBe(episodeFactsHash({ bytes: 1, path: '/project/file' }))
  expect(episodeFactsHash([{ path: '/a' }, { path: '/b' }])).not.toBe(episodeFactsHash([{ path: '/b' }, { path: '/a' }]))
})

it('recognizes proper children but excludes the root, ancestors and sibling prefixes', async () => {
  const f = await fixture(), root = f.descriptor.stageRoot
  expect(insideEpisodeRoot(root, join(root, 'nested', 'file'))).toBe(true)
  for (const selected of [root, join(root, '..'), root + '-sibling/file', join(root, '..', 'outside')]) {
    expect(insideEpisodeRoot(root, selected)).toBe(false)
  }
})

it('validates and resolves actual renderer Config without invoking its implementation', () => {
  expect(parseEpisodeRendererConfig({})).toMatchObject({ masterVolume: 1.45, bgmVolume: 0.24, maxBgmVolume: 8, preferNvenc: true })
  for (const value of [{ masterVolume: 9 }, { bgmVolume: -1 }, { maxBgmVolume: 9 },
    { subtitleFontFamily: 'bad,font' }, { watermarkFontFamily: 'line\nbreak' }]) {
    expect(() => parseEpisodeRendererConfig(value)).toThrow('configuration is invalid')
  }
})

it('uses the same positive bounded media grace in actual provider and worker Config parsers', async () => {
  const f = await fixture(), provider = { runtimeDir: f.root, endingAssetRoot: f.root }
  const worker = { descriptorPath: f.path, descriptorSha256: f.saved.sha256, requestBytes: 1, replyBytes: 1,
    descriptorBytes: f.saved.bytes.length, journalBytes: 1, lockWaitMs: 1, runtimeEntries: 1,
    mediaStdoutBytes: 1, mediaStderrBytes: 1, diagnosticBytes: 1 }
  for (const mediaGraceMs of [1, 2147483647]) {
    expect(ProviderConfig.parse({ ...provider, mediaGraceMs }).mediaGraceMs).toBe(mediaGraceMs)
    expect(WorkerConfig.parse({ ...worker, mediaGraceMs }).mediaGraceMs).toBe(mediaGraceMs)
  }
  for (const mediaGraceMs of [0, -1, 0.5, 2147483648]) {
    expect(() => ProviderConfig.parse({ ...provider, mediaGraceMs })).toThrow()
    expect(() => WorkerConfig.parse({ ...worker, mediaGraceMs })).toThrow()
  }
})

it('rejects changed execution settings while allowing only the private font directory replacement', async () => {
  const f = await fixture()
  const config = structuredClone(f.descriptor.config); config.masterVolume = 0.5
  const saved = await f.write({ ...f.descriptor, config })
  await expect(readEpisodeDescriptor(f.path, saved.sha256, saved.bytes.length)).rejects.toThrow('changed captured renderer settings')
})

it.each(['sha256', 'bytes', 'path'] as const)('rejects a private font %s inconsistent with its original capture', async (field) => {
  const f = await fixture()
  const files = f.descriptor.stagedFiles.map(file => file.path.endsWith('capture.ttf')
    ? { ...file, [field]: field === 'sha256' ? hash('different font') : field === 'bytes' ? file.bytes + 1 : join(f.descriptor.config.fontsDir ?? '', 'different.ttf') }
    : file)
  const saved = await f.write({ ...f.descriptor, stagedFiles: files })
  await expect(readEpisodeDescriptor(f.path, saved.sha256, saved.bytes.length)).rejects.toThrow('private fonts differ from their original capture')
})
