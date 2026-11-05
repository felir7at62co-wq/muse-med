import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, unlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { collectMarketSkills } from '../src/author.ts'
import { marketSkill } from '../src/package.ts'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const limits = { archiveBytes: 1024 * 1024, expandedBytes: 1024 * 1024, fileCount: 32 }
async function directory() { const root = await mkdtemp(join(tmpdir(), 'market-author-')); roots.push(root); return root }
function skill(root: string): SkillDefinition { return { name: 'review', description: 'Review scripts', content: 'Review all scenes.',
  source: 'custom', provider: 'test', invocation: { modelInvocable: false, userInvocable: true }, resourceBase: { kind: 'directory', path: root } } }

it('collects complete selected resources and preserves Skill invocation policy', async () => {
  const root = await directory(), selected = join(root, 'selected'); await mkdir(join(selected, 'references'), { recursive: true })
  await writeFile(join(selected, 'SKILL.md'), 'old local frontmatter'); await writeFile(join(selected, 'references', 'guide.md'), 'guide')
  await writeFile(join(root, 'private.txt'), 'outside selection')
  const files = await collectMarketSkills([skill(selected)], limits)
  expect(Object.keys(files)).toEqual(['skills/review/references/guide.md', 'skills/review/SKILL.md'])
  expect(marketSkill(Buffer.from(files['skills/review/SKILL.md']!).toString(), 'review').invocation).toEqual({ modelInvocable: false, userInvocable: true })
})

it('rejects sensitive files, oversized resources and linked directories', async () => {
  const root = await directory(), selected = join(root, 'selected'); await mkdir(selected)
  await writeFile(join(selected, '.env'), 'private')
  await expect(collectMarketSkills([skill(selected)], limits)).rejects.toThrow('invalid-path')
  await rm(join(selected, '.env')); await writeFile(join(selected, 'large.txt'), 'x'.repeat(50))
  await expect(collectMarketSkills([skill(selected)], { ...limits, expandedBytes: 10 })).rejects.toThrow('expanded-limit')
  const target = join(root, 'target'); await mkdir(target)
  const linked = join(selected, 'linked'); await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    await expect(collectMarketSkills([skill(linked)], limits)).rejects.toThrow('linked-resource')
    await expect(collectMarketSkills([skill(selected)], limits)).rejects.toThrow('linked-resource')
  } finally { await unlink(linked) }
})

it('only collects portable local resources and counts synthesized Skill instructions', async () => {
  const { resourceBase: _base, ...definition } = skill('unused')
  const files = await collectMarketSkills([definition], limits)
  expect(Object.keys(files)).toEqual(['skills/review/SKILL.md'])
  await expect(collectMarketSkills([{ ...definition, name: '../escape' }], limits)).rejects.toThrow('invalid-path')
  await expect(collectMarketSkills([definition], { ...limits, fileCount: 1 })).rejects.toThrow('expanded-limit')
  await expect(collectMarketSkills([definition], { ...limits, expandedBytes: 1 })).rejects.toThrow('expanded-limit')
  await expect(collectMarketSkills([skill('relative')], limits)).rejects.toThrow('invalid-path')
  await expect(collectMarketSkills([{ ...definition, resourceBase: { kind: 'url', url: 'https://example.test' } }], limits))
    .rejects.toThrow('non-local-skill')
})
