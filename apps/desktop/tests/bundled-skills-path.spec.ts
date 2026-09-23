import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { bundledSkillDirectory } from '../../desktop-host/src/bundled-skills.ts'

it('exports external-process-readable skills paths without falling back to ASAR', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-skills-path-'))
  const suffix = ['node_modules', '@deepseek-ai', 'dsh-drama-skills', 'skills']
  try {
    for (const directory of ['development', 'app.asar.unpacked', 'my-app.asar-copy']) {
      const runtime = join(root, directory, 'dsh')
      const skills = join(runtime, ...suffix)
      await mkdir(skills, { recursive: true })
      expect(bundledSkillDirectory(runtime)).toBe(skills)
    }
    const archivedRuntime = join(root, 'app.asar', 'dsh')
    expect(bundledSkillDirectory(archivedRuntime)).toBe(join(root, 'app.asar.unpacked', 'dsh', ...suffix))
    await rm(join(root, 'app.asar.unpacked'), { recursive: true })
    await mkdir(join(archivedRuntime, ...suffix), { recursive: true })
    expect(() => bundledSkillDirectory(archivedRuntime)).toThrow('bundled skills are missing')
    expect(() => bundledSkillDirectory(join(root, 'missing'))).toThrow('bundled skills are missing')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
