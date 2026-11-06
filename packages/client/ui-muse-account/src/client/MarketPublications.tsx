/** Cloud release review controls, separate from local packages and activation. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarketRelease } from '@deepseek-ai/dsh-muse-market/types'
import type { MarketSectionProps } from './MarketSection.tsx'
import { marketFailure } from './market-errors.ts'
import type { MarketPublicationActions } from './market-web-types.ts'
import { MarketReleaseCard } from './MarketReleaseCard.tsx'
import css from './MarketSection.module.css'

type ReviewAction = 'submit' | 'approve' | 'reject' | 'withdraw'

/** Show server-authorized publications and apply only confirmed review results.
 * @param props Host callbacks, confirmed identity and localized copy.
 * @returns Cloud list with revision-fenced review dialogs; it never changes local installations.
 */
export function MarketPublications({ actions, publishers, admin, reportOutcome,
  onDetails, onDownload, localBusy, t, browserMode = false }: {
  actions: MarketPublicationActions
  publishers: readonly { id: string; title: string }[]
  admin: boolean
  reportOutcome: MarketSectionProps['reportOutcome']
  onDetails: (release: MarketRelease) => void
  onDownload: (release: MarketRelease) => void
  localBusy: boolean
  t: MarketSectionProps['t']
  browserMode?: boolean
}): ReactNode {
  const [items, setItems] = useState<MarketRelease[]>([])
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [busy, setBusy] = useState(false)
  const [selection, setSelection] = useState<{ release: MarketRelease; action: ReviewAction }>()
  const [note, setNote] = useState('')
  const operation = useRef<symbol | null>(null)
  const read = async (token: symbol): Promise<void> => {
    setPhase('loading')
    try {
      const rows = await actions.catalog('', 'skill', true)
      if (operation.current === token) { setItems(rows.filter(row => row.manifest.kind === 'skill')); setPhase('ready') }
    } catch (_error) {
      // The cloud catalog retains prior results and uses bounded copy instead of upstream diagnostics.
      if (operation.current === token) setPhase('error')
    } finally { if (operation.current === token) operation.current = null }
  }
  useEffect(() => {
    const token = Symbol(); operation.current = token
    setBusy(false); setSelection(undefined)
    void read(token)
    return () => { operation.current = null }
  }, [actions])
  const review = async (): Promise<void> => {
    if (!selection || operation.current) return
    const token = Symbol(), { release, action } = selection
    operation.current = token; setBusy(true)
    try {
      const returned = await actions.review(release.id, release.revision, action, note.trim())
      if (operation.current === token) {
        setItems(previous => previous.map(row => row.id === returned.id ? returned : row))
        setSelection(undefined); setNote('')
      }
      reportOutcome('reviewDone', false)
    } catch (error) {
      const key = marketFailure(error)
      if (key === 'error.cloud-conflict' && operation.current === token) {
        setSelection(undefined); setNote(''); setBusy(false)
        await read(token)
      }
      reportOutcome(key, true)
    } finally { if (operation.current === token) { operation.current = null; setBusy(false) } }
  }
  return <section className={css.publications} aria-label={t('cloudPublications')}>
    <div className={css.previewHeading}><h3>{t('cloudPublications')}</h3>
      <Button disabled={busy || phase === 'loading'} onClick={() => { const token = Symbol(); operation.current = token; void read(token) }}>{t('refresh')}</Button></div>
    <p className={css.previewHint}>{t(browserMode ? 'browserCloudHint' : 'cloudLocalSeparate')}</p>
    {admin && <div className={css.actions}><span className={css.badge}>{t('administrator')}</span>{browserMode && <a href="/market/basic">{t('browserManagePublishers')}</a>}</div>}
    {phase === 'loading' && <div role="status" aria-label={t('loading')}><StateDot state="ongoing" /></div>}
    {phase === 'error' && <div className={css.readNotice}><p role="alert">{t(items.length ? 'readFailedRetained' : 'readFailed')}</p>
      <Button disabled={busy} onClick={() => { const token = Symbol(); operation.current = token; void read(token) }}>{t('retry')}</Button></div>}
    {!items.length && phase === 'ready' && <p>{t('noCloudPublications')}</p>}
    <div className={css.grid}>{items.map((release) => {
      const owned = admin || publishers.some(row => row.id === release.publisherId)
      const possible: ReviewAction[] = []
      if (owned && (release.status === 'draft' || release.status === 'rejected')) possible.push('submit')
      if (admin && release.status === 'pending') possible.push('approve', 'reject')
      if (owned && release.status === 'published') possible.push('withdraw')
      return <MarketReleaseCard key={release.id} release={release} showStatus t={t}>
        {release.reviewNote && <p>{t('reviewNote')}: {release.reviewNote}</p>}
        <div className={css.actions}><Button variant="outline" onClick={() => { onDetails(release) }}>{t('details')}</Button>
          <Button disabled={busy || localBusy || phase !== 'ready'} onClick={() => { onDownload(release) }}>{t(browserMode ? 'browserDownload' : 'download')}</Button>
          {possible.map(action => <Button key={action} disabled={busy || localBusy || phase !== 'ready'} onClick={() => {
            setSelection({ release, action }); setNote('')
          }}>{t(`review.${action}`)}</Button>)}</div>
      </MarketReleaseCard>
    })}</div>
    <Modal open={Boolean(selection)} title={selection ? t(`review.${selection.action}`) : t('cloudPublications')}
      closeLabel={t('closeReview')} onClose={() => { if (!busy) setSelection(undefined) }}>
      {selection && <form className={`${css.detailBody} ${css.reviewForm}`} onSubmit={(event) => { event.preventDefault(); void review() }}>
        <p>{selection.release.manifest.title} · {selection.release.manifest.version}</p>
        <p>{t('reviewConfirmHint')}</p>
        {selection.action === 'approve' && <p>{t('reviewPackageFirst')}</p>}
        {selection.action === 'reject' && <label className={css.field}>{t('reviewNote')}
          <textarea rows={3} maxLength={2000} required disabled={busy} value={note}
            onChange={(event) => { setNote(event.target.value) }} /></label>}
        <Button type="submit" variant="primary" disabled={busy || phase !== 'ready' || selection.action === 'reject' && !note.trim()}>{t('confirmReview')}</Button>
      </form>}
    </Modal>
  </section>
}
