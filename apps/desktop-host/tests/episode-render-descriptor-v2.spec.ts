/** Data parsing tests isolate the renderer configuration while its merge is unresolved. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Sha256 } from '@deepseek-ai/dsh-tool-jubian/episode-delivery'
import { expect, it, onTestFinished, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-tool-episode-render', () => ({
  Config: { '~standard': { validate: (value: object) => ({ value }) } },
  resolveSettings: (value: { fontsDir: string }) => value,
}))

import { episodeConfigurationSchema, episodeFactsHash, readEpisodeDescriptor,
  readEpisodeDescriptorV2, readEpisodeDescriptorV3, readEpisodeDescriptorV4 } from '../src/episode-render-descriptor.ts'
import { verifyEpisodeSourceClaimFiles } from '../src/episode-render-source-files.ts'

const hash = (value: string): Sha256 => brandString<Sha256>(createHash('sha256').update(value).digest('hex'))

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'episode-v2-')))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project'), attempt = randomUUID(), execution = randomUUID()
  const attemptRoot = join(project, '.muse', 'episode-delivery', attempt), stageRoot = join(attemptRoot, execution, 'stage')
  await mkdir(stageRoot, { recursive: true })
  const originalFonts = join(root, 'fonts'), stagedFonts = join(stageRoot, 'fonts')
  const config = { fontsDir: originalFonts }, stagedConfig = { fontsDir: stagedFonts }
  const runtimeInputs = [{ path: join(root, 'renderer.js'), sha256: hash('code'), bytes: 4, owner: 'renderer' }]
  const projectFile = { path: join(project, 'project_config.json'), sha256: hash('project'), bytes: 7 }
  const configuration = episodeConfigurationSchema.parse({ projectDir: project, episode: 1, digest: hash('plan'),
    config, runtimeInputs, projectInputs: [projectFile] })
  const configurationSha256 = episodeFactsHash(configuration)
  const identity = { attempt, rendererGeneration: randomUUID(), projectSha256: projectFile.sha256,
    planSha256: hash('plan'), configurationSha256 }
  const roles = [['selected-video', 'source-audio'], ['source-manifest'], ['master-audio'],
    ['review-record', 'package-record'], ['ocr', 'inspection']]
  const files = roles.map((entry, index) => ({ originalPath: index === 3 ? join(project, 'reviews', 'ep01-p01.json') : join(project, `original-${index}`),
    stagedPath: join(stageRoot, `staged-${index}`), sha256: hash(String(index)), bytes: 1, roles: entry }))
  const stagedFiles = files.map(file => ({ path: file.stagedPath, sha256: file.sha256, bytes: file.bytes }))
  const source = stagedFiles[0]!
  const legacy = { version: 1, kind: 'approved-episode-render', identity, execution,
    renderer: { generation: randomUUID(), configurationSha256, codeSha256: episodeFactsHash(runtimeInputs) },
    originalProject: project, attemptRoot, stageRoot, configuration, config: stagedConfig, stagedFiles,
    projectFiles: [{ ...stagedFiles[1], originalPath: projectFile.path, role: 'project' }],
    stagedSources: [{ ...source, shot: 1, idempotencyKey: 'source-key', digest: hash('review') }],
    timelinePath: stagedFiles[1]!.path, subtitlePath: stagedFiles[2]!.path, mixProfilePath: stagedFiles[3]!.path,
    candidatePath: join(stageRoot, 'candidate.mp4'), candidateFactsPath: join(stageRoot, 'candidate.json'),
    lastShot: 1, retry: 'initial' }
  const claim = { identity, execution, sessionId: 'session', workspaceRoot: project, subtitleClock: 'absent', files,
    directories: [{ originalPath: join(project, 'reviews'), entries: ['ep01-p01.json'] }],
    bindings: [{ mediaOriginalPath: files[0]!.originalPath, ocrOriginalPath: files[4]!.originalPath,
      inspectionOriginalPath: files[4]!.originalPath, reviewId: 'review' }] }
  const descriptor = { ...legacy, version: 2, sourceClaim: claim }
  const file = join(stageRoot, 'descriptor.json')
  const write = async (value: object) => {
    const text = JSON.stringify(value) + '\n'
    await writeFile(file, text)
    return { hash: hash(text), bytes: Buffer.byteLength(text) }
  }
  return { root, project, file, legacy, claim, descriptor, write }
}

it('keeps v1 readable and refuses to execute v2 through its existing reader', async () => {
  const f = await fixture(), old = await f.write(f.legacy)
  expect((await readEpisodeDescriptor(f.file, old.hash, old.bytes)).version).toBe(1)
  const current = await f.write(f.descriptor)
  expect((await readEpisodeDescriptorV2(f.file, current.hash, current.bytes)).version).toBe(2)
  await expect(readEpisodeDescriptor(f.file, current.hash, current.bytes)).rejects.toThrow()
  await expect(readEpisodeDescriptorV2(f.file, old.hash, current.bytes)).rejects.toThrow('descriptor bytes changed')
})

it('rejects wrong execution, missing inputs and altered or escaping stage mappings', async () => {
  const f = await fixture(), first = f.claim.files[0]!
  const invalid = [
    { ...f.descriptor, sourceClaim: { ...f.claim, execution: randomUUID() } },
    { ...f.descriptor, sourceClaim: { ...f.claim, identity: { ...f.claim.identity, projectSha256: hash('other') } } },
    { ...f.descriptor, attemptRoot: f.root },
    { ...f.descriptor, sourceClaim: { ...f.claim, files: f.claim.files.slice(0, 4) } },
    { ...f.descriptor, sourceClaim: { ...f.claim, files: [{ ...first, sha256: hash('other') }, ...f.claim.files.slice(1)] } },
    { ...f.descriptor, sourceClaim: { ...f.claim, files: [{ ...first, stagedPath: join(f.root, 'outside') }, ...f.claim.files.slice(1)] } },
    { ...f.descriptor, sourceClaim: { ...f.claim, files: [{ ...first, originalPath: first.stagedPath }, ...f.claim.files.slice(1)] } },
    { ...f.descriptor, sourceClaim: { ...f.claim, files: [first, first, ...f.claim.files.slice(1)] } },
    { ...f.descriptor, sourceClaim: { ...f.claim, subtitleClock: 'present' } },
    { ...f.descriptor, sourceClaim: { ...f.claim, sessionId: '' } },
    { ...f.descriptor, sourceClaim: { ...f.claim, bindings: [] } },
    { ...f.descriptor, sourceClaim: { ...f.claim, bindings: [{ ...f.claim.bindings[0], reviewId: '' }] } },
    { ...f.descriptor, sourceClaim: { ...f.claim, bindings: [{ ...f.claim.bindings[0], mediaOriginalPath: join(f.root, 'other') }] } },
    { ...f.descriptor, sourceClaim: { ...f.claim, bindings: [f.claim.bindings[0], f.claim.bindings[0]] } },
    { ...f.descriptor, stagedSources: [...f.descriptor.stagedSources, f.descriptor.stagedSources[0]] },
    { ...f.descriptor, sourceClaim: { ...f.claim, files: [{ ...first, roles: ['selected-video'] }, ...f.claim.files.slice(1)] } },
  ]
  for (const value of invalid) {
    const saved = await f.write(value)
    await expect(readEpisodeDescriptorV2(f.file, saved.hash, saved.bytes)).rejects.toThrow()
  }
})

it('accepts a clock only when its exact staged bytes are included in the claim', async () => {
  const f = await fixture(), clock = { originalPath: join(f.root, 'clock.json'),
    stagedPath: join(f.descriptor.stageRoot, 'clock.json'), sha256: hash('clock'), bytes: 5, roles: ['subtitle-clock'] }
  const descriptor = { ...f.descriptor,
    stagedFiles: [...f.descriptor.stagedFiles, { path: clock.stagedPath, sha256: clock.sha256, bytes: clock.bytes }],
    sourceClaim: { ...f.claim, subtitleClock: 'present', files: [...f.claim.files, clock] } }
  const saved = await f.write(descriptor)
  expect((await readEpisodeDescriptorV2(f.file, saved.hash, saved.bytes)).sourceClaim.subtitleClock).toBe('present')
})

it('does not mistake a well-formed Session string for authenticated ownership', async () => {
  const f = await fixture(), saved = await f.write({ ...f.descriptor, sourceClaim: { ...f.claim, sessionId: 'forged-session' } })
  expect((await readEpisodeDescriptorV2(f.file, saved.hash, saved.bytes)).sourceClaim.sessionId).toBe('forged-session')
  await expect(readEpisodeDescriptor(f.file, saved.hash, saved.bytes)).rejects.toThrow()
})

it('rechecks actual original and staged bytes and directory membership without authenticating the Session', async () => {
  const f = await fixture()
  for (const [index, file] of f.claim.files.entries()) {
    await mkdir(dirname(file.originalPath), { recursive: true })
    await writeFile(file.originalPath, String(index))
    await writeFile(file.stagedPath, String(index))
  }
  const saved = await f.write(f.descriptor)
  const parsed = await readEpisodeDescriptorV2(f.file, saved.hash, saved.bytes)
  const signal = new AbortController().signal
  await expect(verifyEpisodeSourceClaimFiles(parsed, 'original-and-stage', signal)).resolves.toBeUndefined()
  await expect(verifyEpisodeSourceClaimFiles(parsed, 'stage', signal)).resolves.toBeUndefined()
  await writeFile(f.claim.files[0]!.originalPath, 'replaced')
  await expect(verifyEpisodeSourceClaimFiles(parsed, 'original-and-stage', signal)).rejects.toThrow('changed')
  await expect(verifyEpisodeSourceClaimFiles(parsed, 'stage', signal)).resolves.toBeUndefined()
  await writeFile(f.claim.files[0]!.originalPath, '0')
  await writeFile(f.claim.files[0]!.stagedPath, 'replaced')
  await expect(verifyEpisodeSourceClaimFiles(parsed, 'stage', signal)).rejects.toThrow('changed')
  await writeFile(f.claim.files[0]!.stagedPath, '0')
  if (process.platform !== 'win32') {
    await rm(f.claim.files[0]!.stagedPath)
    await symlink(f.claim.files[0]!.originalPath, f.claim.files[0]!.stagedPath)
    await expect(verifyEpisodeSourceClaimFiles(parsed, 'stage', signal)).rejects.toThrow('canonical regular file')
    await rm(f.claim.files[0]!.stagedPath)
    await writeFile(f.claim.files[0]!.stagedPath, '0')
    const alias = join(f.root, 'authorized-alias')
    await symlink(f.claim.files[0]!.originalPath, alias)
    const aliasDescriptor = { ...parsed, sourceClaim: { ...parsed.sourceClaim, files: parsed.sourceClaim.files.map((file, index) =>
      index === 0 ? { ...file, aliases: [alias] } : file) } }
    await expect(verifyEpisodeSourceClaimFiles(aliasDescriptor, 'original-and-stage', signal)).resolves.toBeUndefined()
    await rm(alias)
    await symlink(f.claim.files[1]!.originalPath, alias)
    await expect(verifyEpisodeSourceClaimFiles(aliasDescriptor, 'original-and-stage', signal)).rejects.toThrow('alias changed')
  }
  await writeFile(join(f.project, 'reviews', 'new.json'), 'new')
  await expect(verifyEpisodeSourceClaimFiles(parsed, 'original-and-stage', signal)).rejects.toThrow('directory')
  const stopped = new AbortController(); stopped.abort()
  await expect(verifyEpisodeSourceClaimFiles(parsed, 'stage', stopped.signal)).rejects.toThrow()
})


it('binds strict source evidence, Session and clock in a separate v4 descriptor', async () => {
  const f = await fixture(), subtitle = join(f.project, 'editing', 'subtitle.srt')
  const original = (path: string, bytes: string) => ({ path, sha256: hash(bytes), bytes: bytes.length })
  const clockInputs = { clock: original(`${subtitle}.clock.json`, 'clock'),
    manifest: original(join(f.project, 'editing', '01-sources.json'), 'manifest'),
    master: original(join(f.project, 'audio', '01.wav'), 'master'),
    shots: [{ shot: 1, video: original(join(f.project, 'video', '01', 'shot_001.mp4'), '0'),
      audio: original(join(f.project, 'audio', 'original.wav'), 'audio') }] }
  const clockStage = { clockPath: `${f.legacy.subtitlePath}.clock.json`,
    manifestPath: join(f.legacy.stageRoot, 'editing', '01-sources.json'),
    masterPath: join(f.legacy.stageRoot, 'audio', '01.wav'),
    audio: [{ shot: 1, originalPath: clockInputs.shots[0]!.audio.path,
      stagedPath: join(f.legacy.stageRoot, '__clock', 'audio-1.wav') }] }
  const clockFacts = [[clockInputs.clock, clockStage.clockPath, 'subtitle-clock'],
    [clockInputs.manifest, clockStage.manifestPath, 'source-manifest'],
    [clockInputs.master, clockStage.masterPath, 'master-audio'],
    [clockInputs.shots[0]!.audio, clockStage.audio[0]!.stagedPath, 'source-audio']] as const
  const stagedFiles = [...f.legacy.stagedFiles, ...clockFacts.map(([fact, path]) => ({ ...fact, path }))]
  const qaFiles = [f.claim.files[0]!, f.claim.files[3]!, f.claim.files[4]!, ...clockFacts.map(([fact, stagedPath, role]) => ({
    originalPath: fact.path, stagedPath, sha256: fact.sha256, bytes: fact.bytes, roles: [role],
  }))]
  const sessionId = 'session', workspaceId = 'workspace'
  const sessions = [{ version: 1, authorityId: randomUUID(), workspaceId, workspaceCreatedAt: '2026-01-01',
    workspacePath: f.project, membershipEpoch: randomUUID(), sessionId, workingDirectory: f.project,
    model: { provider: 'fixture', model: 'fixture' } }]
  const bindings = [{ sessionId, reviewId: 'review', mediaPath: qaFiles[0]!.originalPath, mediaSha256: qaFiles[0]!.sha256,
    ocrPath: qaFiles[2]!.originalPath, ocrSha256: qaFiles[2]!.sha256,
    inspectionPath: qaFiles[2]!.originalPath, inspectionSha256: qaFiles[2]!.sha256 }]
  const sourceEvidence = { sessions, sourceQaSha256: hash('qa'), selectedPaths: [qaFiles[0]!.originalPath],
    files: qaFiles.map(file => ({ path: file.originalPath, sha256: file.sha256, bytes: file.bytes })),
    directories: f.claim.directories, bindings }
  const configurationSha256 = episodeFactsHash({ configuration: f.legacy.configuration, clockInputs, sourceEvidence })
  const identity = { ...f.legacy.identity, configurationSha256 }
  const sourceClaim = { ...f.claim, identity, workspaceId, subtitleClock: 'present', files: qaFiles }
  const value = { ...f.legacy, version: 4, clockInputs, clockStage, stagedFiles, sourceEvidence, sourceClaim,
    identity, renderer: { ...f.legacy.renderer, configurationSha256 },
    projectFiles: [...f.legacy.projectFiles, { ...f.legacy.stagedFiles[2]!, originalPath: subtitle, role: 'subtitle' }] }
  const good = await f.write(value)
  expect((await readEpisodeDescriptorV4(f.file, good.hash, good.bytes)).version).toBe(4)
  await expect(readEpisodeDescriptorV3(f.file, good.hash, good.bytes)).rejects.toThrow()
  const invalid = [
    { ...value, sourceEvidence: { ...sourceEvidence, sessions: [{ ...sessions[0], sessionId: 'other' }] } },
    { ...value, sourceEvidence: { ...sourceEvidence, bindings: [{ ...bindings[0], ocrSha256: hash('fake') }] } },
    { ...value, sourceEvidence: { ...sourceEvidence, selectedPaths: [qaFiles[1]!.originalPath] } },
    { ...value, sourceEvidence: { ...sourceEvidence,
      files: [sourceEvidence.files[0], sourceEvidence.files[0], ...sourceEvidence.files.slice(2)] } },
    { ...value, sourceClaim: { ...sourceClaim, files: qaFiles.filter(file => !file.roles.includes('source-audio')) } },
    { ...value, sourceClaim: { ...sourceClaim, subtitleClock: 'absent' } },
  ]
  for (const candidate of invalid) {
    const changedSha = episodeFactsHash({ configuration: candidate.configuration, clockInputs: candidate.clockInputs,
      sourceEvidence: candidate.sourceEvidence })
    const changedIdentity = { ...candidate.identity, configurationSha256: changedSha }
    const changed = { ...candidate, identity: changedIdentity, renderer: { ...candidate.renderer, configurationSha256: changedSha },
      sourceClaim: { ...candidate.sourceClaim, identity: changedIdentity } }
    const saved = await f.write(changed)
    await expect(readEpisodeDescriptorV4(f.file, saved.hash, saved.bytes)).rejects.toThrow()
  }
})

it('binds generated subtitle clocks and refuses altered stage inputs without changing v1 parsing', async () => {
  const f = await fixture(), subtitle = join(f.project, 'editing', 'subtitle.srt')
  const original = (path: string, bytes: string) => ({ path, sha256: hash(bytes), bytes: bytes.length })
  const clockInputs = { clock: original(`${subtitle}.clock.json`, 'clock'),
    manifest: original(join(f.project, 'editing', '01-sources.json'), 'manifest'),
    master: original(join(f.project, 'audio', '01.wav'), 'master'),
    shots: [{ shot: 1, video: original(join(f.project, 'video', '01', 'shot_001.mp4'), '0'),
      audio: original(join(f.project, 'audio', 'original.wav'), 'audio') }] }
  const clockStage = { clockPath: `${f.legacy.subtitlePath}.clock.json`,
    manifestPath: join(f.legacy.stageRoot, 'editing', '01-sources.json'),
    masterPath: join(f.legacy.stageRoot, 'audio', '01.wav'),
    audio: [{ shot: 1, originalPath: clockInputs.shots[0]!.audio.path,
      stagedPath: join(f.legacy.stageRoot, '__clock', 'audio-1.wav') }] }
  const facts = [[clockInputs.clock, clockStage.clockPath], [clockInputs.manifest, clockStage.manifestPath],
    [clockInputs.master, clockStage.masterPath], [clockInputs.shots[0]!.audio, clockStage.audio[0]!.stagedPath]] as const
  const stagedFiles = [...f.legacy.stagedFiles, ...facts.map(([fact, path]) => ({ ...fact, path }))]
  const configurationSha256 = episodeFactsHash({ configuration: f.legacy.configuration, clockInputs })
  const value = { ...f.legacy, version: 3, clockInputs, clockStage, stagedFiles,
    identity: { ...f.legacy.identity, configurationSha256 },
    renderer: { ...f.legacy.renderer, configurationSha256 },
    projectFiles: [...f.legacy.projectFiles, { ...f.legacy.stagedFiles[2]!, originalPath: subtitle, role: 'subtitle' }] }
  const good = await f.write(value)
  expect((await readEpisodeDescriptorV3(f.file, good.hash, good.bytes)).version).toBe(3)
  await expect(readEpisodeDescriptor(f.file, good.hash, good.bytes)).rejects.toThrow()
  const { clock: _unusedClock, ...manualInputs } = clockInputs
  const { clockPath: _unusedClockPath, ...manualStage } = clockStage
  const manualSha = episodeFactsHash({ configuration: f.legacy.configuration, clockInputs: manualInputs })
  const manual = { ...value, clockInputs: manualInputs, clockStage: manualStage,
    stagedFiles: stagedFiles.filter(file => file.path !== clockStage.clockPath),
    identity: { ...value.identity, configurationSha256: manualSha }, renderer: { ...value.renderer, configurationSha256: manualSha } }
  const manualBytes = await f.write(manual)
  expect((await readEpisodeDescriptorV3(f.file, manualBytes.hash, manualBytes.bytes)).clockInputs.clock).toBeUndefined()
  const { master: _unusedMaster, ...legacyInputs } = manualInputs
  const { masterPath: _unusedMasterPath, ...legacyStage } = manualStage
  const legacySha = episodeFactsHash({ configuration: f.legacy.configuration, clockInputs: legacyInputs })
  const legacy = { ...manual, clockInputs: legacyInputs, clockStage: legacyStage,
    stagedFiles: manual.stagedFiles.filter(file => file.path !== clockStage.masterPath),
    identity: { ...manual.identity, configurationSha256: legacySha }, renderer: { ...manual.renderer, configurationSha256: legacySha } }
  const legacyBytes = await f.write(legacy)
  expect((await readEpisodeDescriptorV3(f.file, legacyBytes.hash, legacyBytes.bytes)).clockInputs.master).toBeUndefined()
  for (const bad of [
    { ...value, clockInputs: { ...clockInputs, master: { ...clockInputs.master, sha256: hash('changed') } } },
    { ...value, clockStage: { ...clockStage, clockPath: join(f.root, 'escape') } },
    { ...value, stagedFiles: stagedFiles.filter(file => file.path !== clockStage.masterPath) },
    { ...value, clockInputs: { ...legacyInputs, clock: clockInputs.clock },
      clockStage: { ...legacyStage, clockPath: clockStage.clockPath } },
  ]) {
    const written = await f.write(bad)
    await expect(readEpisodeDescriptorV3(f.file, written.hash, written.bytes)).rejects.toThrow()
  }
})
