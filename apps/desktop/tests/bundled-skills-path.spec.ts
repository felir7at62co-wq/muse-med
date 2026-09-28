import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import * as skillPaths from '../../desktop-host/src/bundled-skills.ts'

const { bundledSkillDirectory } = skillPaths

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

it('exports product skill scripts on the native filesystem outside ASAR', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-product-skills-path-'))
  const suffix = ['dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host']
  const productSkillDirectory = Reflect.get(skillPaths, 'productSkillDirectory')
  try {
    expect(productSkillDirectory).toBeTypeOf('function')
    if (typeof productSkillDirectory !== 'function') return
    for (const directory of ['development', 'app.asar.unpacked', 'my-app.asar-copy']) {
      const productPackage = join(root, directory, ...suffix)
      const skills = join(productPackage, 'skills')
      await mkdir(skills, { recursive: true })
      expect(productSkillDirectory(productPackage)).toBe(skills)
    }
    const archivedPackage = join(root, 'app.asar', ...suffix)
    expect(productSkillDirectory(archivedPackage)).toBe(join(root, 'app.asar.unpacked', ...suffix, 'skills'))
    await rm(join(root, 'app.asar.unpacked'), { recursive: true })
    await mkdir(join(archivedPackage, 'skills'), { recursive: true })
    expect(() => productSkillDirectory(archivedPackage)).toThrow('product skills are missing')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
