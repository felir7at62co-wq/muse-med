// @vitest-environment jsdom
/** Relay-only account data retains global totals, unknown counts and opaque page cursors. */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { MuseAccountProfile, MuseAccountRelayDetails as RelayDetails } from '@deepseek-ai/dsh-muse-account/types'
import { MuseAccountDetails } from '../src/client/MuseAccountDetails.tsx'
import type { MuseAccountInjected, MuseAccountSectionProps } from '../src/client/MuseAccountSection.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { MuseAccountLocaleKey } from '../src/client/locales.ts'
import { ACCOUNT_DETAILS } from './account-details.fixture.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const RELAY: RelayDetails = {
  protocol: 'account-data-v1',
  account: { id: '0123456789abcdef' as RelayDetails['account']['id'], username: 'writer' },
  availability: { profile: 'unavailable', groups: 'unavailable', feishuOrganization: 'unavailable' },
  usage: {
    version: 1, coverage: { transport: 'relay-only', direct: 'unobserved' }, from: '2026-10-19', to: '2026-11-17',
    summary: { requests: 101, completedRequests: 98, failedRequests: 3, pendingRequests: 0, unknownRequests: 0,
      reportedUsageRequests: 98, partialUsageRequests: 0, unreportedUsageRequests: 3,
      inputTokens: 1_200_000, outputTokens: 18_000, totalTokens: 1_218_000 },
    health: { state: 'ok' }, nextCursor: 'opaque-next-cursor',
    items: [
      { requestId: 'request-one' as RelayDetails['usage']['items'][number]['requestId'],
        startedAt: '2026-11-16T08:30:03.036Z', finishedAt: '2026-11-16T08:30:04.000Z',
        channel: 'desktop-relay', route: 'deepseek-official', state: 'completed', usageStatus: 'reported',
        requestedModel: 'requested-model', forwardedModel: 'forwarded-model', responseModel: 'deepseek-flash',
        usage: { prompt_tokens: 12034, completion_tokens: 3838, total_tokens: 15872,
          prompt_cache_hit_tokens: 384, completion_tokens_details: { reasoning_tokens: 1457 } },
        upstreamStatus: 200, clientStatus: 200, errorKind: null },
      { requestId: 'request-two' as RelayDetails['usage']['items'][number]['requestId'],
        startedAt: '2026-11-16T08:29:00.000Z', finishedAt: null,
        channel: 'cloud-relay', route: null, state: 'failed', usageStatus: 'unreported',
        requestedModel: null, forwardedModel: null, responseModel: null, usage: null,
        upstreamStatus: null, clientStatus: 502, errorKind: 'transport' },
    ],
  },
}

const PROFILE: MuseAccountProfile = {
  version: 1,
  account: { ...ACCOUNT_DETAILS.account,
    feishuIdentities: ACCOUNT_DETAILS.account.feishuIdentities.map(({ organization: _organization, ...identity }) => identity) },
  groups: ACCOUNT_DETAILS.groups,
  organization: { status: 'available', updatedAt: '2026-11-17T01:00:00.000Z',
    departments: [{ id: 'dep-production' as MuseAccountProfile['organization']['departments'][number]['id'],
      name: '动画组', path: '星河工作室 / 制作部 / 动画组', pathIds: [] }] },
}

function copy(dictionary: typeof en): MuseAccountSectionProps['t'] {
  return ((key: MuseAccountLocaleKey, parameters?: Record<string, unknown>) => Object.entries(parameters ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), dictionary[key])) as MuseAccountSectionProps['t']
}

function mount(details: MuseAccountInjected['details'] = async () => ({ ok: true, value: RELAY }), dictionary = en) {
  const onInvalidSession = vi.fn()
  const page = render(<MuseAccountDetails details={details} t={copy(dictionary)} onInvalidSession={onInvalidSession} />)
  return { ...page, onInvalidSession }
}

it('shows the actual relay summary and request fields with explicit unavailable group and department states', async () => {
  mount(undefined, zh)
  await screen.findByText(zh.groupsNotProvided)
  expect(screen.getByText(zh.departmentsNotProvided)).toBeDefined()
  expect(screen.queryByText(zh.noGroups)).toBeNull()
  expect(screen.queryByText(zh.feishuDepartmentsEmpty)).toBeNull()
  expect(screen.getByText(zh.relayUsageScope)).toBeDefined()
  expect(screen.getByText('统计区间：2026-10-19 至 2026-11-17（含首尾日期，UTC）')).toBeDefined()
  expect(screen.queryByRole('option', { name: zh.periodAll })).toBeNull()
  expect(screen.queryByRole('table', { name: zh.usageByModel })).toBeNull()
  expect(screen.queryByRole('table', { name: zh.usageByDay })).toBeNull()
  const summary = document.querySelector('[data-muse-usage-summary]')!
  expect(summary.textContent).toContain('请求数101')
  expect(summary.textContent).toContain('总 Token1,218,000')
  expect(summary.textContent).toContain('未回报用量请求数3')
  const rows = within(screen.getByRole('table', { name: zh.usageRequests })).getAllByRole('row')
  expect(rows[1]?.textContent).toContain('deepseek-flashdeepseek-official已完成请求HTTP 200供应方已回报桌面中转')
  expect(rows[1]?.textContent).toContain('2026-11-16 08:30:03.036')
  expect(rows[1]?.textContent).toContain('12,0343,83815,8723841,457')
  expect(within(rows[2]!).getAllByRole('cell').filter(cell => cell.textContent === zh.notReported)).toHaveLength(8)
  expect(screen.getByText('第 1–2 条，共 101 条')).toBeDefined()
  const snapshot = {
    availability: [zh.profileNotProvided, zh.departmentsNotProvided, zh.groupsNotProvided].map(text => screen.getByText(text).textContent),
    scope: screen.getByText(zh.relayUsageScope).textContent,
    period: screen.getByText('统计区间：2026-10-19 至 2026-11-17（含首尾日期，UTC）').textContent,
    summary: Array.from(summary.children).map(item => ({ label: item.querySelector('dt')?.textContent, value: item.querySelector('dd')?.textContent })),
    rows: rows.map(row => Array.from(row.children).map(cell => cell.textContent)),
  }
  await expect(JSON.stringify(snapshot, null, 2) + '\n').toMatchFileSnapshot('./expected/relay-account-details.zh.json')
})

it('shows personal profile and account-level Feishu paths independently of the relay usage coverage', async () => {
  const value: RelayDetails = { ...RELAY, profile: PROFILE,
    availability: { profile: 'available', groups: 'available', feishuOrganization: 'available' } }
  mount(async () => ({ ok: true, value }), zh)
  await screen.findByText('星河工作室 / 制作部 / 动画组')
  const profile = screen.getByRole('region', { name: zh.profileTitle })
  expect(within(profile).getByText('writer')).toBeDefined()
  expect(within(profile).getByText('林编剧')).toBeDefined()
  expect(screen.getByText('编剧团队')).toBeDefined()
  expect(screen.queryByText(zh.feishuDepartmentsRelogin)).toBeNull()
  expect(screen.queryByText(zh.profileNotProvided)).toBeNull()
  expect(screen.queryByText(zh.groupsNotProvided)).toBeNull()
  expect(screen.queryByText(zh.departmentsNotProvided)).toBeNull()
  expect(screen.getByText(zh.relayUsageScope)).toBeDefined()
  expect(document.querySelector('[data-muse-usage-summary]')?.textContent).toContain('总 Token1,218,000')
  const groups = screen.getByRole('region', { name: zh.groupsTitle })
  const snapshot = {
    profile: Array.from(profile.querySelectorAll('dl > div')).map(item => ({
      label: item.querySelector('dt')?.textContent, value: item.querySelector('dd')?.textContent,
    })),
    identity: within(profile).getByText('林编剧').parentElement?.textContent,
    departmentPaths: within(profile).getByRole('list', { name: zh.feishuDepartments }).textContent,
    synchronized: within(profile).getByText('部门同步时间：2026/11/17 09:00:00').textContent,
    groups: within(groups).getByRole('list').textContent,
    usageScope: screen.getByText(zh.relayUsageScope).textContent,
  }
  await expect(JSON.stringify(snapshot, null, 2) + '\n').toMatchFileSnapshot('./expected/relay-account-profile.zh.json')
})

it('shows verified department paths while detailed profile and Muse groups remain unavailable', async () => {
  const value: RelayDetails = { ...RELAY, organization: PROFILE.organization,
    availability: { ...RELAY.availability, feishuOrganization: 'available' } }
  mount(async () => ({ ok: true, value }), zh)
  const path = await screen.findByText('星河工作室 / 制作部 / 动画组')
  expect(screen.getByText(zh.profileNotProvided)).toBeDefined()
  expect(screen.getByText(zh.groupsNotProvided)).toBeDefined()
  expect(screen.queryByText(zh.departmentsNotProvided)).toBeNull()
  expect(screen.queryByText(zh.noGroups)).toBeNull()
  expect(screen.queryByText(zh.feishuDepartmentsRelogin)).toBeNull()
  expect(screen.getByText('deepseek-flash')).toBeDefined()
  const snapshot = {
    profile: screen.getByText(zh.profileNotProvided).textContent,
    groups: screen.getByText(zh.groupsNotProvided).textContent,
    departmentPath: path.textContent,
    synchronized: screen.getByText('部门同步时间：2026/11/17 09:00:00').textContent,
    usageScope: screen.getByText(zh.relayUsageScope).textContent,
  }
  await expect(JSON.stringify(snapshot, null, 2) + '\n').toMatchFileSnapshot('./expected/relay-account-organization.zh.json')
})

it.each(['available', 'unavailable'] as const)('keeps Muse group availability independent from %s directory membership', async (status) => {
  const value: RelayDetails = { ...RELAY, organization: { status, updatedAt: null, departments: [] },
    availability: { ...RELAY.availability, feishuOrganization: status } }
  mount(async () => ({ ok: true, value }))
  await screen.findByText(status === 'available' ? en.feishuDepartmentsEmpty : en.feishuDepartmentsPending)
  expect(screen.getByText(en.groupsNotProvided)).toBeDefined()
  expect(screen.queryByText(en.noGroups)).toBeNull()
  expect(screen.queryByText(en.departmentsNotProvided)).toBeNull()
  expect(screen.queryByText(status === 'available' ? en.feishuDepartmentsPending : en.feishuDepartmentsEmpty)).toBeNull()
})

it('shows confirmed empty memberships without replacing real usage records', async () => {
  const value: RelayDetails = { ...RELAY,
    profile: { ...PROFILE, groups: [], organization: { ...PROFILE.organization, departments: [] } },
    availability: { profile: 'available', groups: 'available', feishuOrganization: 'available' } }
  mount(async () => ({ ok: true, value }))
  await screen.findByText(en.noGroups)
  expect(screen.getByText(en.feishuDepartmentsEmpty)).toBeDefined()
  expect(screen.queryByText(en.groupsNotProvided)).toBeNull()
  expect(screen.getByText('deepseek-flash')).toBeDefined()
})

it('keeps unavailable directory sync distinct from an empty department membership', async () => {
  const value: RelayDetails = { ...RELAY,
    profile: { ...PROFILE, organization: { status: 'unavailable', updatedAt: null, departments: [] } },
    availability: { profile: 'available', groups: 'available', feishuOrganization: 'unavailable' } }
  mount(async () => ({ ok: true, value }))
  await screen.findByText(en.feishuDepartmentsPending)
  expect(screen.queryByText(en.feishuDepartmentsEmpty)).toBeNull()
  expect(screen.queryByText(en.feishuDepartmentsRelogin)).toBeNull()
  expect(screen.queryByText('Departments synced: Not reported')).toBeNull()
  expect(screen.getByText('编剧团队')).toBeDefined()
  expect(screen.getByText('deepseek-flash')).toBeDefined()
})

it('uses an account-level department name when its formatted path is missing', async () => {
  const department = PROFILE.organization.departments[0]!
  const value: RelayDetails = { ...RELAY,
    profile: { ...PROFILE, organization: { ...PROFILE.organization, departments: [{ ...department, path: '' }] } },
    availability: { profile: 'available', groups: 'available', feishuOrganization: 'available' } }
  mount(async () => ({ ok: true, value }))
  await screen.findByText('动画组')
  expect(screen.queryByText('星河工作室 / 制作部 / 动画组')).toBeNull()
  expect(screen.getByText('deepseek-flash')).toBeDefined()
})

it('uses server cursors for forward and backward pages without changing global totals', async () => {
  const details = vi.fn<MuseAccountInjected['details']>(async request => ({ ok: true, value: {
    ...RELAY, usage: { ...RELAY.usage, items: request.cursor ? RELAY.usage.items.slice(1) : RELAY.usage.items,
      nextCursor: request.cursor ? null : 'opaque-next-cursor' },
  } }))
  mount(details)
  await screen.findByText(en.groupsNotProvided)
  expect(details).toHaveBeenLastCalledWith({ period: '30d', offset: 0, limit: 50 })
  fireEvent.click(screen.getByRole('button', { name: en.nextPage }))
  await screen.findByText('3–3 of 101')
  expect(details).toHaveBeenLastCalledWith({ period: '30d', offset: 2, limit: 50, cursor: 'opaque-next-cursor',
    range: { from: '2026-10-19', to: '2026-11-17' } })
  expect(document.querySelector('[data-muse-usage-summary]')?.textContent).toContain('Total tokens1,218,000')
  expect(screen.getByRole('button', { name: en.nextPage }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: en.previousPage }))
  await screen.findByText('1–2 of 101')
  expect(details).toHaveBeenLastCalledWith({ period: '30d', offset: 0, limit: 50,
    range: { from: '2026-10-19', to: '2026-11-17' } })
  fireEvent.click(screen.getByRole('button', { name: en.nextPage }))
  await screen.findByText('3–3 of 101')
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '7d' } })
  await waitFor(() => { expect(details).toHaveBeenLastCalledWith({ period: '7d', offset: 0, limit: 50 }) })
  expect(screen.getByRole('button', { name: en.previousPage }).hasAttribute('disabled')).toBe(true)
})

it('refreshes the current period from its first page instead of reusing an earlier UTC range or cursor', async () => {
  const details = vi.fn<MuseAccountInjected['details']>(async request => ({ ok: true, value: {
    ...RELAY, usage: { ...RELAY.usage, items: request.cursor ? RELAY.usage.items.slice(1) : RELAY.usage.items,
      nextCursor: request.cursor ? null : 'opaque-next-cursor' },
  } }))
  mount(details)
  await screen.findByText(en.groupsNotProvided)
  fireEvent.click(screen.getByRole('button', { name: en.nextPage }))
  await screen.findByText('3–3 of 101')
  fireEvent.click(screen.getByRole('button', { name: en.refreshUsage }))
  await screen.findByText('1–2 of 101')
  expect(details).toHaveBeenLastCalledWith({ period: '30d', offset: 0, limit: 50 })
  expect(screen.getByRole('button', { name: en.previousPage }).hasAttribute('disabled')).toBe(true)
})

it('keeps the displayed page and totals after a failed next page, then retries its same cursor', async () => {
  const details = vi.fn<MuseAccountInjected['details']>()
    .mockResolvedValueOnce({ ok: true, value: RELAY })
    .mockResolvedValueOnce({ ok: false, code: 'muse-account/gateway-unavailable' })
    .mockResolvedValueOnce({ ok: true, value: { ...RELAY, usage: { ...RELAY.usage, items: [], nextCursor: null } } })
  mount(details)
  await screen.findByText(en.groupsNotProvided)
  fireEvent.click(screen.getByRole('button', { name: en.nextPage }))
  await screen.findByText(en.detailsUnavailable)
  expect(screen.getByText('1–2 of 101')).toBeDefined()
  expect(screen.getByText('deepseek-flash')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: en.nextPage }))
  await screen.findByText(en.noUsage)
  expect(details.mock.calls[1]).toEqual(details.mock.calls[2])
})

it('keeps missing summary counts unknown and displays degraded usage separately from missing profiles', async () => {
  const value: RelayDetails = { ...RELAY, usage: { ...RELAY.usage,
    summary: { ...RELAY.usage.summary, inputTokens: null, outputTokens: null, totalTokens: null },
    health: { state: 'degraded' }, items: [], nextCursor: null } }
  mount(async () => ({ ok: true, value }))
  await screen.findByText(en.usageDegraded)
  const summary = document.querySelector('[data-muse-usage-summary]')!
  expect(within(summary as HTMLElement).getAllByText(en.notReported)).toHaveLength(3)
  expect(screen.getByText(en.groupsNotProvided)).toBeDefined()
  expect(screen.queryByText(en.noGroups)).toBeNull()
})

it('preserves supplier zeroes and missing totals while showing alternative model and token fields', async () => {
  const first = RELAY.usage.items[0]!
  const second = RELAY.usage.items[1]!
  const value: RelayDetails = { ...RELAY, usage: { ...RELAY.usage, nextCursor: null, items: [
    { ...first, responseModel: null, forwardedModel: 'resolved-model', state: 'pending', usageStatus: 'partial',
      upstreamStatus: null, clientStatus: null, usage: { input_tokens: 0, prompt_tokens: 999, output_tokens: 5,
        completion_tokens: 777, input_tokens_details: { cached_tokens: 0 }, prompt_tokens_details: { cached_tokens: 19 },
        reasoning_tokens: 0, completion_tokens_details: { reasoning_tokens: 7 } } },
    { ...second, requestedModel: 'requested-model', state: 'unknown', errorKind: null,
      usage: { prompt_tokens: 10, completion_tokens: 11, prompt_tokens_details: { cached_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 4 } } },
  ] } }
  mount(async () => ({ ok: true, value }))
  const table = await screen.findByRole('table', { name: en.usageRequests })
  const rows = within(table).getAllByRole('row')
  const cells = within(rows[1]!).getAllByRole('cell').map(cell => cell.textContent)
  expect(cells.slice(2, 8)).toEqual(['resolved-model', 'deepseek-official', en.pendingRequests, en.partialUsage, en.sourceDesktopRelay, '0'])
  expect(cells.slice(8)).toEqual(['5', en.notReported, '0', '0'])
  expect(within(rows[2]!).getAllByRole('cell').map(cell => cell.textContent).slice(7))
    .toEqual(['10', '11', en.notReported, '3', '4'])
  expect(screen.getByText('requested-model')).toBeDefined()
  expect(within(rows[2]!).getAllByRole('cell')[4]?.textContent).toContain(en.unknownRequests)
})

it('discards a pending relay page after unmount', async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<MuseAccountInjected['details']>>>()
  const details = vi.fn<MuseAccountInjected['details']>(() => pending.promise)
  const page = mount(details)
  await waitFor(() => { expect(details).toHaveBeenCalledOnce() })
  page.unmount()
  await act(async () => { pending.resolve({ ok: true, value: RELAY }) })
  expect(screen.queryByText(en.groupsNotProvided)).toBeNull()
})
