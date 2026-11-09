/** Validation of Skill-only publication JSON and instruction frontmatter. */
import { parseDocument } from 'yaml'
import { isSkillName, type SkillDefinition } from '@deepseek-ai/dsh-skill'
import type { MarketManifest, MarketMetadata } from './types.ts'

/** A publication refusal with a stable, credential-free diagnostic code. */
export class MarketError extends Error {
  constructor(readonly code: string) { super(code) }
}

/** Identify a JSON object without accepting arrays or null.
 * @param value - Parsed input.
 * @returns Whether fields can be inspected.
 */
export function marketRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate a portable archive path, excluding links to private configuration.
 * @param value - Untrusted relative path.
 * @returns Whether the name is safe on POSIX and Windows.
 */
export function marketPath(value: string): boolean {
  return value.length > 0 && value.length <= 240 && !/[\\:<>"|?*\x00-\x1f]/u.test(value)
    && value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..'
      && !/[. ]$/u.test(part) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(part)
      && !/^\.env(?:\.|$)|^\.git$|^node_modules$|\.(?:pem|key)$/iu.test(part))
}

function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit
}

function strings(value: unknown, count: number, length: number): value is string[] {
  return Array.isArray(value) && value.length <= count && value.every(item => text(item, length))
}

/** Parse author metadata at JSON and durable-record reads.
 * @param value - Author-supplied fields.
 * @returns Validated publication information.
 */
export function marketMetadata(value: unknown): MarketMetadata {
  if (marketRecord(value) && (value.plugins !== undefined || value.kind !== undefined && value.kind !== 'skill')) throw new MarketError('skill-only')
  if (!marketRecord(value) || !text(value.name, 64) || !isSkillName(value.name)
    || !text(value.title, 100) || !text(value.description, 2000)
    || !text(value.version, 80) || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(value.version)
    || !text(value.license, 2000) || !text(value.category, 60)
    || !strings(value.examples, 8, 1000) || !strings(value.requirements, 20, 300)) throw new MarketError('invalid-manifest')
  return { name: value.name, title: value.title, description: value.description, version: value.version,
    license: value.license, category: value.category, examples: value.examples, requirements: value.requirements }
}

/** Parse a Skill-only manifest; Bot and plugin payloads are not admitted.
 * @param value - Untrusted archive or record JSON.
 * @returns The supported immutable manifest.
 */
export function marketManifest(value: unknown): MarketManifest {
  const metadata = marketMetadata(value)
  if (!marketRecord(value) || value.formatVersion !== 1 || value.kind !== 'skill' || value.plugins !== undefined
    || !Array.isArray(value.skills) || value.skills.length !== 1) throw new MarketError('skill-only')
  const skill: unknown = value.skills[0]
  if (!marketRecord(skill) || typeof skill.name !== 'string' || !isSkillName(skill.name)
    || skill.path !== `skills/${skill.name}/SKILL.md` || !marketPath(skill.path)) throw new MarketError('invalid-manifest')
  return { ...metadata, formatVersion: 1, kind: 'skill', skills: [{ name: skill.name, path: skill.path }] }
}

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
  if (!marketRecord(data) || data.name !== expected || !text(data.description, 2000)
    || ['disableModelInvocation', 'modelInvocable', 'userInvocable'].some(key => Object.hasOwn(data, key))) throw new MarketError('invalid-skill')
  return { description: data.description, content: content.trim(),
    invocation: { modelInvocable: invocationBoolean(data['disable-model-invocation']) !== true,
      userInvocable: invocationBoolean(data['user-invocable']) !== false },
    ...(typeof data.whenToUse === 'string' ? { whenToUse: data.whenToUse } : {}),
    ...(marketRecord(data.metadata) ? { metadata: data.metadata } : {}) }
}
