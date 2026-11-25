import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { existingSubmission, submitOnce } from '../src/submit-once.ts'

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const fs = await importOriginal()
  return { ...fs, writeFile: vi.fn(fs.writeFile) }
})

afterEach(() => { vi.mocked(writeFile).mockReset() })

const call = ['session-1', 'call-1']
const scope = ['account-1', 'film-1']

async function temporary() {
  const dir = await mkdtemp(join(tmpdir(), 'jingliu-submit-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function acknowledged() {
  const dir = await temporary()
  const send = vi.fn(async () => ({ id: 'job-1' }))
  await submitOnce(dir, call, scope, send)
  const name = (await readdir(dir)).find(file => file.endsWith('.json'))
  assert(name)
  return { dir, send, receipt: join(dir, name), marker: join(dir, name.slice(0, -'.json'.length)) }
}

it('refuses a concurrent retry while the original studio request is waiting and replays its finished receipt', async () => {
  const dir = await temporary()
  const started = Promise.withResolvers<undefined>()
  const response = Promise.withResolvers<{ id: string }>()
  const send = vi.fn(async () => ({ id: 'duplicate' })).mockImplementationOnce(() => {
    started.resolve(undefined)
    return response.promise
  })
  await expect(existingSubmission(dir, call, scope)).resolves.toBeUndefined()
  const first = submitOnce(dir, call, scope, send)
  try {
    await Promise.race([started.promise, first])
    await expect(submitOnce(dir, call, scope, send)).rejects.toMatchObject({ code: 'JINGLIU_JOB_OUTCOME_UNKNOWN' })
  } finally {
    response.resolve({ id: 'job-1' })
    await first
  }
  const expected = { job_id: 'job-1', job: { id: 'job-1' } }
  await expect(first).resolves.toEqual(expected)
  await expect(submitOnce(dir, call, scope, send)).resolves.toEqual(expected)
  expect(send).toHaveBeenCalledTimes(1)
})

it.each([
  { name: 'a non-object response', response: [] },
  { name: 'a numeric job ID', response: { id: 1 } },
  { name: 'an empty job ID', response: { id: '' } },
])('keeps the claim after the studio acknowledges with $name', async ({ response }) => {
  const dir = await temporary()
  const send = vi.fn(async () => response)
  await expect(submitOnce(dir, call, scope, send)).rejects.toMatchObject({ code: 'JINGLIU_JOB_OUTCOME_UNKNOWN' })
  await expect(submitOnce(dir, call, scope, send)).rejects.toMatchObject({ code: 'JINGLIU_JOB_OUTCOME_UNKNOWN' })
  expect(send).toHaveBeenCalledTimes(1)
})

it.each([
  { name: 'truncated JSON', contents: '{"job_id":' },
  { name: 'a receipt with no object fields', contents: '[]' },
  { name: 'a receipt with a numeric job ID', contents: '{"job_id":1}' },
  { name: 'a receipt with an empty job ID', contents: '{"job_id":""}' },
])('requires reconciliation after reading $name from a persisted receipt', async ({ contents }) => {
  const { dir, send, receipt } = await acknowledged()
  await writeFile(receipt, contents)
  await expect(submitOnce(dir, call, scope, send)).rejects.toMatchObject({ code: 'JINGLIU_JOB_OUTCOME_UNKNOWN' })
  expect(send).toHaveBeenCalledTimes(1)
})

it('does not reuse a receipt when the interrupted claim file is empty', async () => {
  const { dir, send, marker } = await acknowledged()
  await writeFile(marker, '')
  await expect(submitOnce(dir, call, scope, send)).rejects.toMatchObject({ code: 'JINGLIU_JOB_OUTCOME_UNKNOWN' })
  expect(send).toHaveBeenCalledTimes(1)
})

it.each(['marker', 'receipt'] as const)('reports a filesystem error when the %s cannot be read', async (file) => {
  const state = await acknowledged()
  await rm(state[file])
  await mkdir(state[file])
  await expect(existingSubmission(state.dir, call, scope)).rejects.toMatchObject({ code: 'EISDIR' })
})

it('surfaces failure to claim its local receipt before contacting the studio', async () => {
  const dir = await temporary()
  const send = vi.fn()
  const error = Object.assign(new Error('No space left on device'), { code: 'ENOSPC' })
  vi.mocked(writeFile).mockRejectedValueOnce(error)
  await expect(submitOnce(dir, call, scope, send)).rejects.toBe(error)
  expect(send).not.toHaveBeenCalled()
})

it('requires reconciliation when a competing claim disappears before it can be read', async () => {
  const dir = await temporary()
  const send = vi.fn()
  vi.mocked(writeFile).mockRejectedValueOnce(Object.assign(new Error('Claim already exists'), { code: 'EEXIST' }))
  await expect(submitOnce(dir, call, scope, send)).rejects.toMatchObject({ code: 'JINGLIU_JOB_OUTCOME_UNKNOWN' })
  expect(send).not.toHaveBeenCalled()
})
