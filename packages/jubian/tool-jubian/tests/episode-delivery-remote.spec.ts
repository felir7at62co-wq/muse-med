/** Authenticated Connection/Gateway calls consume the real episode delivery service. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import * as Files from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as HostConnection from '@deepseek-ai/dsh-client-connection'
import { installConnection, type ConnectionHandle, type ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { brandString } from '@deepseek-ai/dsh-brand'
import { afterEach, expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import type { EpisodeAdmissionInput, EpisodeReadinessInput, VideoArtifactSha256 } from '../src/types.ts'
import { createEpisodeDeliveryFixture } from './fixtures/episode-delivery.ts'
import * as EpisodeDelivery from '../src/episode-delivery.ts'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
const actualFiles = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
afterEach(() => { vi.restoreAllMocks() })

const hash = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u).transform(value => brandString<VideoArtifactSha256>(value))
const readinessSchema = z.object({ projectDir: z.string(), episode: z.number().int(), ready: z.boolean(),
  digest: digestSchema.nullable(), shots: z.number().int().nonnegative(), issues: z.array(z.string()),
  renderer: z.object({ generation: z.uuid(), configurationSha256: digestSchema, codeSha256: digestSchema }).nullable() })
const statusSchema = z.object({ projectDir: z.string(), episode: z.number().int(), digest: digestSchema,
  attempt: z.uuid().nullable(), state: z.enum(['not-admitted', 'queued', 'preparing', 'running', 'stopping',
    'completed', 'cancelled', 'failed', 'unknown']), canResume: z.boolean(), execution: z.uuid().optional(),
  output: z.object({ path: z.string(), sha256: digestSchema, bytes: z.number().int().positive() }).optional(),
  cancellationReason: z.enum(['configuration-changed', 'provider-disposed', 'explicit-stop', 'host-disconnected']).optional(),
  problem: z.string().optional() })

function valueOf(result: ConnectionRpcResult<unknown>): unknown {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}

/** No endpoint substitute: every call crosses the real HTTP auth and Gateway routes. */
async function fixture(authenticated = true) {
  const f = await createEpisodeDeliveryFixture()
  onTestFinished(() => { expect(f.fetch).not.toHaveBeenCalled() })
  await f.ctx.plugin(LocalCredentials, { path: join(f.root, 'browser-credentials.yaml'), watch: false }).await()
  await f.ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
  await f.ctx.plugin(HostConnection).await()
  await f.ctx.plugin(TypertRegistry).await()
  await f.ctx.plugin(RemoteAccess).await()
  await f.ctx.plugin(TypertGateway).await()
  const origin = `http://127.0.0.1:${f.ctx.webServer.port}`
  const clientContext = new Context()
  onTestFinished(async () => { await clientContext.fiber.dispose() })
  let cookie: string | undefined
  let loseNextAdmissionReply: AbortController | undefined
  const endpoints: string[] = []
  installConnection(clientContext, { transport: { fetch: async (input, init) => {
    const url = new URL(input, origin), headers = new Headers(init.headers)
    if (cookie !== undefined) headers.set('cookie', cookie)
    endpoints.push(url.pathname)
    const response = await fetch(url, { ...init, headers })
    const lose = loseNextAdmissionReply
    if (lose !== undefined && url.pathname.endsWith('/jubianEpisodeDelivery/admitEpisode') && response.ok) {
      loseNextAdmissionReply = undefined
      const body = await response.arrayBuffer()
      // Real Host admission and response completed; the caller retires before accepting it.
      lose.abort(new Error('controlled reply loss after server commit'))
      return new Response(body, { status: response.status, headers: response.headers })
    }
    return response
  } } })
  // This separate context installed the Client provider; the Host test program types the shared name as its Host provider.
  const connection = clientContext.reflect.get('connection') as ConnectionHandle
  const authenticate = async (): Promise<void> => {
    const target = new URL(f.ctx.connection.authenticatedUrl(`${origin}/connect`))
    target.searchParams.set('interactions', 'none')
    const response = await fetch(target, { redirect: 'manual', headers: { accept: 'application/json' } })
    expect(response.status).toBe(302)
    const saved = response.headers.get('set-cookie')
    await response.text()
    if (saved === null) throw new Error('Connection did not issue its authenticated cookie')
    cookie = saved.split(';', 1)[0]!
  }
  if (authenticated) await authenticate()
  const call = (method: 'episodeReadiness' | 'admitEpisode' | 'episodeStatus' | 'episodeHistory',
    input: EpisodeReadinessInput | EpisodeAdmissionInput, signal?: AbortSignal) =>
    connection.rpc.call('/api', `jubianEpisodeDelivery/${method}`, { args: { input } }, signal)
  const readiness = async () => readinessSchema.parse(valueOf(await call('episodeReadiness', f.planInput)))
  let lastStatus: z.output<typeof statusSchema> | undefined
  const status = async (input: EpisodeAdmissionInput) => {
    lastStatus = statusSchema.parse(valueOf(await call('episodeStatus', input)))
    return lastStatus
  }
  onTestFailed(() => { if (lastStatus !== undefined) process.stderr.write(`Episode transport last status: ${JSON.stringify(lastStatus)}\n`) })
  const admit = async (input: EpisodeAdmissionInput, signal?: AbortSignal) =>
    statusSchema.parse(valueOf(await call('admitEpisode', input, signal)))
  const originalKeys = async () => (await f.ledger.records()).map(row => row.idempotency_key).sort()
  return { ...f, connection, origin, endpoints, authenticate, call, readiness, status, admit, originalKeys,
    aCall: (method: 'status' | 'configure', args: object) => connection.rpc.call('/api', `jubianVideoRecovery/${method}`, { args }),
    loseNextReply: (controller: AbortController) => { loseNextAdmissionReply = controller } }
}

function admission(input: EpisodeReadinessInput, readiness: z.output<typeof readinessSchema>): EpisodeAdmissionInput {
  if (readiness.digest === null) throw new Error('The fixture did not produce an admissible plan digest')
  return { ...input, digest: readiness.digest }
}

it('requires actual browser authentication before any episode method runs', async () => {
  const f = await fixture(false)
  const input = { ...f.planInput, digest: brandString<VideoArtifactSha256>('a'.repeat(64)) }
  for (const method of ['episodeReadiness', 'admitEpisode', 'episodeStatus', 'episodeHistory'] as const) {
    await expect(f.call(method, input)).rejects.toThrow('HTTP 401')
  }
  expect(f.renderer.calls).toBe(0)
  await f.authenticate()
  expect(await f.readiness()).toMatchObject({ projectDir: f.project, episode: 1, ready: true })
})

it('reports current verified input facts and refuses a source changed after readiness', async () => {
  const f = await fixture(), keys = await f.originalKeys()
  const ready = await f.readiness()
  expect(ready.ready).toBe(true)
  expect(ready.shots).toBeGreaterThan(0)
  expect(ready.issues).toEqual([])
  expect(ready.renderer).not.toBeNull()
  const input = admission(f.planInput, ready)
  expect(await f.status(input)).toMatchObject({ state: 'not-admitted', attempt: null, canResume: false })
  const original = join(f.project, 'video_tasks', 'review', `original-${hash(f.sourceBytes)}.mp4`)
  expect(await readFile(original)).toEqual(f.sourceBytes)
  await writeFile(original, 'changed source after readiness')
  expect((await f.readiness()).ready).toBe(false)
  await expect(f.admit(input)).rejects.toThrow()
  expect(f.renderer.calls).toBe(0)
  expect(await f.originalKeys()).toEqual(keys)
})

it('returns short durable admission before the held renderer completes and reuses the original attempt', async () => {
  const f = await fixture(), input = admission(f.planInput, await f.readiness())
  const keys = await f.originalKeys()
  const admitted = await f.admit(input)
  expect(admitted.attempt).not.toBeNull()
  expect(admitted.state).not.toBe('completed')
  expect(admitted.canResume).toBe(false)
  await f.renderer.entered
  expect(f.renderer.calls).toBe(1)
  const duplicate = await f.admit(input)
  expect(duplicate.attempt).toBe(admitted.attempt)
  const ledgerReads = vi.spyOn(f.ledger, 'records')
  for (let i = 0; i < 3; i++) expect((await f.status(input)).attempt).toBe(admitted.attempt)
  expect(ledgerReads).not.toHaveBeenCalled()
  expect(f.renderer.calls).toBe(1)
  ledgerReads.mockRestore()
  f.renderer.release()
  await expect.poll(async () => (await f.status(input)).state).toBe('completed')
  const delivered = await f.status(input)
  expect(delivered.canResume).toBe(false)
  if (delivered.output === undefined) throw new Error('Completed episode omitted its publication receipt')
  const bytes = await readFile(join(f.project, delivered.output.path))
  expect(hash(bytes)).toBe(delivered.output.sha256)
  expect(bytes.length).toBe(delivered.output.bytes)
  expect(await f.originalKeys()).toEqual(keys)
})

it('looks up the committed original after a lost response without reposting admission', async () => {
  const f = await fixture(), input = admission(f.planInput, await f.readiness())
  // A cheap read can legitimately win before the short admission commits.
  expect((await f.status(input)).state).toBe('not-admitted')
  const caller = new AbortController()
  f.loseNextReply(caller)
  await expect(f.admit(input, caller.signal)).rejects.toThrow('controlled reply loss')
  await f.renderer.entered
  const original = await f.status(input)
  expect(original.attempt).not.toBeNull()
  expect(original.state).not.toBe('not-admitted')
  for (let i = 0; i < 3; i++) expect((await f.status(input)).attempt).toBe(original.attempt)
  expect(f.endpoints.filter(path => path.endsWith('/jubianEpisodeDelivery/admitEpisode'))).toHaveLength(1)
  expect(f.renderer.calls).toBe(1)
  f.renderer.release()
  await expect.poll(async () => (await f.status(input)).state).toBe('completed')
})

it('cancels the admitted original without retargeting it when A project selection changes through Remote', async () => {
  const f = await fixture(), input = admission(f.planInput, await f.readiness())
  const admitted = await f.admit(input)
  await f.renderer.armed
  expect(f.renderer.encodes).toBe(1)
  const other = join(f.root, 'other-project')
  await mkdir(other)
  await writeFile(join(other, 'project_config.json'), '{"jubian_script_id":2}\n')
  expect(valueOf(await f.aCall('configure', { input: { enabled: false, projectDir: other } })))
    .toMatchObject({ projectDir: other })
  expect(valueOf(await f.aCall('status', {}))).toMatchObject({ projectDir: other })
  expect(await f.status(input)).toMatchObject({ projectDir: f.project, attempt: admitted.attempt })
  expect(f.renderer.calls).toBe(1)
  f.renderer.release()
  await expect.poll(async () => (await f.status(input)).state).toBe('cancelled')
  expect(await f.status(input)).toMatchObject({ projectDir: f.project, attempt: admitted.attempt,
    cancellationReason: 'configuration-changed' })
  expect((await f.status(input)).output).toBeUndefined()
  await expect(readdir(join(other, 'exports'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.renderer.calls).toBe(1)
})

it('keeps the admitted original unknown when project selection changes before renderer arming through Remote', async () => {
  const f = await fixture(), input = admission(f.planInput, await f.readiness())
  const keys = await f.originalKeys(), staging = Promise.withResolvers<undefined>()
  const hashFile = EpisodeDelivery.hashEpisodeFile
  vi.spyOn(EpisodeDelivery, 'hashEpisodeFile').mockImplementation(async (path, signal) => {
    if (basename(path) === 'source.mp4') {
      staging.resolve(undefined)
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
    return hashFile(path, signal)
  })
  const admitted = await f.admit(input)
  await staging.promise
  expect(f.renderer.calls).toBe(1)
  expect(f.renderer.encodes).toBe(0)
  const other = join(f.root, 'other-project')
  await mkdir(other)
  await writeFile(join(other, 'project_config.json'), '{"jubian_script_id":2}\n')
  expect(valueOf(await f.aCall('configure', { input: { enabled: false, projectDir: other } })))
    .toMatchObject({ projectDir: other })
  await expect.poll(async () => (await f.status(input)).state).toBe('unknown')
  expect(await f.status(input)).toMatchObject({ projectDir: f.project, attempt: admitted.attempt,
    state: 'unknown', canResume: false, problem: 'Approved source cancelled: configuration-changed' })
  expect((await f.status(input)).output).toBeUndefined()
  expect(await f.admit({ ...input, resume: true })).toMatchObject({ attempt: admitted.attempt, state: 'unknown', canResume: false })
  await expect(readdir(join(other, 'exports'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.renderer.calls).toBe(1)
  expect(f.renderer.encodes).toBe(0)
  expect(await f.originalKeys()).toEqual(keys)
})

it('uses only original lookup after a durable intent returns a Remote error and an earlier read saw no admission', async () => {
  const f = await fixture(), input = admission(f.planInput, await f.readiness())
  const keys = await f.originalKeys()
  expect((await f.status(input)).state).toBe('not-admitted')
  const witness: { path?: string; bytes?: Buffer } = {}
  const link = vi.spyOn(Files, 'link').mockImplementation(async (source, destination) => {
    await actualFiles.link(source, destination)
    if (typeof destination === 'string' && destination.startsWith(join(f.project, '.muse', 'episode-delivery') + sep)
      && basename(destination) === 'intent.json' && witness.path === undefined) {
      witness.path = destination
      witness.bytes = await actualFiles.readFile(destination)
      // The actual exclusive link committed; this call lost its acknowledgement.
      throw new Error('controlled intent publication acknowledgement failure')
    }
  })
  try { await expect(f.admit(input)).rejects.toThrow() } finally { link.mockRestore() }
  if (witness.path === undefined || witness.bytes === undefined) throw new Error('The intended durable-link failure was not reached')
  const original = await f.status(input)
  expect(original).toMatchObject({ projectDir: f.project, episode: input.episode, digest: input.digest, state: 'unknown' })
  expect(original.attempt).not.toBeNull()
  for (let i = 0; i < 3; i++) expect(await f.status(input)).toEqual(original)
  expect(await readFile(witness.path)).toEqual(witness.bytes)
  expect(f.endpoints.filter(path => path.endsWith('/jubianEpisodeDelivery/admitEpisode'))).toHaveLength(1)
  expect(f.renderer.calls).toBe(0)
  expect(await f.originalKeys()).toEqual(keys)
})

it('requires explicit resume of the same drained attempt after project cancellation', async () => {
  const f = await fixture(), input = admission(f.planInput, await f.readiness())
  const keys = await f.originalKeys(), admitted = await f.admit(input)
  if (admitted.attempt === null) throw new Error('Admission did not retain its original attempt')
  await f.renderer.entered
  const root = join(f.project, '.muse', 'episode-delivery', admitted.attempt)
  await expect.poll(async () => (await readdir(root)).includes('execution.json')).toBe(true)
  const armed = z.object({ identity: z.object({ execution: z.uuid() }) })
    .parse(JSON.parse(await readFile(join(root, 'execution.json'), 'utf8')))
  const other = join(f.root, 'other-project')
  await mkdir(other)
  await writeFile(join(other, 'project_config.json'), '{"jubian_script_id":2}\n')
  valueOf(await f.aCall('configure', { input: { enabled: false, projectDir: other } }))
  await expect.poll(async () => (await f.status(input)).canResume).toBe(true)
  const cancelled = await f.status(input)
  expect(cancelled).toMatchObject({ attempt: admitted.attempt, execution: armed.identity.execution,
    state: 'cancelled', cancellationReason: 'configuration-changed', canResume: true })
  valueOf(await f.aCall('configure', { input: { enabled: false, projectDir: f.project } }))
  expect(await f.admit(input)).toEqual(cancelled)
  expect(f.renderer.calls).toBe(1)
  f.renderer.release()
  expect(await f.admit({ ...input, resume: true })).toMatchObject({ attempt: admitted.attempt, state: 'queued', canResume: false })
  await expect.poll(async () => (await f.status(input)).state).toBe('completed')
  const resumed = await f.status(input)
  expect(resumed).toMatchObject({ attempt: admitted.attempt, canResume: false })
  expect(resumed.execution).not.toBe(armed.identity.execution)
  expect(f.renderer.calls).toBe(2)
  expect(await f.originalKeys()).toEqual(keys)
})

it('pauses new admission while reads remain available and resumes only an explicit user request', async () => {
  const f = await fixture(), input = admission(f.planInput, await f.readiness())
  f.service.pauseAdmission()
  await expect(f.admit(input)).rejects.toThrow()
  expect((await f.status(input)).state).toBe('not-admitted')
  expect(f.renderer.calls).toBe(0)
  f.service.resumeAdmission()
  expect((await f.status(input)).state).toBe('not-admitted')
  expect(f.renderer.calls).toBe(0)
  const admitted = await f.admit(input)
  expect(admitted.attempt).not.toBeNull()
  await f.renderer.entered
  expect(f.renderer.calls).toBe(1)
})

it('keeps unknown on the original attempt through duplicate admission, pause and refresh', async () => {
  const f = await fixture()
  f.renderer.mode = 'unknown'
  const input = admission(f.planInput, await f.readiness()), admitted = await f.admit(input)
  await f.renderer.entered
  f.renderer.release()
  await expect.poll(async () => (await f.status(input)).state).toBe('unknown')
  expect(await f.admit(input)).toMatchObject({ attempt: admitted.attempt, state: 'unknown', canResume: false })
  expect(await f.admit({ ...input, resume: true })).toMatchObject({ attempt: admitted.attempt, state: 'unknown', canResume: false })
  f.service.pauseAdmission(); f.service.resumeAdmission()
  for (let i = 0; i < 3; i++) expect(await f.status(input)).toMatchObject({ attempt: admitted.attempt, state: 'unknown' })
  expect(f.renderer.calls).toBe(1)
})

it('reads publication facts cheaply and offers explicit repair when the output disappears', async () => {
  const f = await fixture(), input = admission(f.planInput, await f.readiness())
  await f.admit(input); await f.renderer.entered; f.renderer.release()
  await expect.poll(async () => (await f.status(input)).state).toBe('completed')
  const published = await f.status(input)
  if (published.output === undefined) throw new Error('Completed episode omitted its publication receipt')
  const outputPath = join(f.project, published.output.path)
  await writeFile(outputPath, Buffer.alloc(published.output.bytes, 'x'))
  const ledgerReads = vi.spyOn(f.ledger, 'records')
  const outputOpens = vi.spyOn(Files, 'open')
  const captures = f.renderer.captures, encodes = f.renderer.encodes
  expect(await f.status(input)).toEqual(published)
  await unlink(outputPath)
  for (let i = 0; i < 3; i++) expect(await f.status(input)).toEqual({ ...published, canResume: true })
  expect(ledgerReads).not.toHaveBeenCalled()
  expect(outputOpens.mock.calls.filter(([path]) => path === outputPath)).toHaveLength(0)
  expect(f.renderer.calls).toBe(1)
  expect(f.renderer.captures).toBe(captures)
  expect(f.renderer.encodes).toBe(encodes)
  ledgerReads.mockRestore()
  outputOpens.mockRestore()
})


it('discovers selectable original identities through authenticated history without renderer or status work', async () => {
  const f = await fixture(), input = admission(f.planInput, await f.readiness())
  await f.admit(input); f.renderer.release()
  await expect.poll(async () => (await f.status(input)).state).toBe('completed')
  const completed = await f.status(input), calls = f.renderer.calls, captures = f.renderer.captures
  const keys = await f.originalKeys(), originalRead = vi.spyOn(f.ledger, 'records')
  const historySchema = z.strictObject({ projectDir: z.string(), episode: z.number(), entries: z.array(z.strictObject({
    attempt: z.uuid(), digest: digestSchema, recordedState: z.enum(['queued', 'preparing', 'running', 'stopping', 'completed', 'cancelled', 'failed', 'unknown']).nullable(),
  })), truncated: z.boolean(), unreadableRecords: z.number().int().nonnegative(), scannedEntries: z.number().int().nonnegative() })
  const history = historySchema.parse(valueOf(await f.call('episodeHistory', f.planInput)))
  expect(history).toEqual({ ...f.planInput, entries: [{ attempt: completed.attempt, digest: input.digest, recordedState: 'completed' }],
    truncated: false, unreadableRecords: 0, scannedEntries: 1 })
  expect(originalRead).not.toHaveBeenCalled()
  expect(f.renderer.calls).toBe(calls); expect(f.renderer.captures).toBe(captures)
  expect(f.service.hasActiveWork()).toBe(false)
  originalRead.mockRestore(); expect(await f.originalKeys()).toEqual(keys)
  const controller = new AbortController(); controller.abort(new Error('history observer retired'))
  await expect(f.call('episodeHistory', f.planInput, controller.signal)).rejects.toThrow('history observer retired')
  expect(f.renderer.calls).toBe(calls)
  expect(f.endpoints.at(-1)).toBe('/api/jubianEpisodeDelivery/episodeHistory')
})
