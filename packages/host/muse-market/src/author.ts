/** Capture one explicitly selected directory-bundle or virtual Skill for publication. */
import { lstat, readdir } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { stringify } from 'yaml'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
import { MarketError, marketPath, marketSkill } from './format.ts'
import { readMarketBytes } from './local.ts'
import type { MarketLimits } from './types.ts'

/** Capture all owned bundle resources, retaining original instruction bytes and metadata.
 * @param skill - Current registry-selected Skill definition.
 * @param limits - Resolved deployment bounds.
 * @returns Portable resource names and exact bytes, without scanning shared flat-Skill roots.
 */
export async function collectMarketSkill(skill: SkillDefinition, limits: MarketLimits): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {}
  let total = 0
  const add = (path: string, bytes: Uint8Array): void => {
    total += bytes.byteLength
    if (!marketPath(path)) throw new MarketError('invalid-path')
    if (Object.keys(files).length + 2 > limits.fileCount || total > limits.expandedBytes) throw new MarketError('expanded-limit')
    files[path] = bytes
  }
  const prefix = `skills/${skill.name}/`, base = skill.resourceBase
  if (base === undefined) {
    const metadata = { name: skill.name, description: skill.description,
      ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
      ...(skill.metadata === undefined ? {} : { metadata: skill.metadata }),
      'disable-model-invocation': !skill.invocation.modelInvocable, 'user-invocable': skill.invocation.userInvocable }
    add(prefix + 'SKILL.md', Buffer.from(`---\n${stringify(metadata)}---\n${skill.content}`))
  } else {
    if (base.kind !== 'directory' || !isAbsolute(base.path) || skill.path === undefined
      || resolve(skill.path) !== resolve(base.path, 'SKILL.md')) throw new MarketError('non-bundle-skill')
    const observed = new Map<string, BigIntStats>()
    const unchanged = async (directory: string, before: BigIntStats): Promise<void> => {
      const current = await lstat(directory, { bigint: true })
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino
        || current.mtimeNs !== before.mtimeNs || current.ctimeNs !== before.ctimeNs) throw new MarketError('changed-resource')
    }
    const visit = async (directory: string, relative: string): Promise<void> => {
      const info = await lstat(directory, { bigint: true })
      if (!info.isDirectory() || info.isSymbolicLink()) throw new MarketError('linked-resource')
      observed.set(directory, info)
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = relative + entry.name, native = join(directory, entry.name)
        if (!marketPath(path)) throw new MarketError('invalid-path')
        if (entry.isDirectory()) await visit(native, path + '/')
        else add(prefix + path, await readMarketBytes(native, limits.expandedBytes - total))
      }
      await unchanged(directory, info)
    }
    await visit(base.path, '')
    for (const [directory, before] of observed) await unchanged(directory, before)
  }
  const body = files[prefix + 'SKILL.md']
  if (body === undefined) throw new MarketError('missing-skill')
  const parsed = marketSkill(new TextDecoder('utf-8', { fatal: true }).decode(body), skill.name)
  const selected = { description: skill.description, content: skill.content.trim(), invocation: skill.invocation,
    ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
    ...(skill.metadata === undefined ? {} : { metadata: skill.metadata }) }
  if (!isDeepStrictEqual(parsed, selected)) throw new MarketError('changed-skill')
  return files
}
