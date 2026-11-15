/** Validation of Skill-only publication JSON and instruction frontmatter. */
import { parseDocument } from 'yaml'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
import { MarketError, marketRecord, marketText } from './format-values.ts'
export { MarketError, marketRecord, marketPath, marketMetadata, marketManifest } from './format-values.ts'

function invocationBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    if (['true', 'yes', 'on'].includes(value.toLowerCase())) return true
    if (['false', 'no', 'off'].includes(value.toLowerCase())) return false
  }
  throw new MarketError('invalid-skill')
}

/** Read instructions with the filesystem provider's current metadata and invocation semantics.
 * @param body - Complete UTF-8 SKILL.md.
 * @param expected - Declared invocation name.
 * @returns The body and metadata, without evaluating YAML tags.
 */
export function marketSkill(body: string, expected: string): Pick<SkillDefinition, 'description' | 'content' | 'invocation' | 'whenToUse' | 'metadata'> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(body)
  const header = match?.[1], content = match?.[2]
  if (header === undefined || content === undefined || !content.trim()) throw new MarketError('invalid-skill')
  const document = parseDocument(header)
  if (document.errors.length || document.warnings.length) throw new MarketError('invalid-skill')
  const data: unknown = document.toJSON()
  if (!marketRecord(data) || data.name !== expected || !marketText(data.description, 2000)
    || ['disableModelInvocation', 'modelInvocable', 'userInvocable'].some(key => Object.hasOwn(data, key))) throw new MarketError('invalid-skill')
  return { description: data.description, content: content.trim(),
    invocation: { modelInvocable: invocationBoolean(data['disable-model-invocation']) !== true,
      userInvocable: invocationBoolean(data['user-invocable']) !== false },
    ...(typeof data.whenToUse === 'string' ? { whenToUse: data.whenToUse } : {}),
    ...(marketRecord(data.metadata) ? { metadata: data.metadata } : {}) }
}
