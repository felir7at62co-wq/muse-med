import { expect, it } from 'vitest'
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { attentionSoundForEvent } from '../src/attention-sound.ts'

const root = {}
const child = { origin: 'subagent' as const, parentSession: SessionId('parent') }

it('signals a completed root turn and an ask_user_question call once each', () => {
  const complete: SessionEvent<'turn/end'> = {
    type: 'turn/end', seq: SessionSeq(2), time: 2,
    data: { turn: 1, reason: { kind: 'completed' } },
  }
  const ask: SessionEvent<'tool/call'> = {
    type: 'tool/call', seq: SessionSeq(1), time: 1,
    data: { turn: 1, step: 1, callId: 'ask-1' as SessionEvent<'tool/call'>['data']['callId'], name: 'ask_user_question', arguments: '{}' },
  }
  expect(attentionSoundForEvent(root, ask)).toBe('question')
  expect(attentionSoundForEvent(root, complete)).toBe('complete')
  expect(attentionSoundForEvent(child, ask)).toBeUndefined()
  expect(attentionSoundForEvent(child, complete)).toBeUndefined()
})

it('keeps interrupted turns and other tools quiet', () => {
  const end: SessionEvent<'turn/end'> = {
    type: 'turn/end', seq: SessionSeq(2), time: 2,
    data: { turn: 1, reason: { kind: 'interrupted' } },
  }
  const call: SessionEvent<'tool/call'> = {
    type: 'tool/call', seq: SessionSeq(1), time: 1,
    data: { turn: 1, step: 1, callId: 'other-1' as SessionEvent<'tool/call'>['data']['callId'], name: 'skill', arguments: '{}' },
  }
  expect(attentionSoundForEvent(root, end)).toBeUndefined()
  expect(attentionSoundForEvent(root, call)).toBeUndefined()
})
