import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as ImageOffload from '@deepseek-ai/dsh-compaction-image-offload'
import { LlmAdapter, createUserMessage, type ContentBlock, type ImageBlock, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { installFrameImageState, offloadFrameImages } from '../src/frame-images.ts'

class IdleModel extends LlmAdapter {
  override async resolveModel(provider: string, id: string) { return { provider, id, name: id, inputModalities: ['text', 'image'] as const } }
  async *stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
}

const image: ImageBlock = {
  type: 'image',
  attachment: { attachmentId: `sha256:${'b'.repeat(64)}` as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
}
const offloadedImage: ImageBlock = { ...image, offloaded: true }
const label = (text: string): ContentBlock => ({ type: 'text', text })

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
  await ctx.plugin(ImageOffload).await()
  ctx.llm.registerAdapter(['synthetic'], new IdleModel())
  await mountAgentLoopTestHarness(ctx)
  const read = await installFrameImageState(ctx)
  const { agent } = await ctx.agents.create({ sessionId: SessionId('frames'), agentOptions: { provider: 'synthetic', model: 'vision' } })
  const session: Session = agent.session
  const send = (content: ContentBlock[]) =>
    session.append('user/message', createUserMessage({ content, source: { kind: 'user' } }), { surfaceOp: 'append' })
  return { ctx, read, session, send }
}

describe('retained frame image occurrences', () => {
  it('requires the session projection service before recording anything', async () => {
    const empty = new Context()
    contexts.push(empty)
    await expect(installFrameImageState(empty)).rejects.toThrow('requires sessionProjections')
  })

  it('records only labelled images that are not yet offloaded, counting every image position', async () => {
    const h = await harness()
    const event = h.send([image, label('VIDEO_FRAME r1/F1 evidence'), offloadedImage, image, label('plain text'), image])
    expect(h.read(h.session)).toEqual({ 'r1/F1': [{ seq: event.seq, index: 2 }, { seq: event.seq, index: 3 }] })
  })

  it('keeps labels the offload decision does not select and drops fully selected labels', async () => {
    const h = await harness()
    const first = h.send([label('VIDEO_FRAME r1/F1 a'), image, label('VIDEO_FRAME r1/F2 b'), image])
    h.session.append('image/offload', { targets: [{ seq: first.seq, imageIndexes: [1] }] })
    expect(h.read(h.session)).toEqual({ 'r1/F1': [{ seq: first.seq, index: 0 }] })
  })

  it('leaves the retained occurrences untouched when an offload decision selects none of them', async () => {
    const h = await harness()
    const first = h.send([image, label('VIDEO_FRAME r1/F1 a'), image])
    const before = h.read(h.session)
    h.session.append('image/offload', { targets: [{ seq: first.seq, imageIndexes: [0] }] })
    expect(h.read(h.session)).toBe(before)
    expect(before).toEqual({ 'r1/F1': [{ seq: first.seq, index: 1 }] })
  })

  it('logs nothing when no retained occurrence is selected', async () => {
    const h = await harness()
    h.send([label('VIDEO_FRAME r1/F1 a'), image])
    expect(offloadFrameImages(h.session, h.read, () => false)).toBe(0)
    expect(h.session.snapshotEvents().filter(event => event.type === 'image/offload')).toEqual([])
  })

  it('logs one offload decision with sorted image indexes per selected event and reports their count', async () => {
    const h = await harness()
    const earlier = h.send([label('VIDEO_FRAME r1/F2 a'), image])
    const later = h.send([label('VIDEO_FRAME r1/F1 b'), image, label('VIDEO_FRAME r1/F2 c'), image])
    expect(offloadFrameImages(h.session, h.read, (_name, seq) => seq === later.seq)).toBe(2)
    expect(h.session.snapshotEvents().filter(event => event.type === 'image/offload').map(event => event.data))
      .toEqual([{ targets: [{ seq: later.seq, imageIndexes: [0, 1] }] }])
    expect(h.read(h.session)).toEqual({ 'r1/F2': [{ seq: earlier.seq, index: 0 }] })
  })
})
