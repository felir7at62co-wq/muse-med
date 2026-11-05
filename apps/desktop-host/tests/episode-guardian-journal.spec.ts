/** Strict journal reads and exclusive normalized drain publication. */
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createGuardianJournal, guardianParsers } from '../src/episode-guardian-journal.ts'
import type { ExecutionDrain, ExecutionIdentity } from '../src/episode-guardian-fence.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) =>{  await rm(root, { recursive: true, force: true }) })) })
const identity = (): ExecutionIdentity => guardianParsers.parseRequest({ version: 1, kind: 'run', identity: {
  attempt: '00000000-0000-4000-8000-000000000001', execution: '00000000-0000-4000-8000-000000000003',
  rendererGeneration: '00000000-0000-4000-8000-000000000002', planSha256: 'a'.repeat(64),
  projectSha256: 'b'.repeat(64), configurationSha256: 'c'.repeat(64), descriptorSha256: 'd'.repeat(64),
} }).identity
async function fixture(recordBytes = 4096) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-guardian-journal-')); roots.push(root)
  const journal = createGuardianJournal({ attemptRoot: root, recordBytes, assertAdmission: async () => {}, armExecution: async () => {} })
  const proof: ExecutionDrain = { version: 1, kind: 'drained', identity: identity(), guardianPid: process.pid,
    commands: 1, result: 'completed', candidate: { outputSha256: identity().planSha256, outputBytes: 17 } }
  return { root, journal, proof, path: join(root, `drained-${proof.identity.execution}.json`) }
}

it('replays equivalent records regardless of object field insertion order', async () => {
  const f = await fixture()
  await f.journal.publishDrain(f.proof)
  const before = await readFile(f.path)
  const i = identity()
  const reverse: ExecutionIdentity = { descriptorSha256: i.descriptorSha256, configurationSha256: i.configurationSha256,
    projectSha256: i.projectSha256, planSha256: i.planSha256, rendererGeneration: i.rendererGeneration,
    execution: i.execution, attempt: i.attempt }
  if (f.proof.result !== 'completed') throw new Error('fixture proof is not completed')
  await f.journal.publishDrain({ candidate: { outputBytes: 17, outputSha256: i.planSha256 }, result: 'completed', commands: 1,
    guardianPid: process.pid, identity: reverse, kind: 'drained', version: 1 })
  expect(await readFile(f.path)).toEqual(before)
  expect(await f.journal.readDrain(i.execution)).toEqual(f.proof)
})

it.each(['pid', 'commands', 'result', 'output'] as const)('refuses conflicting %s without replacing existing bytes', async (field) => {
  const f = await fixture()
  await f.journal.publishDrain(f.proof)
  const before = await readFile(f.path)
  const conflict: ExecutionDrain = field === 'result' ? { version: 1, kind: 'drained', identity: identity(), guardianPid: process.pid, commands: 1, result: 'failed' }
    : field === 'pid' ? { ...f.proof, guardianPid: process.pid + 1 }
      : field === 'commands' ? { ...f.proof, commands: 2 }
        : { ...f.proof, result: 'completed', candidate: { outputSha256: identity().projectSha256, outputBytes: 17 } }
  await expect(f.journal.publishDrain(conflict)).rejects.toThrow('conflicting drain proof')
  expect(await readFile(f.path)).toEqual(before)
})

it('arms the job before an atomic running record becomes visible', async () => {
  const f = await fixture(); let armed = false
  const journal = createGuardianJournal({ attemptRoot: f.root, recordBytes: 4096, assertAdmission: async () => {},
    armExecution: async () => { expect(await f.journal.readRunning()).toBeUndefined(); armed = true } })
  const record = { version: 1, kind: 'running', identity: identity(), guardianPid: process.pid } as const
  await journal.writeRunning(record)
  expect(armed).toBe(true); expect(await journal.readRunning()).toEqual(record)
})

it('distinguishes absent from malformed, oversized and non-regular records', async () => {
  const f = await fixture()
  expect(await f.journal.readRunning()).toBeUndefined()
  expect(await f.journal.readDrain(identity().execution)).toBeUndefined()
  const path = join(f.root, 'execution.json')
  await writeFile(path, '{bad'); await expect(f.journal.readRunning()).rejects.toThrow()
  await writeFile(path, ' '.repeat(4097)); await expect(f.journal.readRunning()).rejects.toThrow('bounded regular file')
  await rm(path); await mkdir(path); await expect(f.journal.readRunning()).rejects.toThrow('bounded regular file')
  await rm(path, { recursive: true }); await symlink(join(f.root, 'absent'), path)
  await expect(f.journal.readRunning()).rejects.toThrow('bounded regular file')
})

it('refuses invalid strict JSON fields and bounds outgoing records before arming', async () => {
  const f = await fixture(100)
  await expect(f.journal.publishDrain(f.proof)).rejects.toThrow('exceeds limit')
  await expect(f.journal.writeRunning({ version: 1, kind: 'running', identity: identity(), guardianPid: process.pid })).rejects.toThrow('exceeds limit')
  expect(() => guardianParsers.parseRequest({ version: 1, kind: 'run', identity: { ...identity(), extra: true } })).toThrow()
  expect(() => guardianParsers.parseRequest({ version: 1, kind: 'run', identity: { ...identity(), execution: '../other' } })).toThrow()
  expect(() => guardianParsers.parseReply({ version: 1, kind: 'result', identity: identity(), result: { kind: 'unknown' } })).toThrow()
})
