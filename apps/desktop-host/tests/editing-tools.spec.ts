import { Context } from '@deepseek-ai/cordis'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { expect, it } from 'vitest'
import * as EditingTools from '../src/editing-tools.ts'

it('hides Host video tools when editing mounts before their provider', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(Tools)
    const editingKey = {}
    let editing!: Scope
    await ctx.plugin(Object.assign((inner: Context) => { editing = createScope(inner, editingKey) },
      { inject: ['tools', 'systemPrompt'] }))

    await editing.ctx.plugin(EditingTools)
    ctx.tools.register(defineContentToolFixture({
      name: 'jubian_storyboard', description: 'Host video tool', parameters: {},
      execute: async () => [{ type: 'text', text: 'video' }],
    }))

    expect(ctx.tools.schemas(editingKey).map(tool => tool.name)).not.toContain('jubian_storyboard')
    expect(ctx.tools.schemas().map(tool => tool.name)).toContain('jubian_storyboard')
  } finally {
    await ctx.fiber.dispose()
  }
})
