/** Stored task records keep their human-input anchors, and routing projections keep only declared report fields. */
import { expect, it } from 'vitest'
import { coordinationDomain, latest, reportTask } from '../src/ledger.ts'

const schema = coordinationDomain.tables.tasks.valueSchema

const ordinary = {
  revision: 1, key: 'episode-two', requestHash: 'a'.repeat(64), instructions: 'Revise episode two only.', reason: 'Owner asked.',
  sourceSeq: 3, messageId: 'message-1', briefId: 'brief-1', forwardedIds: ['message-1'], sessionId: 'worker-1',
  createSession: true, cwd: '/worker', sourceCwd: '/main', videoKey: null, status: 'running', report: null, issue: null,
  noticeId: 'notice-1', notifiedStatus: null,
}

const reconciliation = {
  ...ordinary, revision: 2, key: 'check-episode-two', forwardedIds: [], status: 'reconciling',
  reconciliation: { throughSeq: 9, humanSeq: 3, humanMessageId: 'message-1' },
}

function record(...attempts: object[]) {
  return { id: 'task-1', owner: 'main-1', title: 'Deliver episode two', createdAt: 1, attempts }
}

function issues(value: object): string[] {
  const result = schema.safeParse(value)
  return result.success ? [] : result.error.issues.map(issue => issue.message)
}

it('accepts a forwarded assignment followed by a reconciliation anchored to its human input', () => {
  expect(issues(record(ordinary, reconciliation))).toEqual([])
})

it.each([
  ['without forwarded human input', { ...ordinary, forwardedIds: [] }],
  ['marked as reconciling', { ...ordinary, status: 'reconciling' }],
])('rejects a stored ordinary assignment %s', (_label, attempt) => {
  expect(issues(record(attempt))).toEqual(['Ordinary assignments require forwarded human input'])
})

it.each([
  ['anchors another human message', { ...reconciliation, reconciliation: { ...reconciliation.reconciliation, humanMessageId: 'message-2' } }],
  ['anchors input after its recorded worker position', { ...reconciliation, reconciliation: { ...reconciliation.reconciliation, humanSeq: 10 } }],
  ['forwards human input again', { ...reconciliation, forwardedIds: ['message-1'] }],
])('rejects a stored reconciliation that %s', (_label, attempt) => {
  expect(issues(record(ordinary, attempt))).toEqual(['Reconciliation must retain its existing human input anchor without forwarding it'])
})

it('fails loudly when a task has no assignment revision', () => {
  const task = schema.parse(record(ordinary))
  expect(() => latest({ ...task, attempts: [] })).toThrow('Task has no assignment revisions')
})

it('keeps a report file description only when the worker declared one', () => {
  const task = schema.parse(record({ ...ordinary, status: 'completed', report: {
    outcome: 'completed', summary: 'Delivered', throughSeq: 8,
    files: [{ path: '/worker/described.md', description: 'Episode two' }, { path: '/worker/plain.md' }],
  } }))
  expect(reportTask(task).report?.files).toStrictEqual([
    { path: '/worker/described.md', description: 'Episode two' },
    { path: '/worker/plain.md' },
  ])
})
