import { mkdtemp, readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { JUBIAN_TOKEN_REF, JubianClient, JubianLedger, trimBearerToken } from '@deepseek-ai/dsh-jubian'
import { storyboardMethod, videoMethod } from '../src/methods.ts'

const enabled = process.env.DSH_JUBIAN_LIVE === '1'
const SCRIPT_ID = Number(process.env.DSH_JUBIAN_SCRIPT_ID ?? '2708')

/** The two fields a rejected submission can surface. */
interface EraseFailure {
  code?: string
  message: string
}

async function storedToken(): Promise<string> {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const doc = yaml.load(await readFile(join(home, '.credentials.yaml'), 'utf8')) as
    { refs?: Record<string, unknown> } | undefined
  const raw = doc?.refs?.[JUBIAN_TOKEN_REF]
  return typeof raw === 'string' ? trimBearerToken(raw) : ''
}

/**
 * Submit one real erasure with the regional eraser, then verify what the ledger
 * recorded and whether the state is readable back. This is the one path the
 * offline suite could not prove: that the pinned selectors are accepted by the
 * provider on a real submission.
 */
describe.skipIf(!enabled)('live erasure submission', () => {
  it('submits, records, and leaves a readable state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jubian-live-erase-'))
    const client = new JubianClient({ credential: storedToken, maxResponseBytes: 32 * 1024 * 1024 })
    const ledger = new JubianLedger({ root })

    const listed = await videoMethod(client, ledger, { method: 'tasks', script_id: SCRIPT_ID, page_num: 1 })
    const tasks = (listed.tasks as { rows: { task_id: number }[] }).rows
    expect(tasks[0]).toBeDefined()
    const taskId = tasks[0]!.task_id
    console.log('SUBMIT task =', taskId)

    const key = `live-erase-${String(Date.now())}`
    let outcome: Record<string, unknown> | null = null
    let failure: EraseFailure | null = null
    try {
      outcome = await storyboardMethod(client, ledger, { method: 'erase_subtitle',
        idempotency_key: key, task_id: taskId, script_id: SCRIPT_ID,
        model_id: 'quzimuToB', video_width: 720, video_height: 1280 })
    } catch (error) {
      failure = { code: (error as { code?: string }).code, message: (error as Error).message }
    }
    console.log('SUBMIT outcome =', JSON.stringify(outcome))
    console.log('SUBMIT failure =', JSON.stringify(failure))

    // Whatever happened, the ledger must say so — that is what lets an agent
    // leave a failed submission alone and do other work.
    const record = await ledger.find(key)
    console.log('LEDGER =', JSON.stringify({ at: record?.at, method: record?.method,
      http: record?.http_status, app: record?.application_code, outcome: record?.outcome,
      response_sha256: record?.response_sha256 }))

    expect(record).toBeDefined()
    expect(record?.method).toBe('erase_subtitle')
    // A submission is accepted or it is unknown; either way the caller has a record.
    expect(['accepted', 'unknown']).toContain(record?.outcome)

    // And the state stays readable while the task runs, so a later poll works.
    const after = await videoMethod(client, ledger, { method: 'subtasks', task_id: taskId,
      delivery_resolution: '1080p' })
    const rows = (after.subtasks as { rows: Record<string, unknown>[] }).rows
    console.log('AFTER rows =', JSON.stringify(rows.map(row => ({ sub: row.subtask_id,
      stage: row.last_stage, hd: row.hd_count, erased: row.subtitle_erased, res: row.resolution }))))
    expect(rows.length).toBeGreaterThan(0)
  }, 300000)

  it('records a failed submission so a caller can walk away and retry later', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jubian-live-fail-'))
    const client = new JubianClient({ credential: storedToken, maxResponseBytes: 32 * 1024 * 1024 })
    const ledger = new JubianLedger({ root })
    const key = `live-fail-${String(Date.now())}`

    // The automatic route costs nothing, and re-submitting an already-erased
    // source is the cheapest way to make the provider refuse one on purpose.
    let failure: EraseFailure | null = null
    let outcome: Record<string, unknown> | null = null
    try {
      outcome = await storyboardMethod(client, ledger, { method: 'erase_subtitle',
        idempotency_key: key, task_id: 428322, script_id: SCRIPT_ID,
        model_id: 'ark-erase-video-subtitle-pro', video_width: 720, video_height: 1280 })
    } catch (error) {
      failure = { code: (error as { code?: string }).code, message: (error as Error).message }
    }
    console.log('FAIL outcome =', JSON.stringify(outcome))
    console.log('FAIL thrown  =', JSON.stringify(failure))

    // Whatever the provider said, the attempt is on record: a caller that walks
    // away and retries with the same key gets this record instead of a resend.
    const record = await ledger.find(key)
    console.log('FAIL ledger =', JSON.stringify({ method: record?.method, http: record?.http_status,
      app: record?.application_code, outcome: record?.outcome, sha: record?.response_sha256 }))
    expect(record).toBeDefined()
    expect(record?.method).toBe('erase_subtitle')
    expect(['accepted', 'unknown']).toContain(record?.outcome)

    // The whole point: unrelated work is still possible right after a failure.
    const probe = await videoMethod(client, ledger, { method: 'task', task_id: 428322 })
    expect((probe.task as { task_id: number }).task_id).toBe(428322)
    console.log('FAIL unrelated read still works =', JSON.stringify(probe.task))
  }, 300000)
})
