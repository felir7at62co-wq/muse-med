/** Validated identity and relay-only measurements from account-data-v1 gateways. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { readMuseAccountJson } from './account-details.ts'
import { MuseGatewayError } from './gateway.ts'
import type { MuseAccountDetailsRequest, MuseAccountId, MuseAccountRelayDetails, MuseAccountRelayUsage, MuseAccountUsageId } from './types.ts'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const instant = z.iso.datetime()
const optionalText = z.string().max(256).nullable().optional().transform(value => value ?? null)
const optionalStatus = z.number().int().min(100).max(599).nullable().optional().transform(value => value ?? null)
const tokens = z.object({
  prompt_tokens: count.optional(), completion_tokens: count.optional(), total_tokens: count.optional(),
  input_tokens: count.optional(), output_tokens: count.optional(), prompt_cache_hit_tokens: count.optional(),
  prompt_cache_miss_tokens: count.optional(), reasoning_tokens: count.optional(),
  prompt_tokens_details: z.object({ cached_tokens: count.optional(), audio_tokens: count.optional() }).optional(),
  completion_tokens_details: z.object({ reasoning_tokens: count.optional(), audio_tokens: count.optional(),
    accepted_prediction_tokens: count.optional(), rejected_prediction_tokens: count.optional() }).optional(),
  input_tokens_details: z.object({ cached_tokens: count.optional(), audio_tokens: count.optional() }).optional(),
  output_tokens_details: z.object({ reasoning_tokens: count.optional(), audio_tokens: count.optional() }).optional(),
})
const identitySchema = z.object({ version: z.literal(1),
  accountId: z.string().regex(/^[a-f0-9]{16}$/u).transform(value => brandString<MuseAccountId>(value)),
  username: z.string().min(1).max(200),
})
const rangeSchema = z.object({ from: z.iso.date(), to: z.iso.date() }).refine(value => value.from <= value.to)
const usageSchema = z.object({
  version: z.literal(1), coverage: z.object({ transport: z.literal('relay-only'), direct: z.literal('unobserved') }),
  from: z.iso.date(), to: z.iso.date(),
  summary: z.object({ requests: count, completedRequests: count, failedRequests: count, pendingRequests: count,
    unknownRequests: count, reportedUsageRequests: count, partialUsageRequests: count, unreportedUsageRequests: count,
    inputTokens: count.nullable(), outputTokens: count.nullable(), totalTokens: count.nullable() }),
  items: z.array(z.object({
    requestId: z.uuid().transform(value => brandString<MuseAccountUsageId>(value)), startedAt: instant,
    finishedAt: instant.nullable(), channel: z.enum(['cloud-relay', 'desktop-relay']), route: optionalText,
    state: z.enum(['completed', 'failed', 'pending', 'unknown']), usageStatus: z.enum(['reported', 'partial', 'unreported']),
    usage: tokens.nullable(), requestedModel: optionalText, forwardedModel: optionalText, responseModel: optionalText,
    upstreamStatus: optionalStatus, clientStatus: optionalStatus,
    errorKind: z.enum(['request_rejected', 'upstream_http', 'invalid_content_type', 'transport', 'cancelled'])
      .nullable().optional().transform(value => value ?? null),
  })).max(100),
  nextCursor: z.string().min(1).max(4096).regex(/^[A-Za-z0-9_-]+$/u).nullable(),
  health: z.object({ state: z.enum(['ok', 'degraded']) }),
}).refine(value => value.from <= value.to)

/**
 * Resolve a relay-only UTC range, retaining an explicit successful range across cursor pages.
 * @param request - Current-account range and page; all-history is unavailable on this protocol.
 * @returns Only the personal usage API's supported query parameters.
 */
export function museAccountRelayQuery(request: MuseAccountDetailsRequest): URLSearchParams {
  if (request.period === 'all') throw new MuseGatewayError('unsupported-period')
  if ((request.offset ?? 0) > 0 && request.cursor === undefined) throw new MuseGatewayError('gateway-rejected')
  const range = request.range === undefined ? undefined : rangeSchema.safeParse(request.range)
  if (range !== undefined && !range.success) throw new MuseGatewayError('gateway-rejected')
  const to = range?.data.to ?? new Date().toISOString().slice(0, 10)
  const days = request.period === 'today' ? 1 : request.period === '7d' ? 7 : 30
  const from = range?.data.from ?? new Date(Date.parse(to) - (days - 1) * 86_400_000).toISOString().slice(0, 10)
  const query = new URLSearchParams({ from, to, limit: String(request.limit ?? 50) })
  if (request.cursor !== undefined) query.set('cursor', request.cursor)
  return query
}

/**
 * Read the authenticated user's stable identifier without retaining gateway roles or private fields.
 * @param response - Successful personal identity response.
 * @returns Only the verified account identifier and username.
 */
export async function readMuseAccountRelayIdentity(response: Response): Promise<MuseAccountRelayDetails['account']> {
  const value = await readMuseAccountJson(response)
  try {
    const identity = identitySchema.parse(value)
    return { id: identity.accountId, username: identity.username }
  } catch (_error) { throw new MuseGatewayError('gateway-rejected') }
}

/**
 * Read one personal relay ledger page without inventing absent supplier counters or aggregates.
 * @param response - Successful account-data-v1 usage response.
 * @returns Full-range summary and one cursor page, excluding unrecognized gateway fields.
 */
export async function readMuseAccountRelayUsage(response: Response): Promise<MuseAccountRelayUsage> {
  const value = await readMuseAccountJson(response)
  try { return usageSchema.parse(value) }
  catch (_error) { throw new MuseGatewayError('gateway-rejected') }
}
