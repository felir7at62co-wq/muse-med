/** Metadata-only pages over one Session's complete, invocation-filtered Skill directory. */
import { createHash } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Transparent continuation facts; Session identity remains visible to normal log readers. */
export interface SkillCatalogCursor {
  readonly version: 1
  readonly sessionId: SessionId
  readonly digest: string
  readonly query: string
  readonly offset: number
}

/** Search input; the owning tool validates JSON and resolves the default page size. */
export interface SkillCatalogRequest {
  readonly query?: string
  readonly cursor?: SkillCatalogCursor
  readonly limit?: number
}

/** One instruction-free entry from the currently permitted model directory. */
export interface SkillCatalogDirectoryEntry {
  readonly name: string
  readonly description: string
  readonly source: string
  readonly whenToUse?: string
}

/** A successful page always comes from complete discovery; pagination is separate. */
export interface SkillCatalogPage {
  readonly entries: readonly SkillCatalogDirectoryEntry[]
  readonly totalMatched: number
  readonly catalogComplete: true
  readonly nextCursor?: SkillCatalogCursor
}

/** Expected directory refusal with a stable code available to pure presenters. */
export class SkillCatalogError extends HarnessError {
  /** @param code - Stable, non-sensitive reason for refusing a metadata query. */
  constructor(code: 'SKILL_CATALOG_INCOMPLETE' | 'SKILL_CATALOG_STALE_CURSOR' | 'SKILL_CATALOG_FOREIGN_CURSOR' | 'SKILL_CATALOG_INVALID_REQUEST') {
    super(code, code)
  }
}

function normalized(value: string): string { return value.normalize('NFKC').replaceAll(/\s+/gu, ' ').trim().toLowerCase() }

function resolveRequest(input: SkillCatalogRequest, defaultPageSize: number) {
  const query = normalized(input.query ?? input.cursor?.query ?? '')
  const cursor = input.cursor, limit = input.limit ?? defaultPageSize
  if (query.length > 1024 || (input.query?.length ?? 0) > 1024 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || cursor !== undefined && (!/^[a-f0-9]{64}$/u.test(cursor.digest) || !Number.isSafeInteger(cursor.offset)
      || cursor.offset < 0 || cursor.query.length > 1024 || normalized(cursor.query) !== cursor.query)) {
    throw new SkillCatalogError('SKILL_CATALOG_INVALID_REQUEST')
  }
  return { query, cursor, limit }
}

/** Query a complete directory without loading any instructions or changing permissions.
 * @param sessionId - Exact requesting Session.
 * @param skills - Current complete model-invocable summaries, in stable registry order.
 * @param input - Validated query and transparent continuation fields.
 * @param defaultPageSize - Resolved validated deployment page size.
 * @returns One metadata page and a Session-bound continuation when more matches remain.
 */
export function pageSkillCatalog(
  sessionId: SessionId, skills: readonly SkillSummary[], input: SkillCatalogRequest, defaultPageSize: number,
): SkillCatalogPage {
  const { query, cursor, limit } = resolveRequest(input, defaultPageSize)
  const digest = createHash('sha256').update(JSON.stringify(skills.map(skill => [skill.name, skill.description,
    skill.whenToUse ?? null, skill.source, skill.invocation.modelInvocable, skill.invocation.userInvocable]))).digest('hex')
  if (cursor !== undefined) {
    if (cursor.sessionId !== sessionId) throw new SkillCatalogError('SKILL_CATALOG_FOREIGN_CURSOR')
    if (cursor.digest !== digest || cursor.query !== query) throw new SkillCatalogError('SKILL_CATALOG_STALE_CURSOR')
  }
  const matches = skills.filter(skill => normalized(`${skill.name} ${skill.description} ${skill.whenToUse ?? ''}`).includes(query))
  const offset = cursor?.offset ?? 0
  if (offset > matches.length) throw new SkillCatalogError('SKILL_CATALOG_STALE_CURSOR')
  const end = Math.min(matches.length, offset + limit)
  return {
    entries: matches.slice(offset, end).map(skill => ({ name: skill.name, description: skill.description,
      source: skill.source, ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }) })),
    totalMatched: matches.length, catalogComplete: true,
    ...(end < matches.length ? { nextCursor: { version: 1 as const, sessionId, digest, query, offset: end } } : {}),
  }
}
