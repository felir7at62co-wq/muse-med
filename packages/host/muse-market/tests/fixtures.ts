/** Owned local publication inputs shared by the package's behavior tests. */
import { mkdtemp, realpath, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
import type { MarketLimits, MarketManifest, MarketMetadata } from '../src/types.ts'

export const limits: MarketLimits = { archiveBytes: 1024 * 1024, expandedBytes: 2 * 1024 * 1024, fileCount: 64, recordBytes: 1024 * 1024 }
export const metadata: MarketMetadata = { name: 'fixture-release', title: 'Fixture release', description: 'A local publication.',
  version: '1.0.0', license: 'MIT', category: 'writing', examples: ['Review a scene.'], requirements: [] }
export const instructions = '---\nname: fixture-skill\ndescription: Review a scene.\nwhenToUse: For local scene review.\nmetadata:\n  audience: writers\n  tags: [scene, 中文]\ndisable-model-invocation: yes\nuser-invocable: on\n---\nRead references/rules.txt before reviewing.\n'
export const manifest: MarketManifest = { ...metadata, formatVersion: 1, kind: 'skill',
  skills: [{ name: 'fixture-skill', path: 'skills/fixture-skill/SKILL.md' }] }
export const resources = { 'skills/fixture-skill/SKILL.md': Buffer.from(instructions),
  'skills/fixture-skill/references/rules.txt': Buffer.from('Keep the original scene.\n'),
  'skills/fixture-skill/assets/sample.bin': Uint8Array.from([0, 255, 1, 128]) }

export async function directory() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-market-owner-')))
  return { root, cleanup: async () => { await rm(root, { recursive: true, force: true }) } }
}

export async function bundle() {
  const fixture = await directory(), path = join(fixture.root, 'bundle')
  for (const [relative, bytes] of Object.entries(resources)) {
    const parts = relative.split('/').slice(2)
    const file = join(path, ...parts)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, bytes)
  }
  const skill: SkillDefinition = { name: 'fixture-skill', description: 'Review a scene.', whenToUse: 'For local scene review.',
    metadata: { audience: 'writers', tags: ['scene', '中文'] }, invocation: { modelInvocable: false, userInvocable: true },
    source: 'fixture', provider: 'fixture', path: join(path, 'SKILL.md'), resourceBase: { kind: 'directory', path },
    content: 'Read references/rules.txt before reviewing.' }
  return { ...fixture, path, skill }
}
