/** Browser-safe Skill publication metadata and portable-path validation. */
import { isSkillName } from '@deepseek-ai/dsh-skill/name'
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

/** Validate a bounded nonempty publication label.
 * @param value - Untrusted JSON field.
 * @param limit - Maximum UTF-16 code-unit length.
 * @returns Whether the value is a nonempty bounded string.
 */
export function marketText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit
}

function strings(value: unknown, count: number, length: number): value is string[] {
  return Array.isArray(value) && value.length <= count && value.every(item => marketText(item, length))
}

/** Parse author metadata at JSON and durable-record reads.
 * @param value - Author-supplied fields.
 * @returns Validated publication information.
 */
export function marketMetadata(value: unknown): MarketMetadata {
  if (marketRecord(value) && (value.plugins !== undefined || value.kind !== undefined && value.kind !== 'skill')) throw new MarketError('skill-only')
  if (!marketRecord(value) || !marketText(value.name, 64) || !isSkillName(value.name)
    || !marketText(value.title, 100) || !marketText(value.description, 2000)
    || !marketText(value.version, 80) || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(value.version)
    || !marketText(value.license, 2000) || !marketText(value.category, 60)
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
