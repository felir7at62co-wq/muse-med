/** Content-free account details shared by the UI's authenticated transport fixtures. */

import type { MuseAccountFullDetails as MuseAccountDetails, MuseFeishuDepartmentId } from '@deepseek-ai/dsh-muse-account/types'

/** Stable profile, hierarchy, assigned group and partial usage reports. */
export const ACCOUNT_DETAILS: MuseAccountDetails = {
  account: {
    id: '0123456789abcdef' as MuseAccountDetails['account']['id'], username: 'writer',
    createdAt: '2026-11-01T00:00:00.000Z', lastLoginAt: '2026-11-17T00:00:00.000Z', lastActivityAt: null,
    feishuIdentities: [{ name: '林编剧', tenantKey: 'tenant-studio', boundAt: '2026-11-01T00:00:00.000Z',
      lastLoginAt: '2026-11-17T00:00:00.000Z', organization: {
        status: 'available', syncedAt: '2026-11-17T00:00:00.000Z', departments: [{
          id: 'dep-story' as MuseFeishuDepartmentId,
          name: '编剧组', path: '星河工作室 / 内容部 / 编剧组', pathIds: [],
        }],
      } }],
  },
  groups: [{ id: 'group-0123456789abcdef' as MuseAccountDetails['groups'][number]['id'], name: '编剧团队', description: '负责短剧剧本创作' }],
  usage: {
    since: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-17T01:00:00.000Z', tracking: 'gateway-and-desktop',
    summary: { requests: 2, reportedRequests: 1, inputTokens: 1200, outputTokens: 300,
      totalTokens: 1500, cachedInputTokens: 400, reasoningTokens: 80 },
    byModel: [{ provider: 'deepseek', model: 'deepseek-chat', requests: 2, reportedRequests: 1,
      inputTokens: 1200, outputTokens: 300, totalTokens: 1500, cachedInputTokens: 400, reasoningTokens: 80 }],
    byDay: [{ date: '2026-11-17', requests: 2, reportedRequests: 1,
      inputTokens: 1200, outputTokens: 300, totalTokens: 1500, cachedInputTokens: 400, reasoningTokens: 80 }],
    pagination: { offset: 0, limit: 50, total: 2, hasMore: false },
    recent: [
      { id: '00000000-0000-4000-8000-000000000001' as MuseAccountDetails['usage']['recent'][number]['id'],
        at: '2026-11-17T00:30:00.000Z', provider: 'deepseek', model: 'deepseek-chat', status: 200, source: 'gateway-relay',
        inputTokens: 1200, outputTokens: 300, totalTokens: 1500, cachedInputTokens: 400, reasoningTokens: 80 },
      { id: '00000000-0000-4000-8000-000000000002' as MuseAccountDetails['usage']['recent'][number]['id'],
        at: '2026-11-17T00:15:00.000Z', provider: 'deepseek', model: 'deepseek-chat', status: null, source: 'desktop-direct',
        inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, reasoningTokens: null },
    ],
  },
}
