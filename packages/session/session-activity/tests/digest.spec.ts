/** Status lines, digest bounds and wake decisions. */
import { describe, expect, it } from 'vitest'
import { renderDigest, statusKey, statusText, wakeReasons } from '../src/digest.ts'
import type { DigestEntry, SessionStatus } from '../src/digest.ts'

const options = { maxLines: 8, maxChars: 1200 }
const minute = 60_000

function status(overrides: Partial<SessionStatus>): SessionStatus {
  return { kind: 'idle', since: null, lastTool: null, activity: [], error: '', ...overrides }
}

function entry(label: string, current: SessionStatus, delivered: string | null = null,
  extra: Partial<DigestEntry> = {}): DigestEntry {
  return { label, sessionId: `session-${label}`, status: current, delivered, notified: null, ...extra }
}

const running = status({
  kind: 'running', since: 0,
  lastTool: { name: 'bash', time: 0, arguments: '{"command":"ffmpeg"}' },
  activity: [
    { kind: 'job', labels: ['ffmpeg -i ep001.mp4 -vf fps=2 frames/%04d.png && echo done', 'asr', 'cut', 'mux'] },
    { kind: 'schedule', labels: [] },
  ],
})

describe('status lines', () => {
  it('renders the state, its duration, the latest tool and running work', () => {
    const rest = ' · job: ffmpeg -i ep001.mp4 -vf fps=2 frames/%0…, asr, cut +1 more · schedule'
    expect(statusKey(running)).toBe(`running${rest}`)
    expect(statusKey({ ...running, lastTool: { name: 'read', time: 1, arguments: '{}' } })).toBe(statusKey(running))
    expect(statusText(running, 12 * minute + 5)).toBe(`running for 12 min · last tool bash${rest}`)
    expect(statusText(status({ since: 10 }), 20)).toBe('idle for under 1 min')
    expect(statusText(status({ kind: 'not-open' }), 0)).toBe('not open')
    expect(statusText(status({ kind: 'failed', since: 0, error: 'model down' }), 3 * minute)).toBe('last turn failed for 3 min · error: model down')
  })
})

describe('wake reasons', () => {
  it('wakes once for a question, an approval, a failed turn or a stall', () => {
    const asking = status({ kind: 'question', lastTool: { name: 'ask_user_question', time: 0, arguments: '{"question":"Which cut?"}' } })
    expect(wakeReasons(entry('ep1', asking)))
      .toEqual(['ep1 is waiting for an answer in its own chat (last call: ask_user_question {"question":"Which cut?"})'])
    expect(wakeReasons(entry('ep1', asking, null, { notified: 'question' }))).toEqual([])
    expect(wakeReasons(entry('ep1', status({ kind: 'approval' })))).toEqual(['ep1 is waiting for an approval in its own chat'])
    expect(wakeReasons(entry('ep1', status({ kind: 'failed', error: 'model down' })))).toEqual(['ep1 last turn failed: model down'])
    expect(wakeReasons(entry('ep1', running))).toEqual([])
    expect(wakeReasons(entry('ep1', running, null, { notified: 'running', stalledMs: 12 * minute })))
      .toEqual(['ep1 has shown no new activity for 12 min while running'])
  })
})

describe('digests', () => {
  it('renders only changed Sessions within line and character bounds', () => {
    const idle = status({})
    expect(renderDigest([entry('quiet', idle, statusKey(idle)), entry('new', status({ kind: 'not-open' })),
      entry('closed', status({ kind: 'not-open' }), statusKey(running))], options, 0)).toBeUndefined()
    const progressed = renderDigest([entry('ep1', running), entry('ep2', running), entry('ep3', running)], { ...options, maxLines: 2 }, minute)
    expect(progressed).toEqual({
      wake: false, summary: '3 Session status change(s)',
      text: ['Status of the Sessions you dispatched, as the session list shows it. These updates arrive by themselves when a state changes, '
      + 'so do not poll list_agents, job_list or coordinator_tasks for progress; wait for the closing notice or receipt rather than interrupting '
      + 'a Session that already reported. Read a Session only when you need details:',
        `- ep1 [session-ep1] ${statusText(running, minute)}`, `- ep2 [session-ep2] ${statusText(running, minute)}`,
        '- 1 more Sessions changed.'].join('\n'),
    })
    const stalled = renderDigest([entry('ep1', running, statusKey(running), { stalledMs: 10 * minute })], { ...options, maxChars: 200 }, 0)
    expect(stalled?.wake).toBe(true)
    expect(stalled?.summary).toBe('1 Session state(s) need attention')
    expect(stalled?.text).toHaveLength(200)
    expect(stalled?.text.endsWith('…')).toBe(true)
  })
})
