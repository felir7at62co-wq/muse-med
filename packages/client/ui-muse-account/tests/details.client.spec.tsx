// @vitest-environment jsdom
/** Verified account details retain query recovery and discard superseded private responses. */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MuseAccountSection, type MuseAccountInjected, type MuseAccountSectionProps } from '../src/client/MuseAccountSection.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { MuseAccountLocaleKey } from '../src/client/locales.ts'
import { ACCOUNT_DETAILS } from './account-details.fixture.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const signedIn = { state: 'signed-in', username: 'writer', verified: true } as const
function props(overrides: Partial<MuseAccountInjected> = {}, copy: typeof en = en): MuseAccountSectionProps {
  return {
    t: (key: MuseAccountLocaleKey, parameters?: Record<string, unknown>) =>
      Object.entries(parameters ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), copy[key]),
    status: async () => ({ ok: true, value: signedIn }),
    details: async () => ({ ok: true, value: ACCOUNT_DETAILS }),
    login: async () => ({ ok: true, value: { outcome: 'signed-in', status: signedIn } }),
    logout: async () => ({ ok: true, value: { state: 'signed-out' } }),
    startBrowserLogin: async () => ({ ok: false, code: 'muse-account/gateway-unavailable' }),
    checkBrowserLogin: async () => ({ ok: true, value: { state: 'pending' } }),
    cancelBrowserLogin: async () => ({ ok: true, value: { state: 'signed-out' } }),
    ...overrides,
  } as MuseAccountSectionProps
}

it('shows own Feishu hierarchy and MUSE groups with reported token coverage and missing counts', async () => {
  render(<MuseAccountSection {...props({}, zh)} />)
  expect(await screen.findByText('编剧团队')).toBeDefined()
  expect(screen.getByText('负责短剧剧本创作')).toBeDefined()
  expect(screen.getByText('星河工作室 / 内容部 / 编剧组')).toBeDefined()
  expect(screen.getByText('组织标识：tenant-studio')).toBeDefined()
  const summary = document.querySelector('[data-muse-usage-summary]')!
  expect(summary.textContent).toContain('输入 Token1,200')
  expect(summary.textContent).toContain('总 Token1,500')
  expect(summary.textContent).toContain('已报告用量请求数1')
  const rows = within(screen.getByRole('table', { name: '请求明细' })).getAllByRole('row')
  expect(rows).toHaveLength(3)
  expect(rows[1]?.textContent).toContain('HTTP 200网关记录')
  expect(rows[2]?.textContent).toContain('桌面上报')
  expect(within(rows[2]!).getAllByRole('cell').filter(cell => cell.textContent === '未报告')).toHaveLength(6)
  expect(screen.getByText(zh.usageMissing)).toBeDefined()
})

it.each([
  [undefined, 'Sign in with Feishu again to sync your departments.'],
  [{ status: 'permission-required', syncedAt: ACCOUNT_DETAILS.usage.updatedAt, departments: [] }, en.feishuDepartmentsPermission],
  [{ status: 'unavailable', syncedAt: ACCOUNT_DETAILS.usage.updatedAt, departments: [] }, en.feishuDepartmentsUnavailable],
  [{ status: 'available', syncedAt: ACCOUNT_DETAILS.usage.updatedAt, departments: [] }, en.feishuDepartmentsEmpty],
] as const)('explains the department synchronization state: %s', async (organization, expected) => {
  const identity = ACCOUNT_DETAILS.account.feishuIdentities[0]!
  const { organization: _prior, ...identityFields } = identity
  const account = { ...ACCOUNT_DETAILS.account,
    feishuIdentities: [{ ...identityFields, ...(organization === undefined ? {} : { organization }) }] }
  render(<MuseAccountSection {...props({ details: async () => ({ ok: true, value: { ...ACCOUNT_DETAILS, account } }) })} />)
  expect(await screen.findByText(expected)).toBeDefined()
})

it('leaves details unread until the saved account has been verified', async () => {
  const details = vi.fn<MuseAccountInjected['details']>()
  render(<MuseAccountSection {...props({ details, status: async () => ({ ok: true, value: { ...signedIn, verified: false } }) })} />)
  await screen.findByText(en.verificationPending)
  expect(details).not.toHaveBeenCalled()
  expect(document.querySelector('[data-muse-account-details]')).toBeNull()
})

it('retains the last successful details on refresh failure and retries without exposing error data', async () => {
  const details = vi.fn<MuseAccountInjected['details']>()
    .mockResolvedValueOnce({ ok: true, value: ACCOUNT_DETAILS })
    .mockRejectedValueOnce(new Error('private gateway cookie'))
    .mockResolvedValueOnce({ ok: true, value: { ...ACCOUNT_DETAILS, groups: [] } })
  render(<MuseAccountSection {...props({ details })} />)
  await screen.findByText('编剧团队')
  fireEvent.click(screen.getByRole('button', { name: en.refreshUsage }))
  await screen.findByText(en.detailsUnavailable)
  expect(screen.getByText('编剧团队')).toBeDefined()
  expect(screen.queryByText('private gateway cookie')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.refreshUsage }))
  await screen.findByText(en.noGroups)
  expect(details).toHaveBeenCalledTimes(3)
})

it('recovers an initial details failure and shows an empty account without inventing usage', async () => {
  const empty = { ...ACCOUNT_DETAILS,
    account: { ...ACCOUNT_DETAILS.account, feishuIdentities: [] }, groups: [],
    usage: { ...ACCOUNT_DETAILS.usage,
      summary: { requests: 0, reportedRequests: 0, inputTokens: 0, outputTokens: 0,
        totalTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
      byModel: [], byDay: [], recent: [], pagination: { offset: 0, limit: 50, total: 0, hasMore: false } },
  }
  const details = vi.fn<MuseAccountInjected['details']>()
    .mockResolvedValueOnce({ ok: false, code: 'muse-account/gateway-unavailable' })
    .mockResolvedValueOnce({ ok: true, value: empty })
  render(<MuseAccountSection {...props({ details })} />)
  await screen.findByText(en.detailsUnavailable)
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  await screen.findByText(en.noFeishuIdentity)
  expect(screen.getByText(en.noGroups)).toBeDefined()
  expect(screen.getAllByText(en.noUsage)).toHaveLength(3)
  expect(screen.getByText('0–0 of 0')).toBeDefined()
  expect(screen.queryByRole('table')).toBeNull()
})

it('shows department names when Feishu omits its formatted path and accepts groups without descriptions', async () => {
  const identity = ACCOUNT_DETAILS.account.feishuIdentities[0]!
  const department = identity.organization!.departments[0]!
  const value = { ...ACCOUNT_DETAILS,
    account: { ...ACCOUNT_DETAILS.account, feishuIdentities: [{ ...identity, tenantKey: null,
      organization: { status: 'available' as const, syncedAt: ACCOUNT_DETAILS.usage.updatedAt,
        departments: [{ ...department, path: '' }] } }] },
    groups: ACCOUNT_DETAILS.groups.map(group => ({ ...group, description: '' })),
  }
  render(<MuseAccountSection {...props({ details: async () => ({ ok: true, value }) })} />)
  await screen.findByText('编剧组')
  expect(screen.getByText('Organization ID: Not reported')).toBeDefined()
  expect(screen.queryByText('负责短剧剧本创作')).toBeNull()
})

it('requests the selected period and bounded next page, then returns to its first page', async () => {
  const firstPage = { ...ACCOUNT_DETAILS, usage: { ...ACCOUNT_DETAILS.usage,
    pagination: { offset: 0, limit: 50, total: 51, hasMore: true } } }
  const details = vi.fn<MuseAccountInjected['details']>(async request => ({ ok: true, value: {
    ...firstPage, usage: { ...firstPage.usage,
      pagination: { offset: request.offset ?? 0, limit: 50, total: 51, hasMore: request.offset === 0 } },
  } }))
  render(<MuseAccountSection {...props({ details })} />)
  await screen.findByText('编剧团队')
  expect(details).toHaveBeenLastCalledWith({ period: '30d', offset: 0, limit: 50 })
  fireEvent.click(screen.getByRole('button', { name: en.nextPage }))
  await waitFor(() => { expect(details).toHaveBeenLastCalledWith({ period: '30d', offset: 50, limit: 50 }) })
  await waitFor(() => { expect(screen.getByRole('button', { name: en.previousPage }).hasAttribute('disabled')).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: en.previousPage }))
  await waitFor(() => { expect(details).toHaveBeenLastCalledWith({ period: '30d', offset: 0, limit: 50 }) })
  await waitFor(() => { expect(screen.getByRole('combobox').hasAttribute('disabled')).toBe(false) })
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '7d' } })
  await waitFor(() => { expect(details).toHaveBeenLastCalledWith({ period: '7d', offset: 0, limit: 50 }) })
})

it.each([
  ['verify', false], ['logout', false], ['unmount', false], ['unmount', true],
] as const)('discards a pending details response after %s (rejected=%s)', async (operation, rejected) => {
  const pending = Promise.withResolvers<Awaited<ReturnType<MuseAccountInjected['details']>>>()
  const details = vi.fn<MuseAccountInjected['details']>(() => pending.promise)
  const status = vi.fn<MuseAccountInjected['status']>()
    .mockResolvedValueOnce({ ok: true, value: signedIn })
    .mockResolvedValueOnce({ ok: true, value: { state: 'signed-out' } })
  const page = render(<MuseAccountSection {...props({ details, status })} />)
  await waitFor(() => { expect(details).toHaveBeenCalledOnce() })
  if (operation === 'unmount') page.unmount()
  else {
    fireEvent.click(screen.getByRole('button', { name: operation === 'verify' ? en.verify : en.signOut }))
    await screen.findByRole('button', { name: en.browserSignIn })
  }
  await act(async () => {
    if (rejected) pending.reject(new Error('late private details failure'))
    else pending.resolve({ ok: true, value: ACCOUNT_DETAILS })
  })
  expect(screen.queryByText('编剧团队')).toBeNull()
  expect(document.querySelector('[data-muse-account-details]')).toBeNull()
})

it('removes previous private details when the Host verifies a different account', async () => {
  const status = vi.fn<MuseAccountInjected['status']>().mockResolvedValueOnce({ ok: true, value: signedIn })
    .mockResolvedValueOnce({ ok: true, value: { ...signedIn, username: 'new-writer' } })
  const pending = Promise.withResolvers<Awaited<ReturnType<MuseAccountInjected['details']>>>()
  const details = vi.fn<MuseAccountInjected['details']>()
    .mockResolvedValueOnce({ ok: true, value: ACCOUNT_DETAILS }).mockImplementation(() => pending.promise)
  render(<MuseAccountSection {...props({ details, status })} />)
  await screen.findByText('编剧团队')
  fireEvent.click(screen.getByRole('button', { name: en.verify }))
  await screen.findByText('Current account: new-writer')
  expect(screen.queryByText('编剧团队')).toBeNull()
  await act(async () => { pending.resolve({ ok: true, value: { ...ACCOUNT_DETAILS,
    account: { ...ACCOUNT_DETAILS.account, username: 'new-writer', feishuIdentities: [] }, groups: [] } }) })
  expect(await screen.findByText(en.noGroups)).toBeDefined()
})

it('hides private details if their authenticated read finds an invalid session', async () => {
  render(<MuseAccountSection {...props({ details: async () => ({ ok: false, code: 'muse-account/invalid-credentials' }) })} />)
  await screen.findByText(en.verificationPending)
  expect(document.querySelector('[data-muse-account-details]')).toBeNull()
})
