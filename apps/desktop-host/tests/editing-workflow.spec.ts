import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Skills from '@deepseek-ai/dsh-skill'
import * as Files from '@deepseek-ai/dsh-skill-filesystem'
import { expect, it } from 'vitest'

it('keeps technical media skills discoverable after retiring manuscript guidance', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Skills)
    await ctx.plugin(Files, { includeDefaultRoots: false, bundledSkillDir: fileURLToPath(new URL('../skills/', import.meta.url)), watch: false })
    const names = (await ctx.skills.list()).map(skill => skill.name)
    expect(names).toContain('audio-transcribe')
    for (const name of ['screenplay-format', 'muse-script-editing', 'muse-creation', 'novel-to-script',
      'transcript-to-script', 'trope-adaptation', 'muse-dialogue-polish', 'muse-script-doctor', 'muse-episode-design', 'reviewing-micro-drama-scripts']) {
      expect(names).not.toContain(name)
      expect(await ctx.skills.get(name)).toBeUndefined()
    }
  } finally { await ctx.fiber.dispose() }
})
