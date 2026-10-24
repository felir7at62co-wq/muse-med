/** Exercise feedback services and additive domain-event payloads through both SDK projections. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export const name = 'snapshot-feedback-producer'
export const inject = ['commands', 'messageFeedback', 'sessionFeedback']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Composed runtime services.
 */
export function apply(ctx) {
  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    if (agent.session.header.parentSession !== undefined) return
    const messages = agent.session.deriveMessages()
    const message = messages.findLast(message => message.role === 'assistant')
    if (message === undefined) throw new Error('feedback snapshot requires an assistant message')
    const command = await ctx.commands.execute(agent, '/feedback The session needs a clearer explanation.', [], signal)
    if (command?.result.kind !== 'success') throw new Error('feedback command did not succeed')
    const recorded = await ctx.sessionFeedback.record({ sessionId: agent.id, category: 'other' })
    if (!recorded.ok) throw new Error(recorded.error.code)
    const target = { sessionId: agent.id, messageId: message.id }
    const created = await ctx.messageFeedback.put({ ...target, rating: 'negative', note: 'Explain the result.', category: 'task-result', ifVersion: null })
    if (!created.ok) throw new Error(created.error.code)
    const edited = await ctx.messageFeedback.put({ ...target, rating: 'positive', note: 'The explanation is clear now.', ifVersion: created.value.version })
    if (!edited.ok) throw new Error(edited.error.code)
    const deleted = await ctx.messageFeedback.delete({ ...target, ifVersion: edited.value.version })
    if (!deleted.ok) throw new Error(deleted.error.code)
    const frames = [
      { id: 'sdk-frame-1', time: 1, reasons: ['fixture'], exposed: false,
        observation: { visible: 'The woman stands at the closed door.', change: 'The door is closed.', uncertainty: '' } },
      { id: 'sdk-frame-2', time: 2, reasons: ['fixture'], exposed: false,
        observation: { visible: 'The woman holds the open door.', change: 'The door is open.', uncertainty: '' } },
    ]
    const path = join(agent.session.header.cwd, 'sdk-video.mp4')
    const review = { id: 'sdk-review-1', episode: 'SDK', path, source_version: 'fixture-source-version',
      duration: 3, scanned_until: 3, scan_complete: true, frames }
    agent.session.append('video/review', { kind: 'start', review })
    const event = { event_id: 'door-opening', frame_ids: frames.map(frame => frame.id), actor: 'woman',
      action: 'opens the door', object: 'door', before: 'closed', after: 'open', uncertainty: '',
      start_seconds: 1, end_seconds: 2,
      observation_digest: createHash('sha256').update(JSON.stringify(frames.map(frame => ({
        id: frame.id, time: frame.time, observation: frame.observation,
      })))).digest('hex') }
    const transcript = { path: join(agent.session.header.cwd, 'sdk-transcript.json'), version: 'fixture-transcript-version',
      sha256: createHash('sha256').update('fixture-transcript').digest('hex') }
    agent.session.append('video/review', { kind: 'update', path, id: review.id, frames: [], frame_count: frames.length,
      scanned_until: 3, scan_complete: true, event_groups: [event], transcript_reference: transcript })
    if (JSON.stringify(agent.session.deriveMessages()) !== JSON.stringify(messages)) {
      throw new Error('feedback or video progress changed model-visible messages')
    }
  })
}
