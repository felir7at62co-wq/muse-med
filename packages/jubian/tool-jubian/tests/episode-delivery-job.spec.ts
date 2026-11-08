/** Durable admission, strict records and one-shot arm ownership use actual files. */
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as files from 'node:fs/promises'
import { expect, it, onTestFinished, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createEpisodeDeliveryJob, readEpisodeRecord, readEpisodeStateSnapshot, attemptIdentitySchema, executionIdentitySchema,
  executionDrainSchema, runningExecutionSchema } from '../src/episode-delivery.ts'
import type { EpisodeExecutionId, RunningExecution, Sha256 } from '../src/episode-delivery.ts'
import type { EpisodeExecutionAdmission } from '../src/episode-delivery-job.ts'
import type { VideoRecoveryDigest } from '../src/types.ts'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

const hash = (value: string): Sha256 => brandString<Sha256>(createHash('sha256').update(value).digest('hex'))

async function fixture(recordBytes = 16384) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'episode-job-')))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const identity = executionIdentitySchema.parse({ attempt: randomUUID(), execution: randomUUID(),
    rendererGeneration: randomUUID(), planSha256: hash('plan'), projectSha256: hash('project'),
    configurationSha256: hash('configuration'), descriptorSha256: hash('descriptor') })
  const options = { projectDir: root, identity, recordBytes, lockWaitMs: 1000 }
  const job = await createEpisodeDeliveryJob(options)
  const input = join(job.attemptRoot, 'input.bin')
  await writeFile(input, 'approved source')
  const admission = { approvals: [{ idempotencyKey: 'original-key', digest: brandString<VideoRecoveryDigest>(hash('approval')),
    sha256: hash('approved source') }] as const, inputs: [{ path: input, sha256: hash('approved source'), bytes: 15 }] as const }
  const execution = async (retry: EpisodeExecutionAdmission['retry'] = 'initial', id = randomUUID()) => {
    const stage = join(job.attemptRoot, id)
    await mkdir(stage)
    const descriptorPath = join(stage, 'descriptor.json'), descriptor = JSON.stringify({ attempt: identity.attempt, execution: id })
    await writeFile(descriptorPath, descriptor)
    const next: EpisodeExecutionAdmission = { identity: { ...identity, execution: brandString<EpisodeExecutionId>(id),
      descriptorSha256: hash(descriptor) }, descriptorPath, candidatePath: join(stage, 'candidate.mp4'), retry }
    await job.admitExecution(next)
    return next
  }
  const running = (value: EpisodeExecutionAdmission): RunningExecution => ({ version: 1, kind: 'running',
    identity: value.identity, guardianPid: process.pid })
  const finish = async (value: EpisodeExecutionAdmission, result: 'failed' | 'cancelled' | 'completed' = 'failed') => {
    await job.assertAdmission(value.identity); await job.armExecution(running(value))
    await writeFile(join(job.attemptRoot, 'execution.json'), JSON.stringify(running(value)))
    const proof = executionDrainSchema.parse({ version: 1, kind: 'drained', identity: value.identity,
      guardianPid: process.pid, commands: 1, result,
      ...(result === 'completed' ? { candidate: { outputSha256: hash('output'), outputBytes: 6 } } : {}) })
    await writeFile(join(job.attemptRoot, `drained-${value.identity.execution}.json`), JSON.stringify(proof))
  }
  return { root, job, options, identity, input, admission, execution, running, finish }
}

it('accepts typed full execution facts as an attempt and shares one durable admission', async () => {
  const f = await fixture()
  expect(await f.job.read()).toBeUndefined()
  const [first, second] = await Promise.all([f.job.admit(f.admission), f.job.admit(f.admission)])
  expect(first).toEqual(second)
  expect(first.identity).toEqual(attemptIdentitySchema.parse({ attempt: f.identity.attempt,
    planSha256: f.identity.planSha256, projectSha256: f.identity.projectSha256,
    rendererGeneration: f.identity.rendererGeneration, configurationSha256: f.identity.configurationSha256 }))
  const fresh = await createEpisodeDeliveryJob(f.options)
  expect(await fresh.read()).toEqual(first)
  await expect(f.job.admit({ ...f.admission, approvals: [{ ...f.admission.approvals[0], idempotencyKey: 'another' }] }))
    .rejects.toThrow('different admission')
})

it('arms once after current verification and persists the reference before any running record', async () => {
  const f = await fixture(); await f.job.admit(f.admission)
  const execution = await f.execution()
  await expect(f.job.armExecution(f.running(execution))).rejects.toThrow('current owned admission verification')
  await f.job.assertAdmission(execution.identity); await f.job.armExecution(f.running(execution))
  expect((await f.job.read())?.executionRef).toEqual(f.running(execution))
  expect(await readEpisodeRecord(join(f.job.attemptRoot, 'execution.json'), 16384)).toBeUndefined()
  await expect(f.job.armExecution(f.running(execution))).rejects.toThrow('current owned admission verification')
  const next = await f.execution('explicit-retry')
  await expect(f.job.assertAdmission(next.identity)).rejects.toThrow('state is unknown')
})

it('rechecks changed file versions under the arm lock without rehashing stale verification', async () => {
  const f = await fixture(); await f.job.admit(f.admission)
  const execution = await f.execution()
  await f.job.assertAdmission(execution.identity)
  await writeFile(f.input, 'changed input with another size')
  await expect(f.job.armExecution(f.running(execution))).rejects.toThrow('changed after verification')
  expect((await f.job.read())?.executionRef).toBeNull()
  await expect(f.job.assertAdmission(execution.identity)).rejects.toThrow('staged input changed')
})

it('requires the matching one-shot verification and detects a changed durable admission', async () => {
  const f = await fixture(); await f.job.admit(f.admission)
  const first = await f.execution(), second = await f.execution()
  await f.job.assertAdmission(first.identity); await f.job.assertAdmission(second.identity)
  await expect(f.job.armExecution(f.running(first))).rejects.toThrow('current owned admission verification')
  await f.job.assertAdmission(first.identity)
  const path = join(f.job.attemptRoot, 'job.json'), record = await f.job.read()
  await writeFile(path, JSON.stringify({ ...record, approvals: [{ ...f.admission.approvals[0], idempotencyKey: 'replaced' }] }))
  await expect(f.job.armExecution(f.running(first))).rejects.toThrow('changed before arming')
})

it('rejects a foreign execution reference even when its latest UUID history is consistent', async () => {
  const f = await fixture(); await f.job.admit(f.admission)
  const execution = await f.execution(); await f.finish(execution)
  const record = await f.job.read(), path = join(f.job.attemptRoot, 'job.json')
  await writeFile(path, JSON.stringify({ ...record, executionRef: { ...f.running(execution), identity: {
    ...execution.identity, configurationSha256: hash('foreign configuration'),
  } } }))
  await expect(f.job.read()).rejects.toThrow('ownership')
})

it('hashes outside the writer lock and arms without a second full media read', async () => {
  const f = await fixture(); await f.job.admit(f.admission)
  const first = await f.execution(), second = await f.execution()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const open = files.open
  const spy = vi.spyOn(files, 'open').mockImplementation(async (...args) => {
    if (args[0] === f.input) { entered.resolve(undefined); await release.promise }
    return open(...args)
  })
  onTestFinished(() => { release.resolve(undefined); spy.mockRestore() })
  const verifying = f.job.assertAdmission(first.identity)
  await entered.promise
  // This operation needs the same job writer lock and must complete while hashing is held.
  expect(await f.job.admitExecution(second)).toEqual(second)
  release.resolve(undefined); await verifying
  spy.mockImplementation(async (...args) => {
    if (args[0] === f.input || args[0] === first.descriptorPath) throw new Error('Heavy input read repeated while arming')
    return open(...args)
  })
  await f.job.armExecution(f.running(first))
  expect((await f.job.read())?.executionRef).toEqual(f.running(first))
})

it('keeps all armed UUIDs occupied after later executions and missing historical proofs', async () => {
  const f = await fixture(); await f.job.admit(f.admission)
  const first = await f.execution('explicit-retry'); await f.finish(first)
  const second = await f.execution('explicit-retry'); await f.finish(second)
  const before = await readFile(join(f.job.attemptRoot, 'job.json'))
  await unlink(join(f.job.attemptRoot, `drained-${first.identity.execution}.json`))
  await expect(f.job.assertAdmission(first.identity)).rejects.toThrow('UUID is already occupied')
  expect(await readFile(join(f.job.attemptRoot, 'job.json'))).toEqual(before)
  expect((await f.job.read())?.armedExecutions).toEqual([first.identity.execution, second.identity.execution])
})

it.each(['execution.json', 'admitted-old.json', 'drained-old.json', 'drain-old.prepared.json', 'admission-old.prepared.json'])(
  'refuses cold readmission with missing job and retained %s', async (name) => {
    const f = await fixture(); await f.job.admit(f.admission)
    await unlink(join(f.job.attemptRoot, 'job.json'))
    const path = join(f.job.attemptRoot, name), bytes = 'retained execution evidence'
    await writeFile(path, bytes)
    expect(await f.job.read()).toBeUndefined()
    await expect(f.job.admit(f.admission)).rejects.toThrow('state is unknown')
    expect(await readFile(path, 'utf8')).toBe(bytes)
    expect(await readEpisodeRecord(join(f.job.attemptRoot, 'job.json'), 16384)).toBeUndefined()
  },
)

it('does not erase the actual armed reference after the job alone disappears', async () => {
  const f = await fixture(); await f.job.admit(f.admission)
  const execution = await f.execution(); await f.finish(execution)
  const path = join(f.job.attemptRoot, 'execution.json'), running = await readFile(path)
  await unlink(join(f.job.attemptRoot, 'job.json'))
  await expect(f.job.admit(f.admission)).rejects.toThrow('state is unknown')
  expect(await readFile(path)).toEqual(running)
  await unlink(path)
  await expect(f.job.admit(f.admission)).rejects.toThrow('state is unknown')
  expect(await readEpisodeRecord(join(f.job.attemptRoot, 'job.json'), 16384)).toBeUndefined()
})

it.each(['failed', 'completed'] as const)('refuses host-disconnect retry after %s', async (outcome) => {
  const f = await fixture(); await f.job.admit(f.admission)
  const previous = await f.execution(); await f.finish(previous, outcome)
  const next = await f.execution('host-disconnect-recovery')
  await expect(f.job.assertAdmission(next.identity)).rejects.toThrow('explicit durable retry')
})

it('allows the durable disconnect retry only after matching cancelled drain', async () => {
  const f = await fixture(); await f.job.admit(f.admission)
  const previous = await f.execution(); await f.finish(previous, 'cancelled')
  const next = await f.execution('host-disconnect-recovery')
  await f.job.assertAdmission(next.identity); await f.job.armExecution(f.running(next))
  expect((await f.job.read())?.executionRef?.identity).toEqual(next.identity)
})

it('refuses a missing or conflicting prior running/drain record', async () => {
  const f = await fixture(); await f.job.admit(f.admission)
  const previous = await f.execution(); await f.finish(previous)
  const next = await f.execution('explicit-retry'), proofPath = join(f.job.attemptRoot, `drained-${previous.identity.execution}.json`)
  await unlink(proofPath)
  await expect(f.job.assertAdmission(next.identity)).rejects.toThrow('state is unknown')
  await writeFile(proofPath, JSON.stringify({ version: 1, kind: 'drained', identity: previous.identity,
    guardianPid: process.pid + 1, commands: 1, result: 'failed' }))
  await expect(f.job.assertAdmission(next.identity)).rejects.toThrow('does not match')
})

it('rejects unadmitted, changed descriptors and occupied candidates without replacing bytes', async () => {
  const f = await fixture()
  await expect(f.execution()).rejects.toThrow('not been admitted')
  await f.job.admit(f.admission)
  await expect(f.job.assertAdmission(f.identity)).rejects.toThrow('physical execution has not been admitted')
  const execution = await f.execution()
  expect(await f.job.readExecution(execution.identity.execution)).toEqual(execution)
  expect(await f.job.admitExecution(execution)).toEqual(execution)
  await expect(f.job.admitExecution({ ...execution, retry: 'explicit-retry' })).rejects.toThrow('admission conflicts')
  await writeFile(execution.candidatePath, 'occupied')
  await expect(f.job.assertAdmission(execution.identity)).rejects.toThrow('destination is occupied')
  expect(await readFile(execution.candidatePath, 'utf8')).toBe('occupied')
  await unlink(execution.candidatePath); await writeFile(execution.descriptorPath, '{}')
  await expect(f.job.assertAdmission(execution.identity)).rejects.toThrow('descriptor changed')
  await expect(f.job.admitExecution(execution)).rejects.toThrow('descriptor changed')
})

it('distinguishes missing from malformed, over-budget and nonregular journal files', async () => {
  const f = await fixture(), path = join(f.root, 'record.json')
  expect(await readEpisodeRecord(path, 4)).toBeUndefined()
  await writeFile(path, '{}'); expect(await readEpisodeRecord(path, 4)).toEqual({})
  await writeFile(path, '{'); await expect(readEpisodeRecord(path, 4)).rejects.toThrow(SyntaxError)
  await writeFile(path, '12345'); await expect(readEpisodeRecord(path, 4)).rejects.toThrow('bounded regular file')
  await expect(readEpisodeRecord(f.root, 4)).rejects.toThrow('bounded regular file')
  await expect(f.job.admit(f.admission)).resolves.toMatchObject({ executionRef: null })
  await writeFile(join(f.job.attemptRoot, 'job.json'), '{')
  await expect(f.job.read()).rejects.toThrow(SyntaxError)
})

it('observes bounded state JSON and rejects missing-parent errors, malformed JSON and oversized files', async () => {
  const f = await fixture(), path = join(f.root, 'state.json')
  expect(await readEpisodeStateSnapshot(path, 4)).toBeUndefined()
  await writeFile(path, '{}'); expect(await readEpisodeStateSnapshot(path, 2)).toEqual({})
  await expect(readEpisodeStateSnapshot(join(path, 'nested.json'), 4)).rejects.toThrow()
  await writeFile(path, '{'); await expect(readEpisodeStateSnapshot(path, 4)).rejects.toThrow(SyntaxError)
  await writeFile(path, '12345'); await expect(readEpisodeStateSnapshot(path, 4)).rejects.toThrow('bounded regular file')
  await expect(readEpisodeStateSnapshot(f.root, 4)).rejects.toThrow('bounded regular file')
})

it('retains the complete opened state when its path is atomically replaced', async () => {
  const f = await fixture(), path = join(f.root, 'state.json')
  await writeFile(path, '{"state":"running"}')
  const open = files.open
  const spy = vi.spyOn(files, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (args[0] === path) {
      await files.rename(path, path + '.old')
      await writeFile(path, '{"state":"completed"}')
    }
    return handle
  })
  try {
    expect(await readEpisodeStateSnapshot(path, 128)).toEqual({ state: 'running' })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ state: 'completed' })
  } finally { spy.mockRestore() }
})

it.each(['growth before reading', 'size change after reading', 'same-size modification after reading'] as const)(
  'refuses mutable state %s through the actual descriptor', async (change) => {
    const f = await fixture(), path = join(f.root, 'state.json')
    await writeFile(path, '{}')
    const open = files.open
    const spy = vi.spyOn(files, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (args[0] === path) {
        const stat = handle.stat.bind(handle)
        let calls = 0
        Object.defineProperty(handle, 'stat', { value: async () => {
          if (++calls === 2 && change !== 'growth before reading') {
            await writeFile(path, change === 'size change after reading' ? '{"changed":true}' : '[]')
            const before = await stat()
            await files.utimes(path, before.atime, new Date(before.mtimeMs + 2000))
          }
          const result = await stat()
          if (calls === 1 && change === 'growth before reading') await writeFile(path, '12345')
          return result
        } })
      }
      return handle
    })
    try { await expect(readEpisodeStateSnapshot(path, 4)).rejects.toThrow('changed or exceeded') }
    finally { spy.mockRestore() }
  },
)

it('honors state observation cancellation and closes an already opened descriptor', async () => {
  const f = await fixture(), path = join(f.root, 'state.json'), control = new AbortController()
  await writeFile(path, '{}')
  const open = files.open
  let opened: Awaited<ReturnType<typeof open>> | undefined
  const spy = vi.spyOn(files, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (args[0] === path) {
      opened = handle
      const stat = handle.stat.bind(handle)
      Object.defineProperty(handle, 'stat', { value: async () => {
        const result = await stat(); control.abort(new Error('State observation cancelled')); return result
      } })
    }
    return handle
  })
  try {
    await expect(readEpisodeStateSnapshot(path, 4, control.signal)).rejects.toThrow('State observation cancelled')
    expect(opened?.fd).toBe(-1)
    await expect(readEpisodeStateSnapshot(path, 4, control.signal)).rejects.toThrow('State observation cancelled')
  } finally { spy.mockRestore() }
})

it.skipIf(process.platform === 'win32')('does not follow a state observation symlink', async () => {
  const f = await fixture(), path = join(f.root, 'state-link.json')
  await symlink(f.input, path)
  await expect(readEpisodeStateSnapshot(path, 16384)).rejects.toThrow('bounded regular file')
})

it.skipIf(process.platform === 'win32')('refuses a named pipe state without waiting for a writer', async () => {
  const f = await fixture(), path = join(f.root, 'state-pipe')
  execFileSync('mkfifo', [path])
  await expect(readEpisodeStateSnapshot(path, 4)).rejects.toThrow('bounded regular file')
})

it('retains strict path identity and absence semantics in the Windows state-observation branch', async () => {
  const f = await fixture(), path = join(f.root, 'state.json')
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  if (descriptor === undefined) throw new Error('Expected process platform descriptor')
  const open = files.open
  let replace = false
  const spy = vi.spyOn(files, 'open').mockImplementation(async (...args) => {
    if (args[0] === path && replace) {
      await files.rename(path, path + '.old'); await writeFile(path, '{}')
    }
    return open(...args)
  })
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
    expect(await readEpisodeStateSnapshot(path, 4)).toBeUndefined()
    await writeFile(path, '{}'); expect(await readEpisodeStateSnapshot(path, 4)).toEqual({})
    replace = true
    await expect(readEpisodeStateSnapshot(path, 4)).rejects.toThrow('changed while opening')
  } finally { Object.defineProperty(process, 'platform', descriptor); spy.mockRestore() }
})

it.skipIf(process.platform === 'win32')('keeps an existing symlink rejected through the Windows compatibility branch', async () => {
  const f = await fixture(), path = join(f.root, 'state-link.json')
  await symlink(f.input, path)
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  if (descriptor === undefined) throw new Error('Expected process platform descriptor')
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
    await expect(readEpisodeStateSnapshot(path, 16384)).rejects.toThrow('bounded regular file')
  } finally { Object.defineProperty(process, 'platform', descriptor) }
})

it('rejects unknown durable fields, unsupported versions and changed logical identities', async () => {
  const f = await fixture(); await f.job.admit(f.admission)
  const path = join(f.job.attemptRoot, 'job.json'), record = await f.job.read()
  for (const value of [{ ...record, extra: true }, { ...record, version: 2 },
    { ...record, identity: { ...record?.identity, projectSha256: hash('other') } },
    { ...record, armedExecutions: [randomUUID()] }]) {
    await writeFile(path, JSON.stringify(value)); await expect(f.job.read()).rejects.toThrow()
  }
  expect(() => runningExecutionSchema.parse({ version: 1, kind: 'running', identity: f.identity, guardianPid: 0 })).toThrow()
})

it('refuses duplicate inputs, changed staged hashes and paths outside the captured attempt', async () => {
  const f = await fixture()
  await expect(f.job.admit({ ...f.admission, inputs: [...f.admission.inputs, ...f.admission.inputs] })).rejects.toThrow('duplicate')
  await expect(f.job.admit({ ...f.admission, approvals: [...f.admission.approvals, ...f.admission.approvals] })).rejects.toThrow('duplicate')
  await expect(f.job.admit({ ...f.admission, inputs: [{ ...f.admission.inputs[0], bytes: 16 }] })).rejects.toThrow('staged input changed')
  await expect(f.job.admit({ ...f.admission, inputs: [{ ...f.admission.inputs[0], path: join(f.root, 'outside') }] }))
    .rejects.toThrow('escapes')
  await expect(createEpisodeDeliveryJob({ ...f.options, projectDir: 'relative' })).rejects.toThrow('Invalid')
  await expect(createEpisodeDeliveryJob({ ...f.options, recordBytes: 0 })).rejects.toThrow('Invalid')
})

it.skipIf(process.platform === 'win32')('rejects file links and linked private directories without reading their targets', async () => {
  const f = await fixture(), alias = join(f.job.attemptRoot, 'alias.json')
  await symlink(f.input, alias)
  await expect(readEpisodeRecord(alias, 16384)).rejects.toThrow('bounded regular file')
  await expect(f.job.admit({ ...f.admission, inputs: [{ ...f.admission.inputs[0], path: alias }] })).rejects.toThrow('regular file')
  const another = join(f.root, 'another'); await mkdir(another); await symlink(f.job.attemptRoot, join(another, '.muse'))
  await expect(createEpisodeDeliveryJob({ ...f.options, projectDir: another })).rejects.toThrow('canonical and regular')
})

it('rejects an already aborted factory and records that exceed the deployment budget', async () => {
  const f = await fixture(), control = new AbortController(); control.abort(new Error('stopped'))
  await expect(createEpisodeDeliveryJob({ ...f.options, signal: control.signal })).rejects.toThrow('stopped')
  const small = await createEpisodeDeliveryJob({ ...f.options, recordBytes: 16 })
  await expect(small.admit(f.admission)).rejects.toThrow('exceeds its budget')
})

it('uses the supplied guardian lifetime for a committed admission and later cancelled reads', async () => {
  const f = await fixture(), control = new AbortController()
  const job = await createEpisodeDeliveryJob({ ...f.options, signal: control.signal })
  expect((await job.admit(f.admission)).executionRef).toBeNull()
  control.abort(new Error('guardian cancelled'))
  await expect(job.admit(f.admission)).rejects.toThrow('guardian cancelled')
  expect((await job.read())?.executionRef).toBeNull()
})

it('refuses foreign physical descriptors at both admission and durable replay', async () => {
  const f = await fixture(); await f.job.admit(f.admission)
  const execution = await f.execution()
  await expect(f.job.admitExecution({ ...execution, identity: { ...execution.identity, attempt: identityAttempt() } }))
    .rejects.toThrow('another attempt')
  const path = join(f.job.attemptRoot, `admitted-${execution.identity.execution}.json`)
  await writeFile(path, JSON.stringify({ ...execution, identity: { ...execution.identity, execution: f.identity.execution } }))
  await expect(f.job.readExecution(execution.identity.execution)).rejects.toThrow('identity changed')
  await expect(createEpisodeDeliveryJob({ ...f.options, projectDir: f.input })).rejects.toThrow('regular directory')
})

function identityAttempt() {
  return executionIdentitySchema.parse({ attempt: randomUUID(), execution: randomUUID(), rendererGeneration: randomUUID(),
    planSha256: hash('p'), projectSha256: hash('j'), configurationSha256: hash('c'), descriptorSha256: hash('d') }).attempt
}

it('refuses unowned running records and orphan historical drain evidence', async () => {
  const f = await fixture(); await f.job.admit(f.admission)
  const execution = await f.execution(), path = join(f.job.attemptRoot, 'execution.json')
  await writeFile(path, JSON.stringify(f.running(execution)))
  await expect(f.job.assertAdmission(execution.identity)).rejects.toThrow('unowned running')
  await unlink(path)
  await writeFile(join(f.job.attemptRoot, `drained-${execution.identity.execution}.json`), JSON.stringify({ version: 1,
    kind: 'drained', identity: execution.identity, guardianPid: process.pid, commands: 1, result: 'failed' }))
  await expect(f.job.assertAdmission(execution.identity)).rejects.toThrow('historical evidence')
})

it('propagates real journal and candidate path errors instead of interpreting them as absence', async () => {
  const f = await fixture(); await f.job.admit(f.admission)
  await expect(readEpisodeRecord(join(f.input, 'nested.json'), 16384)).rejects.toThrow()
  const execution = await f.execution(), stage = dirname(execution.candidatePath)
  await rm(stage, { recursive: true }); await writeFile(stage, 'not a directory')
  await expect(f.job.assertAdmission(execution.identity)).rejects.toThrow()
})

it.each(['journal', 'input'] as const)('refuses a real %s replacement between lstat and open', async (kind) => {
  const f = await fixture(), target = kind === 'journal' ? join(f.root, 'record.json') : f.input
  if (kind === 'journal') await writeFile(target, '{}')
  const open = files.open
  const spy = vi.spyOn(files, 'open').mockImplementation(async (...args) => {
    if (args[0] === target) {
      await files.rename(target, target + '.old'); await writeFile(target, kind === 'journal' ? '{}' : 'approved source')
    }
    return open(...args)
  })
  onTestFinished(() => { spy.mockRestore() })
  await expect(kind === 'journal' ? readEpisodeRecord(target, 16384) : f.job.admit(f.admission)).rejects.toThrow('changed while opening')
})

it.each(['journal', 'input'] as const)('refuses a real %s mutation between reading and final descriptor stat', async (kind) => {
  const f = await fixture(), target = kind === 'journal' ? join(f.root, 'record.json') : f.input
  if (kind === 'journal') await writeFile(target, '{}')
  const open = files.open
  const spy = vi.spyOn(files, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (args[0] === target) {
      const stat = handle.stat.bind(handle)
      let calls = 0
      Object.defineProperty(handle, 'stat', { value: async () => {
        if (++calls === 2) await writeFile(target, 'changed to a different size')
        return stat()
      } })
    }
    return handle
  })
  onTestFinished(() => { spy.mockRestore() })
  await expect(kind === 'journal' ? readEpisodeRecord(target, 16384) : f.job.admit(f.admission)).rejects.toThrow('changed')
})
