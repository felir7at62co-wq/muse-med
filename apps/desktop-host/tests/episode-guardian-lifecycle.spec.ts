/** Real source-profile Host crash, durable job ordering and native FFmpeg drain. */
import { spawn, execFile } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { watch } from 'node:fs'
import { access, mkdtemp, mkdir, realpath, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { initProfile, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { resolveExampleLaunch, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'
import { createEpisodeDeliveryJob, executionIdentitySchema, attemptIdentitySchema } from '@deepseek-ai/dsh-tool-jubian/episode-delivery'
import type { EpisodeDeliveryJob } from '@deepseek-ai/dsh-tool-jubian/episode-delivery'
import type { VideoArtifactSha256, VideoRecoveryDigest } from '@deepseek-ai/dsh-tool-jubian/types'
import { guardianEnvironment, launchGuardian } from '../src/episode-guardian-launcher.ts'
import { createGuardianJournal, guardianParsers } from '../src/episode-guardian-journal.ts'

const ffmpeg = process.env.MUSE_GUARDIAN_TEST_FFMPEG
const ffprobe = process.env.MUSE_GUARDIAN_TEST_FFPROBE
const native = process.platform !== 'win32' && ffmpeg !== undefined && ffprobe !== undefined
const command = promisify(execFile)
// Match loader-smoke's process budget; the outer case retains its 15-second cleanup allowance.
const PROCESS_MS = LOADER_SMOKE_TEST_TIMEOUT_MS - 15_000
const resources: {
  root: string
  children: Set<ChildProcessWithoutNullStreams>
  guardianPids: Map<number, string>
  mediaPids: Map<number, string>
  releases: string[]
}[] = []
function alive(pid: number): boolean { try { process.kill(pid, 0); return true } catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
  throw error
} }
async function signalOwned(pid: number, witness: string, signal: NodeJS.Signals): Promise<void> {
  if (!alive(pid)) return
  let current: string
  try { current = (await command('ps', ['-p', String(pid), '-o', 'command='])).stdout } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 1) return
    throw error
  }
  if (!current.includes(witness)) throw new Error(`refusing to signal a PID without its private execution witness: ${pid}`)
  process.kill(pid, signal)
}
async function gone(pid: number): Promise<void> { await expect.poll(() => alive(pid), { timeout: PROCESS_MS }).toBe(false) }
async function file(path: string): Promise<Buffer> {
  const controller = AbortSignal.timeout(PROCESS_MS)
  const watcher = watch(dirname(path))
  let abort = (): void => {}
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const check = async (): Promise<void> => {
        try { resolve(await readFile(path)) } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) reject(error instanceof Error ? error : new Error(String(error)))
        }
      }
      abort = (): void => { reject(new Error(`native fixture did not publish ${path}`)) }
      controller.addEventListener('abort', abort, { once: true })
      watcher.once('error', reject)
      watcher.on('change', () => { void check().catch(reject) })
      void check().catch(reject)
    })
  } finally { watcher.close(); controller.removeEventListener('abort', abort) }
}
async function mediaPid(progress: string): Promise<number> {
  let pid: number | undefined
  await expect.poll(async () => {
    const result = await command('ps', ['-axo', 'pid=,command='])
    for (const line of result.stdout.split('\n')) {
      if (!line.includes(progress) || !line.includes('-f lavfi')) continue
      const candidate = Number.parseInt(line.trim(), 10)
      if (Number.isSafeInteger(candidate)) pid = candidate
    }
    return pid
  }, { timeout: PROCESS_MS }).toBeDefined()
  if (pid === undefined) throw new Error('owned FFmpeg PID not observed')
  return pid
}
const sourceCarrier = {
  kind: 'source-fixture' as const, executable: process.execPath,
  cli: fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url)),
  tsxEsm: import.meta.resolve('tsx/esm'), tsconfig: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  subprocessEntry: fileURLToPath(new URL('../../../packages/subprocess/subprocess-local/src/index.ts', import.meta.url)),
  workerEntry: fileURLToPath(new URL('./fixtures/episode-guardian-worker.mjs', import.meta.url)),
}
const limits = { requestBytes: 4096, replyBytes: 8192, diagnosticBytes: 4096 }
const workerConfig = { descriptorBytes: 8192, journalBytes: 16384, requestBytes: 4096, replyBytes: 8192,
  lockWaitMs: PROCESS_MS, mediaGraceMs: 100, mediaStdoutBytes: 8192, mediaStderrBytes: 8192, diagnosticBytes: 4096 }
async function setup(complete = false, holdProof = false) {
  if (ffmpeg === undefined || ffprobe === undefined) throw new Error('explicit native resource paths are required')
  await Promise.all([access(ffmpeg), access(ffprobe)])
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-guardian-native-')))
  const resource = { root, children: new Set<ChildProcessWithoutNullStreams>(),
    guardianPids: new Map<number, string>(), mediaPids: new Map<number, string>(), releases: [] as string[] }
  resources.push(resource)
  const attempt = attemptIdentitySchema.parse({ attempt: randomUUID(), rendererGeneration: randomUUID(),
    planSha256: 'a'.repeat(64), projectSha256: 'b'.repeat(64), configurationSha256: 'c'.repeat(64) })
  const job = await createEpisodeDeliveryJob({ projectDir: root, identity: attempt, recordBytes: 16384, lockWaitMs: PROCESS_MS })
  const inputPath = join(job.attemptRoot, 'source.txt'), bytes = Buffer.from('captured episode input\n')
  await writeFile(inputPath, bytes)
  await job.admit({ approvals: [{ idempotencyKey: 'original-approved-key', digest: brandString<VideoRecoveryDigest>('e'.repeat(64)), sha256: attempt.planSha256 }],
    inputs: [{ path: inputPath, sha256: brandString<VideoArtifactSha256>(createHash('sha256').update(bytes).digest('hex')), bytes: bytes.length }] })
  const execution = await prepareExecution(job, complete, holdProof)
  resource.releases.push(execution.descriptor.release)
  return { resource, job, ...execution }
}
async function prepareExecution(job: EpisodeDeliveryJob, complete: boolean, holdProof: boolean) {
  const id = randomUUID(), executionRoot = join(job.attemptRoot, id)
  await mkdir(executionRoot, { mode: 0o700 })
  const current = await job.read(); if (current === undefined) throw new Error('fixture job absent')
  const descriptor = { projectDir: current.projectDir, executionRoot, ffmpeg, ffprobe,
    progress: join(executionRoot, 'progress'), candidate: join(executionRoot, 'candidate.mp4'),
    beforeSpawn: join(executionRoot, 'before-spawn.json'), loaded: join(executionRoot, 'loaded.json'),
    joined: join(executionRoot, 'joined.json'), release: join(executionRoot, 'release'), holdProof, complete,
    retry: 'host-disconnect-recovery' as const }
  const descriptorPath = join(executionRoot, 'descriptor.json'), bytes = Buffer.from(JSON.stringify(descriptor))
  await writeFile(descriptorPath, bytes)
  const record = await job.read(); if (record === undefined) throw new Error('fixture job absent')
  const identity = executionIdentitySchema.parse({ ...record.identity, execution: id, descriptorSha256: createHash('sha256').update(bytes).digest('hex') })
  await job.admitExecution({ identity, descriptorPath, candidatePath: descriptor.candidate, retry: descriptor.retry })
  return { identity, descriptorPath, descriptor, executionRoot }
}
async function startHost(f: Awaited<ReturnType<typeof setup>>) {
  const home = join(f.resource.root, 'host-home'); await mkdir(home, { mode: 0o700 })
  const profile = resolveProfileDir('guardian-host-fixture', home); initProfile(profile, [])
  const patch = join(home, 'host.overlay.json')
  await writeFile(patch, JSON.stringify([{ insert: [{ id: 'host-fixture',
    name: new URL('./fixtures/episode-guardian-host.mjs', import.meta.url).href,
    config: { carrier: sourceCarrier, executionRoot: f.executionRoot, descriptorPath: f.descriptorPath,
      identity: f.identity, limits, workerConfig } }] }]))
  const launch = resolveExampleLaunch({ srcBin: sourceCarrier.cli, mode: 'src', tsconfigPath: sourceCarrier.tsconfig,
    sourceImport: 'tsx/esm', configArgs: ['--profile', 'guardian-host-fixture', '--patch', patch],
    env: guardianEnvironment(home, process.platform) })
  const child = spawn(launch.command, ['--expose-internals', ...launch.args], { cwd: profile, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] })
  f.resource.children.add(child)
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => { resolve({ code, signal }) })
  })
  let stderr = ''; let transcript = ''; child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192) })
  const ready = Promise.withResolvers<number>(), lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    transcript = (transcript + line + '\n').slice(-8192)
    try { const value: unknown = JSON.parse(line)
      const parsed = z.object({ kind: z.literal('guardian-started'), pid: z.number().int().positive() }).safeParse(value)
      if (parsed.success) { f.resource.guardianPids.set(parsed.data.pid, f.executionRoot); ready.resolve(parsed.data.pid) }
    } catch (_diagnosticLine) { /* Only the validated readiness frame counts. */ }
  })
  void closed.finally(() => { lines.close() }).catch(() => {})
  const pid = await Promise.race([ready.promise, closed.then((result) => { throw new Error(`Host closed before guardian: ${JSON.stringify(result)} ${stderr} ${transcript}`) })])
  return { child, closed, pid, diagnostic: () => stderr + transcript }
}

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    for (const path of resource.releases) await writeFile(path, '').catch((_alreadyRemoved: unknown) => {})
    for (const child of resource.children) child.stdin.end()
    for (const [pid, witness] of resource.guardianPids) await signalOwned(pid, witness, 'SIGTERM')
    for (const [pid, witness] of resource.mediaPids) await signalOwned(pid, witness, 'SIGTERM')
    await Promise.all([...resource.children].map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM'); await new Promise((resolve) => { child.once('close', resolve) })
    }))
    await Promise.all([...resource.guardianPids.keys(), ...resource.mediaPids.keys()].map(gone))
    await rm(resource.root, { recursive: true, force: true })
  }
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

it.skipIf(!native)('joins real FFmpeg after only the Host is killed, holding the encoder lock until exact drain publication', async () => {
  const f = await setup(false, true), host = await startHost(f)
  await Promise.race([file(f.descriptor.beforeSpawn), host.closed.then((result) => { throw new Error(`guardian exited before media: ${JSON.stringify(result)} ${host.diagnostic()}`) })])
  await expect.poll(async () => (await readFile(f.descriptor.progress, 'utf8')).includes('progress=continue'), { timeout: PROCESS_MS }).toBe(true)
  const pid = await mediaPid(f.descriptor.progress); f.resource.mediaPids.set(pid, f.descriptor.progress)
  const job = await f.job.read(); expect(job?.executionRef?.identity.execution).toBe(f.identity.execution)
  const running = z.object({ guardianPid: z.number() }).parse(JSON.parse((await file(join(f.job.attemptRoot, 'execution.json'))).toString()))
  expect(running.guardianPid).toBe(host.pid)
  host.child.kill('SIGKILL'); expect(await host.closed).toEqual({ code: null, signal: 'SIGKILL' })
  const joined: unknown = JSON.parse((await file(f.descriptor.joined)).toString())
  expect(joined).toMatchObject({ result: 'cancelled', identity: f.identity, commands: 1, guardianPid: host.pid })
  await gone(pid)
  const journal = createGuardianJournal({ attemptRoot: f.job.attemptRoot, recordBytes: 16384,
    assertAdmission: identity => f.job.assertAdmission(identity), armExecution: record => f.job.armExecution(record) })
  expect(await journal.readDrain(f.identity.execution)).toBeUndefined()
  const next = await prepareExecution(f.job, true, false)
  const successor = await launchGuardian({ carrier: sourceCarrier, executionRoot: next.executionRoot, descriptorPath: next.descriptorPath,
    identity: next.identity, limits, workerConfig, parsers: guardianParsers, rawChildren: f.resource.children })
  await file(next.descriptor.loaded)
  expect((await f.job.read())?.executionRef?.identity.execution).toBe(f.identity.execution)
  await expect(access(next.descriptor.beforeSpawn)).rejects.toThrow()
  successor.stop(); expect((await successor.closed).code).not.toBeNull()
  await expect(successor.result).rejects.toThrow()
  await writeFile(f.descriptor.release, '')
  await expect.poll(async () => await journal.readDrain(f.identity.execution), { timeout: PROCESS_MS }).toMatchObject({ result: 'cancelled', commands: 1 })
  await gone(host.pid)
  expect((await f.job.read())?.armedExecutions).toEqual([f.identity.execution])
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

it.skipIf(!native)('keeps a killed guardian unknown and refuses a new physical renderer before admission', async () => {
  const f = await setup(), host = await startHost(f)
  await Promise.race([file(f.descriptor.beforeSpawn), host.closed.then((result) => { throw new Error(`guardian exited before media: ${JSON.stringify(result)} ${host.diagnostic()}`) })])
  await expect.poll(async () => (await readFile(f.descriptor.progress, 'utf8')).includes('progress=continue'), { timeout: PROCESS_MS }).toBe(true)
  const pid = await mediaPid(f.descriptor.progress); f.resource.mediaPids.set(pid, f.descriptor.progress)
  await signalOwned(host.pid, f.executionRoot, 'SIGKILL'); await gone(host.pid)
  const next = await prepareExecution(f.job, true, false)
  const successor = await launchGuardian({ carrier: sourceCarrier, executionRoot: next.executionRoot, descriptorPath: next.descriptorPath,
    identity: next.identity, limits, workerConfig, parsers: guardianParsers, rawChildren: f.resource.children })
  expect((await successor.result).result).toMatchObject({ kind: 'unknown', previous: { identity: f.identity } })
  await successor.closed
  await expect(access(next.descriptor.beforeSpawn)).rejects.toThrow()
  expect((await f.job.read())?.armedExecutions).toEqual([f.identity.execution])
  await expect(access(join(f.job.attemptRoot, `drained-${f.identity.execution}.json`))).rejects.toThrow()
  // Emergency cleanup is deliberately outside the missing-proof assertion.
  await signalOwned(pid, f.descriptor.progress, 'SIGTERM')
  await gone(pid)
  await host.closed
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

it.skipIf(!native)('publishes actual completed candidate bytes through the real job and source-profile renderer', async () => {
  const f = await setup(true), host = await startHost(f)
  const closed = await host.closed
  expect(closed, host.diagnostic()).toEqual({ code: 0, signal: null })
  const journal = createGuardianJournal({ attemptRoot: f.job.attemptRoot, recordBytes: 16384,
    assertAdmission: identity => f.job.assertAdmission(identity), armExecution: record => f.job.armExecution(record) })
  const proof = await journal.readDrain(f.identity.execution)
  const candidate = await readFile(f.descriptor.candidate)
  expect(proof).toMatchObject({ result: 'completed', commands: 1, identity: f.identity,
    candidate: { outputBytes: candidate.length, outputSha256: createHash('sha256').update(candidate).digest('hex') } })
  expect((await f.job.read())?.armedExecutions).toEqual([f.identity.execution])
  await gone(host.pid)
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

it.skipIf(!native).each([false, true])('cancels before admission and preserves startup failure when EOF races input preparation (failure: %s)', async (fail) => {
  const f = await setup(), startup = { installed: join(f.executionRoot, 'installed'), eof: join(f.executionRoot, 'eof'),
    release: join(f.executionRoot, 'startup-release'), fail }
  f.resource.releases.push(startup.release)
  if (fail) {
    const home = join(f.resource.root, 'required-startup-home'); await mkdir(home, { mode: 0o700 })
    const profile = resolveProfileDir('guardian-startup-failure', home); initProfile(profile, [])
    const overlay = join(home, 'failure.overlay.json')
    await writeFile(overlay, JSON.stringify([{ insert: [
      { id: 'fixture-subprocess', name: new URL('../../../packages/subprocess/subprocess-local/src/index.ts', import.meta.url).href },
      { id: 'headless-runner', name: new URL('./fixtures/episode-guardian-worker.mjs', import.meta.url).href,
        config: { ...workerConfig, descriptorPath: f.descriptorPath,
          descriptorSha256: f.identity.descriptorSha256, fixtureStartup: startup } },
    ] }]))
    const launch = resolveExampleLaunch({ srcBin: sourceCarrier.cli, mode: 'src', sourceImport: 'tsx/esm',
      tsconfigPath: sourceCarrier.tsconfig, configArgs: ['--profile', 'guardian-startup-failure', '--patch', overlay],
      env: guardianEnvironment(home, process.platform) })
    const child = spawn(launch.command, ['--expose-internals', ...launch.args], { cwd: profile, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] })
    f.resource.children.add(child)
    const closed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    let diagnostic = ''; child.stderr.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-8192) })
    child.stdout.resume(); child.stdin.on('error', () => { /* Startup rejection may close stdin before the fixture frame drains. */ })
    child.stdin.end(JSON.stringify({ version: 1, kind: 'run', identity: f.identity }) + '\n')
    expect(await closed, diagnostic).toBe(1)
    expect(diagnostic).toContain('fixture startup rejected after early EOF')
    expect((await f.job.read())?.executionRef).toBeNull()
    await expect(access(f.descriptor.loaded)).rejects.toThrow()
    await expect(access(f.descriptor.beforeSpawn)).rejects.toThrow()
    return
  }
  const guardian = await launchGuardian({ carrier: sourceCarrier, executionRoot: f.executionRoot, descriptorPath: f.descriptorPath,
    identity: f.identity, limits, workerConfig: { ...workerConfig, fixtureStartup: startup },
    parsers: guardianParsers, rawChildren: f.resource.children })
  await file(startup.installed)
  expect((await f.job.read())?.executionRef).toBeNull()
  await expect(access(f.descriptor.loaded)).rejects.toThrow()
  guardian.stop()
  if (!fail) await file(startup.eof)
  expect((await f.job.read())?.executionRef).toBeNull()
  await expect(access(f.descriptor.beforeSpawn)).rejects.toThrow()
  await writeFile(startup.release, '')
  const closed = await guardian.closed
  expect(closed.code).toBe(1)
  if (fail) expect(guardian.diagnostic()).toContain('fixture startup rejected after early EOF')
  await expect(guardian.result).rejects.toThrow()
  expect((await f.job.read())?.executionRef).toBeNull()
  await expect(access(f.descriptor.loaded)).rejects.toThrow()
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
