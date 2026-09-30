// @vitest-environment jsdom
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JubianLedger, checkBudget, readProjectBudget, updateProjectBudget } from '@deepseek-ai/dsh-jubian'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
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
