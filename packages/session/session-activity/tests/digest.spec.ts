/** Digest text, bounds and wake decisions for watched-Session totals. */
import { describe, expect, it } from 'vitest'
import { activityLine, formatTokens, renderDigest, wakeReasons } from '../src/digest.ts'
import type { DigestEntry } from '../src/digest.ts'
import { initialActivity } from '../src/projection.ts'
import type { SessionActivityState } from '../src/projection.ts'

const options = { wakeTools: ['ask_user_question'], maxLines: 8, maxChars: 1200 }

function state(overrides: Partial<SessionActivityState>): SessionActivityState {
  return { ...initialActivity(), ...overrides }
}

function entry(label: string, current: SessionActivityState, delivered: SessionActivityState | null = null,
  stalledMs?: number): DigestEntry {
  return { label, sessionId: `session-${label}`, state: current, delivered, stalledMs }
}

const busy = state({
  seq: 40, openTurn: 3, images: 8, errors: 1,
  lastError: { seq: 30, time: 1, text: 'coordinator_report: No current assignment' },
  tools: {
    bash: { calls: 35, errors: 0, lastSeq: 39, lastArguments: '{}' },
    video_inspect: { calls: 2, errors: 0, lastSeq: 10, lastArguments: '{}' },
    read: { calls: 2, errors: 0, lastSeq: 11, lastArguments: '{}' },
    glob: { calls: 2, errors: 0, lastSeq: 12, lastArguments: '{}' },
    write: { calls: 1, errors: 0, lastSeq: 13, lastArguments: '{}' },
  },
  files: { '/w/ep001.md': 20, 'C:\\w\\ep002.md': 21, '/w/a.md': 1, '/w/b.md': 2, '/w/c.md': 3 },
  jobs: { running: 2, completed: 12, failed: 1 },
  inputTokens: 2_100_000, outputTokens: 30_000, contextTokens: 21_000,
})

describe('activity digest', () => {
  it('renders one compact line of running totals', () => {
    expect(activityLine(entry('ep001', busy))).toBe('- ep001 [session-ep001] running turn 3 · tools bash 35, glob 2, read 2, video_inspect 2 +1 more'
      + ' · images 8 · delivered ep002.md, ep001.md, c.md, b.md +1 more · jobs 2 running/12 done/1 failed'
      + ' · errors 1 (last: coordinator_report: No current assignment) · context 21k tokens, input total 2.1M')
    expect(activityLine(entry('idle', state({ turns: 2, errors: 1 })))).toBe('- idle [session-idle] idle after 2 turns · errors 1')
    expect(activityLine(entry('one', state({ files: { 'b.md': 3, 'a.md': 3 } })))).toBe('- one [session-one] idle after 0 turns · delivered a.md, b.md')
    expect([formatTokens(950), formatTokens(21_400), formatTokens(2_140_000)]).toEqual(['950', '21k', '2.1M'])
  })

  it('wakes only for new questions, failed turns and stalls', () => {
    const asked = state({ seq: 50, tools: { ask_user_question: { calls: 1, errors: 0, lastSeq: 50, lastArguments: '{"question":"Which cut?"}' } } })
    expect(wakeReasons(entry('ep1', asked, null), options)).toEqual(['ep1 called ask_user_question: {"question":"Which cut?"}'])
    expect(wakeReasons(entry('ep1', asked, asked), options)).toEqual([])
    expect(wakeReasons({ ...entry('ep1', asked, null), notified: asked }, options)).toEqual([])
    const failed = state({ seq: 60, lastTurnEnd: { seq: 60, kind: 'error', text: 'model failed' } })
    expect(wakeReasons(entry('ep1', failed, asked), options)).toEqual(['ep1 turn failed: model failed'])
    const finished = state({ seq: 61, lastTurnEnd: { seq: 61, kind: 'completed', text: '' } })
    expect(wakeReasons(entry('ep1', finished), options)).toEqual([])
    expect(wakeReasons(entry('ep1', finished, finished, 720_000), options)).toEqual(['ep1 has had no new activity for 12 min while running'])
    expect(wakeReasons(entry('ep1', state({ tools: {} })), { wakeTools: ['constructor'] })).toEqual([])
  })

  it('renders only changed Sessions within line and character bounds', () => {
    const quiet = state({ seq: 1 })
    expect(renderDigest([entry('quiet', quiet, quiet), entry('new', initialActivity())], options)).toBeUndefined()
    const progressed = renderDigest([entry('quiet', quiet, quiet), entry('ep1', busy), entry('ep2', busy), entry('ep3', busy)], { ...options, maxLines: 2 })
    expect(progressed).toEqual({
      wake: false, summary: '3 Session(s) progressed',
      text: ['Activity of the Sessions you dispatched (running totals; read a Session for details):',
        activityLine(entry('ep1', busy)), activityLine(entry('ep2', busy)), '- 1 more Sessions changed.'].join('\n'),
    })
    const stalled = renderDigest([entry('quiet', quiet, quiet, 600_000)], { ...options, maxChars: 200 })
    expect(stalled?.wake).toBe(true)
    expect(stalled?.summary).toBe('1 activity item(s) need attention')
    expect(stalled?.text).toHaveLength(200)
    expect(stalled?.text.endsWith('…')).toBe(true)
  })
})
