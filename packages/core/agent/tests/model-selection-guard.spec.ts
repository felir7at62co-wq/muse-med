import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, onTestFinished } from 'vitest'
import { AgentModel, modelSelectionProjectionDefinition } from '../src/model-selection.ts'

const INITIAL = { provider: 'alpha', model: 'a0', reasoningEffort: ReasoningEffortId('high') }
async function harness() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const projection = await ctx.sessionProjections.register(modelSelectionProjectionDefinition)
  const session = ctx.sessions.create(SessionId('model-selection-guard'))
  const options = { ...INITIAL }
  const model = new AgentModel(() => projection.stateOf(session), session, options)
  const owner = new AbortController()
  return { model, session, options, owner }
}

describe('original model selection guard', () => {
  it('blocks route and explicit effort changes without logging or changing the selected model', async () => {
    const h = await harness()
    const guard = h.model.guard(INITIAL, h.owner.signal)
    for (const selection of [
      { ...INITIAL, provider: 'beta' },
      { ...INITIAL, model: 'b1' },
      { ...INITIAL, reasoningEffort: ReasoningEffortId('low') },
      { provider: INITIAL.provider, model: INITIAL.model },
    ]) expect(() => { h.model.select(selection) }).toThrow('guarded model')
    expect(h.session.snapshotEvents()).toEqual([])
    expect(h.model.current()).toEqual(INITIAL)
    guard.assertCurrent()
    expect(guard.signal.aborted).toBe(false)
    guard.release()
    guard.release()
    expect(guard.signal.aborted).toBe(true)
    h.model.select({ ...INITIAL, model: 'b1' })
    expect(h.model.current()?.model).toBe('b1')
  })

  it('allows recording an unchanged fallback and owns a detached expected value', async () => {
    const h = await harness()
    const expected = { ...INITIAL }
    const guard = h.model.guard(expected, h.owner.signal)
    expected.model = 'mutated'
    h.model.select(INITIAL)
    guard.assertCurrent()
    expect(h.session.snapshotEvents()).toHaveLength(1)
    expect(h.model.current()).toEqual(INITIAL)
  })

  it('releases immediately on owner cancellation and refuses a pre-cancelled owner', async () => {
    const h = await harness()
    const guard = h.model.guard(INITIAL, h.owner.signal)
    h.owner.abort()
    expect(guard.signal.aborted).toBe(true)
    expect(() => { guard.assertCurrent() }).toThrow()
    h.model.select({ ...INITIAL, model: 'b1' })
    expect(() => h.model.guard({ ...INITIAL, model: 'b1' }, h.owner.signal)).toThrow()
  })

  it('refuses a mismatch or a second owner without replacing the original guard', async () => {
    const h = await harness()
    expect(() => h.model.guard({ ...INITIAL, model: 'b1' }, h.owner.signal)).toThrow('does not match')
    const guard = h.model.guard(INITIAL, h.owner.signal)
    expect(() => h.model.guard(INITIAL, new AbortController().signal)).toThrow('already held')
    expect(guard.signal.aborted).toBe(false)
    guard.assertCurrent()
  })

  it('detects direct option changes and retains the newly selected value', async () => {
    const h = await harness()
    const guard = h.model.guard(INITIAL, h.owner.signal)
    h.options.model = 'outside-change'
    expect(() => { guard.assertCurrent() }).toThrow('guarded model changed')
    expect(guard.signal.aborted).toBe(true)
    expect(h.model.current()?.model).toBe('outside-change')
  })

  it('detects direct recorded changes at the next read and leaves that selection intact', async () => {
    const h = await harness()
    const guard = h.model.guard(INITIAL, h.owner.signal)
    h.session.append('model/selection', { ...INITIAL, model: 'recorded-change' })
    expect(() => h.model.current()).toThrow('guarded model changed')
    expect(guard.signal.aborted).toBe(true)
    expect(h.model.current()?.model).toBe('recorded-change')
  })
})
