import { Context } from '@deepseek-ai/cordis'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { expect, it } from 'vitest'
import * as EditingTools from '../src/editing-tools.ts'

it('keeps script-pool tools and hides video tools when editing mounts before their provider', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(Tools)
    const editingKey = {}
    let editing!: Scope
    await ctx.plugin(Object.assign((inner: Context) => { editing = createScope(inner, editingKey) },
      { inject: ['tools', 'systemPrompt'] }))

    await editing.ctx.plugin(EditingTools)
    const scriptPool = ['jubian_find', 'jubian_claim', 'jubian_snatch']
    const video = ['jubian_catalog', 'jubian_asset', 'jubian_organize', 'jubian_model',
      'jubian_storyboard', 'jubian_video', 'jubian_watch', 'jubian_media']
    for (const name of [...scriptPool, ...video]) {
      ctx.tools.register(defineContentToolFixture({
        name, description: 'Host Jubian tool', parameters: {},
        execute: async () => [{ type: 'text', text: name }],
      }))
    }

    const visible = ctx.tools.schemas(editingKey).map(tool => tool.name)
    for (const name of scriptPool) expect(visible).toContain(name)
    for (const name of video) expect(visible).not.toContain(name)
    for (const name of [...scriptPool, ...video]) expect(ctx.tools.schemas().map(tool => tool.name)).toContain(name)
  } finally {
    await ctx.fiber.dispose()
  }
})
