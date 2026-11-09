/** Revision-fenced cloud review; local installation and defaults are separate actions. */
import { useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarketActions, MarketIdentity, MarketInjected, MarketPublication, MarketTranslate } from './market-actions.ts'
import css from './MarketSection.module.css'

type ReviewAction = Parameters<MarketActions['review']>[2]

/** Render only review actions allowed by the current server identity and publication status. */
export function MarketPublications({
  accessRevision, isCurrentAccess, items, identity, actions, busy, onReplace, onDetails, onInstall, reportOutcome, t,
}: {
  readonly accessRevision: number
  readonly isCurrentAccess: (revision: number) => boolean
  readonly items: readonly MarketPublication[]
  readonly identity: MarketIdentity
  readonly actions: MarketActions
  readonly busy: boolean
  readonly onReplace: (item: MarketPublication) => void
  readonly onDetails: (item: MarketPublication) => void
  readonly onInstall: (item: MarketPublication) => void
  readonly reportOutcome: MarketInjected['reportOutcome']
  readonly t: MarketTranslate
}): ReactNode {
  const [selection, setSelection] = useState<{ item: MarketPublication; action: ReviewAction }>()
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)
  const review = async (): Promise<void> => {
    if (!selection || pending || !isCurrentAccess(accessRevision)) return
    const { item, action } = selection
    setPending(true)
    try {
      const returned = await actions.review(item.id, item.revision, action, note.trim())
      if (!isCurrentAccess(accessRevision)) return
      onReplace(returned); setSelection(undefined); reportOutcome('reviewDone', false)
    } catch (error) {
      if (!isCurrentAccess(accessRevision)) return
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'muse-market/access-changed') return
      // Read the original publication after an uncertain reply; never repeat the review automatically.
      try { const observed = await actions.getPublication(item.id); if (isCurrentAccess(accessRevision)) onReplace(observed) }
      catch (_readError) { /* The existing row remains visible if original-identity readback also fails. */ }
      if (isCurrentAccess(accessRevision)) { setSelection(undefined); reportOutcome('reviewUnconfirmed', true) }
    } finally { setPending(false) }
  }
  return <><div className={css.grid}>{items.map((item) => {
    const owned = identity.admin || identity.publishers.some(row => row.id === item.publisherId)
    const choices: ReviewAction[] = []
    if (owned && (item.status === 'draft' || item.status === 'rejected')) choices.push('submit')
    if (identity.admin && item.status === 'pending') choices.push('approve', 'reject')
    if (owned && item.status === 'published') choices.push('withdraw')
    return <article className={css.card} key={item.id} data-market-publication={item.id}>
      <h2>{item.manifest.title}</h2><p>{item.publisher} · {item.manifest.version}</p>
      <span>{t(`publication.${item.status}`)}</span>{item.reviewNote && <p>{item.reviewNote}</p>}
      <div className={css.actions}><Button variant="outline" onClick={() => { onDetails(item) }}>{t('details')}</Button>
        <Button disabled={busy || pending} onClick={() => { onInstall(item) }}>{t('install')}</Button>
        {choices.map(action => <Button key={action} disabled={busy || pending} onClick={() => {
          setSelection({ item, action }); setNote('')
        }}>{t(`review.${action}`)}</Button>)}</div>
    </article>
  })}</div><Modal open={Boolean(selection)} title={selection ? t(`review.${selection.action}`) : t('publish')}
    closeLabel={t('close')} onClose={() => { if (!pending) setSelection(undefined) }}>
    {selection && <form className={css.form} onSubmit={(event) => { event.preventDefault(); void review() }}>
      <p>{selection.item.manifest.title} · {selection.item.manifest.version}</p><p>{t('reviewConfirm')}</p>
      {selection.action === 'approve' && <p>{t('reviewPackageFirst')}</p>}
      {selection.action === 'reject' && <label>{t('reviewNote')}<textarea required rows={3} maxLength={2000}
        disabled={pending} value={note} onChange={(event) => { setNote(event.target.value) }} /></label>}
      <Button variant="primary" type="submit" disabled={pending || selection.action === 'reject' && !note.trim()}>{t('confirm')}</Button>
    </form>}
  </Modal></>
}
