/** A project ceiling editor over the same authorization and accounting used by paid calls. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { ProjectBudget } from '@deepseek-ai/dsh-jubian/types'
import type { DramaSettingsSectionProps } from './DramaSettingsSection.tsx'
import css from './DramaSettingsSection.module.css'

/** Shared budget namespace supplied by the optional Jubian tool composition. */
export interface ProjectBudgetFace {
  /** @param scriptId - Exact remote project ID. @returns Effective ceiling and accounting. */
  read(scriptId: number): Promise<RemoteResult<ProjectBudget>>
  /**
   * @param scriptId - Selected project.
   * @param cents - User-entered total ceiling.
   * @param revision - Read revision.
   * @returns Actual saved authorization.
   */
  update(scriptId: number, cents: number, revision: string): Promise<RemoteResult<ProjectBudget>>
}

/**
 * Render project selection, actual spend and a revision-protected ceiling edit.
 * @param props - Locale and optional composed budget operations.
 * @returns The editor or an unavailable notice; failures keep the previous actual data visible.
 */
export function ProjectBudgetGroup({ t, read, update }: {
  t: DramaSettingsSectionProps['t']
  read?: ProjectBudgetFace['read']
  update?: ProjectBudgetFace['update']
}): ReactNode {
  const [id, setId] = useState(''), [amount, setAmount] = useState('')
  const [budget, setBudget] = useState<ProjectBudget>()
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>()
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const scriptId = /^\d+$/.test(id) ? Number(id) : 0
  const validId = Number.isSafeInteger(scriptId) && scriptId > 0
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim())
  const cents = match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : -1
  const validAmount = Number.isSafeInteger(cents) && cents >= 0
  const run = async (save: boolean): Promise<void> => {
    if (!read || !update || !validId || (save && (!budget || !validAmount))) return
    setBusy(true); setError(undefined)
    try {
      const result = save && budget ? await update(scriptId, cents, budget.revision) : await read(scriptId)
      if (!alive.current) return
      if (!result.ok) { setError(result.error.message); return }
      setBudget(result.value)
      setAmount(result.value.limit_cents === null ? '' : String(result.value.limit_cents / 100))
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally { if (alive.current) setBusy(false) }
  }
  return <section className={css.group}>
    <h3 className={css.groupTitle}>{t('projectBudgetTitle')}</h3>
    <p className={css.groupDescription}>{t('projectBudgetDescription')}</p>
    {!read || !update ? <p className={css.notice}>{t('projectBudgetUnavailable')}</p> : <>
      <input className={css.input} inputMode="numeric" aria-label={t('projectBudgetId')}
        placeholder={t('projectBudgetId')} value={id} disabled={busy}
        onChange={(event) => { setId(event.currentTarget.value); setBudget(undefined); setError(undefined) }} />
      <div className={css.actions}><Button variant="outline" disabled={busy || !validId}
        onClick={() => { void run(false) }}>{t('projectBudgetRead')}</Button></div>
      {budget ? <>
        <p className={css.notice}>{t('projectBudgetTotals', {
          limit: budget.limit_cents === null ? t('projectBudgetUnconfigured') : (budget.limit_cents / 100).toFixed(2),
          spent: (budget.settled_cents / 100).toFixed(2), reserved: (budget.reserved_cents / 100).toFixed(2),
        })}</p>
        <input className={css.input} inputMode="decimal" aria-label={t('projectBudgetAmount')}
          value={amount} disabled={busy || budget.unit !== 'CNY' || !budget.accounting_complete}
          onChange={(event) => { setAmount(event.currentTarget.value) }} />
        <div className={css.actions}><Button variant="outline"
          disabled={busy || !validAmount || budget.unit !== 'CNY' || !budget.accounting_complete || cents === budget.limit_cents}
          onClick={() => { void run(true) }}>{t('projectBudgetSave')}</Button></div>
      </> : null}
      {error ? <p className={css.notice} role="alert">{t('projectBudgetFailed', { reason: error })}</p> : null}
    </>}
  </section>
}
