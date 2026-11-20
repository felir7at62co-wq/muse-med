/** Validate the account gateway's content-free profile and usage response. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MuseAccountFullDetails, MuseAccountGroupId, MuseAccountId, MuseAccountProfile, MuseAccountUsageId, MuseFeishuDepartmentId } from './types.ts'
import { MuseGatewayError } from './gateway.ts'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const instant = z.iso.datetime()
const departmentId = z.string().min(1).max(256).transform(value => brandString<MuseFeishuDepartmentId>(value))
const department = z.object({ id: departmentId, name: z.string().min(1).max(200) })
const counts = z.object({ requests: count, reportedRequests: count, inputTokens: count, outputTokens: count,
  totalTokens: count, cachedInputTokens: count, reasoningTokens: count })
const schema = z.object({
  account: z.object({
    id: z.string().regex(/^[a-f0-9]{16}$/u).transform(value => brandString<MuseAccountId>(value)),
    username: z.string().min(1).max(200), createdAt: instant, lastLoginAt: instant.nullable(), lastActivityAt: instant.nullable(),
    feishuIdentities: z.array(z.object({ name: z.string().min(1).max(200), tenantKey: z.string().max(256).nullable(),
      boundAt: instant, lastLoginAt: instant.nullable(),
      organization: z.object({ status: z.enum(['available', 'permission-required', 'unavailable']), syncedAt: instant,
        departments: z.array(department.extend({ path: z.string().max(20000), pathIds: z.array(departmentId).max(100) })).max(100),
      }).optional(),
    }).transform(({ organization, ...identity }) => ({ ...identity,
      ...(organization === undefined ? {} : { organization }),
    }))),
  }),
  groups: z.array(z.object({
    id: z.string().regex(/^group-[a-f0-9]{16}$/u).transform(value => brandString<MuseAccountGroupId>(value)),
    name: z.string().min(1).max(80), description: z.string().max(500),
  })).max(20),
  usage: z.object({
    since: instant, updatedAt: instant, tracking: z.literal('gateway-and-desktop'), summary: counts,
    byModel: z.array(counts.extend({ provider: z.string().max(64), model: z.string().max(200) })).max(10000),
    byDay: z.array(counts.extend({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u) })).max(100000),
    pagination: z.object({ offset: count, limit: count.min(1).max(100), total: count, hasMore: z.boolean() }),
    recent: z.array(z.object({
      id: z.uuid().transform(value => brandString<MuseAccountUsageId>(value)), at: instant,
      provider: z.string().max(64), model: z.string().max(200), status: z.number().int().min(100).max(599).nullable(),
      source: z.enum(['gateway-relay', 'desktop-direct']), inputTokens: count.nullable(), outputTokens: count.nullable(),
      totalTokens: count.nullable(), cachedInputTokens: count.nullable(), reasoningTokens: count.nullable(),
    })).max(100),
  }),
})
const profileSchema = schema.pick({ account: true, groups: true }).extend({
  version: z.literal(1),
  organization: z.object({ status: z.enum(['available', 'unavailable']), updatedAt: instant.nullable(),
    departments: z.array(department.extend({ path: z.string().max(20000), pathIds: z.array(departmentId).max(100) })),
    jobTitle: z.string().min(1).max(200).optional(), managerName: z.string().min(1).max(200).optional(),
  }).transform(organization => organization.departments.length > 100
    ? { ...organization, status: 'unavailable' as const, departments: [] } : organization),
})

/**
 * Read a bounded strict UTF-8 JSON response without retaining raw gateway diagnostics.
 * @param response - Successful content-free account gateway response.
 * @returns Untrusted JSON for the owning protocol validator.
 */
export async function readMuseAccountJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new MuseGatewayError('gateway-rejected')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      // Bound the complete response, including fields discarded by protocol projection.
      if (size > 4 * 1024 * 1024) throw new MuseGatewayError('gateway-rejected')
      chunks.push(chunk.value)
    }
  } catch (error) {
    try { await reader.cancel() }
    catch (_error) { /* Retain the bounded read failure if the connection already closed. */ }
    throw error instanceof MuseGatewayError ? error : new MuseGatewayError('gateway-unavailable')
  } finally { reader.releaseLock() }
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)))
    return value
  } catch (_error) { throw new MuseGatewayError('gateway-rejected') }
}

/**
 * Validate current-account profile, memberships and complete usage aggregates, discarding unrecognized fields.
 * @param response - Successful personal-details gateway response.
 * @returns Browser-safe profile and measurements without credentials or content.
 */
export async function readMuseAccountDetails(response: Response): Promise<MuseAccountFullDetails> {
  const value = await readMuseAccountJson(response)
  try { return schema.parse(value) }
  catch (_error) { throw new MuseGatewayError('gateway-rejected') }
}

/**
 * Validate a personal profile against the separately authenticated account identity.
 * @param response - Successful personal-profile response, bounded to 4 MiB.
 * @param account - Identity returned by the same gateway and saved session.
 * @returns Verified profile and memberships, excluding private and unrecognized fields.
 */
export async function readMuseAccountProfile(response: Response, account: Pick<MuseAccountProfile['account'], 'id' | 'username'>): Promise<MuseAccountProfile> {
  const value = await readMuseAccountJson(response)
  try {
    const profile = profileSchema.parse(value)
    if (profile.account.id !== account.id || profile.account.username !== account.username) throw new MuseGatewayError('gateway-rejected')
    return profile
  } catch (_error) { throw new MuseGatewayError('gateway-rejected') }
}
