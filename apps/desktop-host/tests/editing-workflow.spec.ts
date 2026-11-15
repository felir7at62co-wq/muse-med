import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Skills from '@deepseek-ai/dsh-skill'
import * as Files from '@deepseek-ai/dsh-skill-filesystem'
import { expect, it } from 'vitest'

it('keeps supported creative and media skills discoverable without retired workflow skills', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Skills)
    await ctx.plugin(Files, { includeDefaultRoots: false, bundledSkillDir: fileURLToPath(new URL('../skills/', import.meta.url)), watch: false })
    const names = (await ctx.skills.list()).map(skill => skill.name)
    for (const name of ['audio-transcribe', 'screenplay-format', 'novel-to-script', 'muse-dialogue-polish',
      'muse-script-doctor', 'muse-episode-design', 'video-review', 'video-to-screenplay']) {
      expect(names).toContain(name)
      expect(await ctx.skills.get(name)).toBeDefined()
    }
    for (const name of ['muse-script-editing', 'muse-creation', 'transcript-to-script', 'trope-adaptation', 'reviewing-micro-drama-scripts']) {
      expect(names).not.toContain(name)
      expect(await ctx.skills.get(name)).toBeUndefined()
    }
  } finally { await ctx.fiber.dispose() }
})
