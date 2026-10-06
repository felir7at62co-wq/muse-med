// @vitest-environment jsdom
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JubianLedger, checkBudget, readProjectBudget, updateProjectBudget } from '@deepseek-ai/dsh-jubian'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ProjectBudget } from '@deepseek-ai/dsh-jubian/types'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { ProjectBudgetGroup } from '../src/client/ProjectBudgetGroup.tsx'
import { en, type DramaLocaleKey } from '../src/client/locales.ts'
import type { DramaSettingsSectionProps } from '../src/client/DramaSettingsSection.tsx'

afterEach(cleanup)
const t = ((key: DramaLocaleKey, params?: Record<string, string | number>) => Object.entries(params ?? {})
  .reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), en[key])) as DramaSettingsSectionProps['t']

it('saves the user-entered project amount in the actual paid-call authorization and shows real readback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-budget-ui-'))
  const ledger = new JubianLedger({ root, defaultLimitCents: () => 400000 })
  try {
    render(<ProjectBudgetGroup t={t}
      read={async scriptId => ({ ok: true, value: await readProjectBudget(ledger, scriptId) })}
      update={async (scriptId, cents, revision) => ({ ok: true, value: await updateProjectBudget(ledger, {
        script_id: scriptId, limit_cents: cents, expected_revision: revision,
        authorization: { kind: 'settings', reference: 'settings/jubian-budget', text: `Settings: project ${scriptId} total budget ${cents / 100} CNY` },
      }) })} />)
    fireEvent.change(screen.getByLabelText(en.projectBudgetId), { target: { value: '2708' } })
    fireEvent.click(screen.getByRole('button', { name: en.projectBudgetRead }))
    await waitFor(() => { expect(screen.getByLabelText<HTMLInputElement>(en.projectBudgetAmount).value).toBe('4000') })
    fireEvent.change(screen.getByLabelText(en.projectBudgetAmount), { target: { value: '5000' } })
    fireEvent.click(screen.getByRole('button', { name: en.projectBudgetSave }))
    await waitFor(async () => { expect(await readProjectBudget(ledger, 2708)).toMatchObject({ limit_cents: 500000, source: 'project' }) })
    expect(await checkBudget({ ledger, method: 'image_generate', scriptId: 2708,
      quote: { amount: '4500.00', unit: 'CNY' } })).toMatchObject({ status: 'authorized', limitCents: 500000 })
    expect(screen.getByText(en.projectBudgetTotals.replace('{limit}', '5000.00').replace('{spent}', '0.00').replace('{reserved}', '0.00'))).toBeDefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

const actualBudget: ProjectBudget = { script_id: 2708, limit_cents: 400_000, unit: 'CNY', source: 'project',
  settled_cents: 1_000, reserved_cents: 500, remaining_cents: 398_500, revision: 'revision-1',
  authorization_path: 'budget.json', note: '', accounting_complete: true }

function readBudget() {
  fireEvent.change(screen.getByLabelText(en.projectBudgetId), { target: { value: '2708' } })
  fireEvent.click(screen.getByRole('button', { name: en.projectBudgetRead }))
}

it.each(['read', 'update'] as const)('shows unavailable budget operations when %s is absent', (missing) => {
  const available = async (): Promise<RemoteResult<ProjectBudget>> => ({ ok: true, value: actualBudget })
  render(<ProjectBudgetGroup t={t} {...missing === 'read' ? { update: available } : { read: available }} />)
  expect(screen.getByText(en.projectBudgetUnavailable)).toBeDefined()
  expect(screen.queryByRole('button', { name: en.projectBudgetRead })).toBeNull()
})

it('retains actual budget data after a refused update and clears its error when selecting another project', async () => {
  const update = vi.fn(async () => ({ ok: false as const, error: new RemoteError('gateway/internal', 'authorization rejected', {}) }))
  render(<ProjectBudgetGroup t={t} read={async () => ({ ok: true, value: actualBudget })} update={update} />)
  readBudget()
  await waitFor(() => { expect(screen.getByLabelText<HTMLInputElement>(en.projectBudgetAmount).value).toBe('4000') })
  fireEvent.change(screen.getByLabelText(en.projectBudgetAmount), { target: { value: '5000.25' } })
  fireEvent.click(screen.getByRole('button', { name: en.projectBudgetSave }))
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('authorization rejected') })
  expect(update).toHaveBeenCalledWith(2708, 500025, 'revision-1')
  expect(screen.getByText(en.projectBudgetTotals.replace('{limit}', '4000.00').replace('{spent}', '10.00').replace('{reserved}', '5.00'))).toBeDefined()
  fireEvent.change(screen.getByLabelText(en.projectBudgetId), { target: { value: '2709' } })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByLabelText(en.projectBudgetAmount)).toBeNull()
})

it.each([new Error('offline'), 'transport unavailable'])('shows a rejected transport without losing its editor (%s)', async (reason) => {
  render(<ProjectBudgetGroup t={t} read={async () => { throw reason }} update={async () => ({ ok: true, value: actualBudget })} />)
  readBudget()
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain(reason instanceof Error ? reason.message : reason) })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.projectBudgetRead }).disabled).toBe(false)
})

it('shows unconfigured authorization as empty and accepts a one-decimal amount', async () => {
  const update = vi.fn(async () => ({ ok: true as const, value: { ...actualBudget, limit_cents: 1020 } }))
  render(<ProjectBudgetGroup t={t} read={async () => ({ ok: true, value: { ...actualBudget, limit_cents: null } })} update={update} />)
  readBudget()
  await waitFor(() => { expect(screen.getByLabelText<HTMLInputElement>(en.projectBudgetAmount).value).toBe('') })
  expect(screen.getByText(en.projectBudgetTotals.replace('{limit}', en.projectBudgetUnconfigured)
    .replace('{spent}', '10.00').replace('{reserved}', '5.00'))).toBeDefined()
  fireEvent.change(screen.getByLabelText(en.projectBudgetAmount), { target: { value: '10.2' } })
  fireEvent.click(screen.getByRole('button', { name: en.projectBudgetSave }))
  await waitFor(() => { expect(update).toHaveBeenCalledWith(2708, 1020, 'revision-1') })
})

it.each([{ unit: 'USD' }, { accounting_complete: false }])('keeps unsupported or incomplete accounting read-only (%s)', async (fields) => {
  render(<ProjectBudgetGroup t={t} read={async () => ({ ok: true, value: { ...actualBudget, ...fields } })}
    update={async () => ({ ok: true, value: actualBudget })} />)
  readBudget()
  await waitFor(() => { expect(screen.getByLabelText<HTMLInputElement>(en.projectBudgetAmount).disabled).toBe(true) })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.projectBudgetSave }).disabled).toBe(true)
})

it.each([false, true])('settles an outstanding budget read after unmount without writing UI state (%s)', async (reject) => {
  let finish: ((result: RemoteResult<ProjectBudget>) => void) | undefined
  let fail: ((reason: Error) => void) | undefined
  const pending = new Promise<RemoteResult<ProjectBudget>>((resolve, rejectRequest) => { finish = resolve; fail = rejectRequest })
  const rendered = render(<ProjectBudgetGroup t={t} read={async () => await pending}
    update={async () => ({ ok: true, value: actualBudget })} />)
  readBudget(); rendered.unmount()
  await act(async () => {
    if (reject) fail?.(new Error('offline'))
    else finish?.({ ok: true, value: actualBudget })
    await Promise.resolve()
  })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('button', { name: en.projectBudgetRead })).toBeNull()
})
