/** Explicit local Skill resources collected for a creator-reviewed publication. */
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { stringify } from 'yaml'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
import type { MarketLimits } from './types.ts'
import { MarketError, marketPath } from './package.ts'

/** Collect only selected Skill directories, rejecting links and sensitive paths.
 * @param skills Explicitly selected, resolved local Skills.
 * @param limits Publication resource limits.
 * @returns Portable archive entries with complete instruction frontmatter.
 */
export async function collectMarketSkills(skills: readonly SkillDefinition[], limits: MarketLimits): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {}
  let total = 0
  const add = (path: string, bytes: Uint8Array): void => {
    total += bytes.byteLength
    if (!marketPath(path)) throw new MarketError('invalid-path')
    if (Object.keys(files).length + 2 > limits.fileCount || total > limits.expandedBytes) throw new MarketError('expanded-limit', 413)
    files[path] = bytes
  }
  for (const skill of skills) {
    const base = skill.resourceBase
    if (base && base.kind !== 'directory') throw new MarketError('non-local-skill')
    if (base?.kind === 'directory') {
      if (!isAbsolute(base.path)) throw new MarketError('invalid-path')
      const visit = async (directory: string, relative: string): Promise<void> => {
        if ((await lstat(directory)).isSymbolicLink()) throw new MarketError('linked-resource')
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = `${relative}${entry.name}`
          if (!marketPath(path)) throw new MarketError('invalid-path')
          const native = join(directory, entry.name), metadata = await lstat(native)
          if (metadata.isSymbolicLink()) throw new MarketError('linked-resource')
          if (metadata.isDirectory()) await visit(native, `${path}/`)
          else {
            if (!metadata.isFile() || metadata.size > limits.expandedBytes - total) throw new MarketError('expanded-limit', 413)
            if (path !== 'SKILL.md') add(`skills/${skill.name}/${path}`, await readFile(native))
          }
        }
      }
      await visit(base.path, '')
    }
    const frontmatter = stringify({ name: skill.name, description: skill.description,
      'disable-model-invocation': !skill.invocation.modelInvocable, 'user-invocable': skill.invocation.userInvocable })
    add(`skills/${skill.name}/SKILL.md`, Buffer.from(`---\n${frontmatter}---\n${skill.content}`))
  }
  return files
}
