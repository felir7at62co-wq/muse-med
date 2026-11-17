/** Persisted report metadata is admitted only when every recorded field is well formed. */
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { recordedReport } from '../src/client/report-model.ts'

const delivery = { outcome: 'completed', summary: '已交付', files: [{ path: 'a.docx' }], throughSeq: 3 }
const task = { id: 'task-1', title: '第二集', revision: 1, sessionId: 'worker', cwd: '/worker', status: 'completed', issue: null, report: delivery }

function meta(overrides: Record<string, unknown>): unknown {
  return { museCoordinationReport: { version: 1, owner: 'main', total: 1, truncated: false, tasks: [{ ...task, ...overrides }] } }
}

it.each([
  ['an unknown outcome', { report: { ...delivery, outcome: 'done' } }],
  ['a non-string outcome', { report: { ...delivery, outcome: 1 } }],
  ['a non-string summary', { report: { ...delivery, summary: 5 } }],
  ['a non-array file list', { report: { ...delivery, files: 'a.docx' } }],
  ['a fractional sequence', { report: { ...delivery, throughSeq: 1.5 } }],
  ['a negative sequence', { report: { ...delivery, throughSeq: -1 } }],
  ['a report that is not an object', { report: 'done' }],
  ['a file with a non-string description', { report: { ...delivery, files: [{ path: 'a.docx', description: 7 }] } }],
  ['an issue that is neither text nor null', { issue: 4 }],
])('rejects a task with %s', (_label, overrides) => {
  expect(recordedReport(meta(overrides), SessionId('main'))).toBeNull()
})

it('keeps one entry per file path and the descriptions of described files', () => {
  const files = [{ path: 'a.docx', description: '候选稿' }, { path: 'a.docx' }, { path: 'b.docx' }]
  const receipt = recordedReport(meta({ report: { ...delivery, files }, issue: '稍后重试' }), SessionId('main'))
  expect(receipt?.tasks[0]?.report?.files).toEqual([{ path: 'a.docx', description: '候选稿' }, { path: 'b.docx' }])
  expect(receipt?.tasks[0]?.issue).toBe('稍后重试')
})
