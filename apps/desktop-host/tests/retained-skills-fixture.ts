/** Isolated discovery of retained Skill instructions without enabling them in the product. */
import { cpSync, existsSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll } from 'vitest'

/**
 * Copy the retained instructions and references into a test-owned discovery root.
 * @returns Temporary bundled root removed after the owning test file finishes.
 */
export function retainedSkillsFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'muse-retained-skills-'))
  afterAll(() => { rmSync(root, { recursive: true, force: true }) })
  cpSync(fileURLToPath(new URL('../skills/', import.meta.url)), root, { recursive: true })
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const disabled = join(root, entry.name, 'SKILL.md.disabled')
    if (existsSync(disabled)) renameSync(disabled, join(root, entry.name, 'SKILL.md'))
  }
  return root
}
