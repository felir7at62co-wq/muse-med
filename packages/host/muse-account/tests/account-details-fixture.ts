/** Content-free gateway response shared by account transport tests. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MuseAccountFullDetails, MuseAccountId, MuseAccountGroupId, MuseAccountUsageId, MuseFeishuDepartmentId } from '../src/types.ts'

/**
 * Build one independent, browser-safe profile and usage response.
 * @returns A verified account with an assigned group and one reported model request.
 */
export function accountDetailsFixture(): MuseAccountFullDetails {
  const at = '2026-11-17T00:00:00.000Z'
  const counts = { requests: 1, reportedRequests: 1, inputTokens: 12, outputTokens: 4, totalTokens: 16,
    cachedInputTokens: 2, reasoningTokens: 1 }
  return {
    account: { id: brandString<MuseAccountId>('0123456789abcdef'), username: 'writer', createdAt: at,
      lastLoginAt: at, lastActivityAt: null,
      feishuIdentities: [{ name: 'Author', tenantKey: 'tenant', boundAt: at, lastLoginAt: at,
        organization: { status: 'available', syncedAt: at, departments: [{
          id: brandString<MuseFeishuDepartmentId>('department'), name: 'Writing', path: 'Muse / Writing',
          pathIds: [brandString<MuseFeishuDepartmentId>('root')],
        }] } }],
    },
    groups: [{ id: brandString<MuseAccountGroupId>('group-0123456789abcdef'), name: 'Editors', description: 'Editorial team' }],
    usage: { since: at, updatedAt: at, tracking: 'gateway-and-desktop', summary: counts,
      byModel: [{ provider: 'muse-direct', model: 'sample-model', ...counts }], byDay: [{ date: '2026-11-17', ...counts }],
      pagination: { offset: 0, limit: 50, total: 1, hasMore: false },
      recent: [{ id: brandString<MuseAccountUsageId>('58ba3b25-132c-4397-8b40-2545ba74f9cb'), at,
        provider: 'muse-direct', model: 'sample-model', status: 200, source: 'desktop-direct',
        inputTokens: 12, outputTokens: 4, totalTokens: 16, cachedInputTokens: 2, reasoningTokens: 1 }],
    },
  }
}
