import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, inject } from '../src/index.ts'

interface Registered { name: string; description: string }

async function mount(config: Record<string, unknown> = {}): Promise<Registered[]> {
  const ctx = new Context()
  const registered: Registered[] = []
  ctx.provide('tools', {
    register: (definition: { name: string; description: string }) => {
      registered.push({ name: definition.name, description: definition.description })
      return () => {}
    },
  })
  await ctx.plugin({ apply, inject, name: 'perception-bgm' }, config)
  return registered
}

describe('bgm_match registration', () => {
  it('registers exactly one tool named bgm_match', async () => {
    const registered = await mount()
    expect(registered.map(entry => entry.name)).toEqual(['bgm_match'])
  })

  it('states the non-commercial restriction in the text the model reads', async () => {
    const registered = await mount()
    expect(registered[0]?.description).toContain('非商业')
  })

  it('states that the result is candidates rather than a decision', async () => {
    const registered = await mount()
    expect(registered[0]?.description).toContain('候选')
  })

  it('explains that the scale is the model 1-9 and what the methods do', async () => {
    const registered = await mount()
    const text = registered[0]?.description ?? ''
    expect(text).toContain('1–9')
    expect(text).toContain('index')
    expect(text).toContain('match')
  })
})
