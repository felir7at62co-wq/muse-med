/** Local browser ZIP preview followed by an explicitly confirmed, account-bound cloud upload. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { parseMarketUploadRequestId, type MarketAccountId, type MarketPublisherId,
  type MarketUploadRequestId } from '@deepseek-ai/dsh-muse-market/cloud-values'
import type { MarketIdentity, MarketOutcomeKey, MarketPublication, MarketTranslate } from './market-actions.ts'
import { marketFailureOutcome } from './market-actions.ts'
import type { MarketBrowserActions, MarketBrowserArchive } from './market-browser-actions.ts'
import { resolveMarketSkillArtwork } from './market-skill-artwork.ts'
import { SkillPortrait } from './SkillPortrait.tsx'
import css from './MarketCreatorPage.module.css'

type Selection = { readonly fileName: string; readonly archive: MarketBrowserArchive; readonly account: MarketAccountId | undefined }
type UploadAttempt = {
  readonly archive: Uint8Array
  readonly publisher: MarketPublisherId
  readonly account: MarketAccountId
  readonly key: MarketUploadRequestId
}

/** Retain preview bytes and upload identity across navigation until confirmation or discard.
 * @param props - Browser transport, current public identity and owning page callbacks.
 * @returns ZIP-only creator form using the same character and preview styles as Desktop.
 */
export function MarketBrowserUpload({
  actions, identity, identityError, identityLoading, retryIdentity, verifyIdentity, onUploaded, reportOutcome, t,
}: {
  readonly actions: MarketBrowserActions
  readonly identity: MarketIdentity | undefined
  readonly identityError: MarketOutcomeKey | undefined
  readonly identityLoading: boolean
  readonly retryIdentity: () => void
  readonly verifyIdentity: (expected: MarketAccountId) => Promise<MarketIdentity>
  readonly onUploaded: (publication: MarketPublication) => void
  readonly reportOutcome: (key: MarketOutcomeKey, failed: boolean) => void
  readonly t: MarketTranslate
}): ReactNode {
  const [selection, setSelection] = useState<Selection>()
  const [publisher, setPublisher] = useState('')
  const [attempt, setAttempt] = useState<UploadAttempt>()
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'uploading'>('idle')
  const [discarding, setDiscarding] = useState(false)
  const alive = useRef(false), generation = useRef(0), uploading = useRef(false)
  const currentAccount = useRef(identity?.accountId)
  currentAccount.current = identity?.accountId
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; ++generation.current }
  }, [actions])
  const chosen = (identity?.publishers ?? []).find(row => row.id === (publisher || identity?.publishers[0]?.id))
  const locked = Boolean(attempt) || phase === 'uploading'
  const read = async (file: File): Promise<void> => {
    if (locked) return
    const token = ++generation.current, account = currentAccount.current
    setSelection(undefined); setPhase('preparing')
    try {
      if (file.size === 0 || file.size > actions.archiveBytes) { reportOutcome('browserArchiveTooLarge', true); return }
      const bytes = new Uint8Array(await file.arrayBuffer())
      const manifest = await actions.previewArchive(bytes)
      const archive = await actions.prepareArchive(bytes, resolveMarketSkillArtwork(manifest))
      if (alive.current && generation.current === token) setSelection({ fileName: file.name, archive, account })
    } catch (error) { if (alive.current && generation.current === token) reportOutcome(marketFailureOutcome(error), true) }
    finally { if (alive.current && generation.current === token) setPhase('idle') }
  }
  const upload = async (): Promise<void> => {
    if (!selection || !chosen || !identity || uploading.current || phase === 'preparing') return
    if (selection.account !== undefined && selection.account !== identity.accountId) { reportOutcome('signInRequired', true); return }
    if (attempt && identity.accountId !== attempt.account) { reportOutcome('signInRequired', true); return }
    const token = generation.current
    uploading.current = true; setPhase('uploading')
    const original = attempt ?? { archive: Uint8Array.from(selection.archive.bytes), publisher: chosen.id,
      account: identity.accountId, key: parseMarketUploadRequestId(randomUUID()) }
    const currentAttempt = (): boolean => alive.current && generation.current === token && currentAccount.current === original.account
    setAttempt(original)
    try {
      const current = await verifyIdentity(original.account)
      if (!currentAttempt()) return
      if (!current.publishers.some(row => row.id === original.publisher)) { reportOutcome('permissionDenied', true); return }
      const publication = await actions.uploadArchive(original.archive, original.publisher, original.key, original.account)
      if (currentAttempt()) {
        setAttempt(undefined); setSelection(undefined); reportOutcome('draftDone', false); onUploaded(publication)
      }
    } catch (error) { if (alive.current && generation.current === token) reportOutcome(marketFailureOutcome(error), true) }
    finally { uploading.current = false; if (alive.current && generation.current === token) setPhase('idle') }
  }
  const visibleSelection = selection && (selection.account === undefined || selection.account === identity?.accountId)
    && (!attempt || attempt.account === identity?.accountId) ? selection : undefined
  const manifest = visibleSelection?.archive.manifest
  return <section className={css.page} aria-label={t('creatorUploadZip')} aria-busy={phase !== 'idle'}>
    <div className={css.layout}><div className={css.main}>
      <form className={css.card} onSubmit={(event) => { event.preventDefault(); void upload() }}>
        <div className={css.sectionHeading}><h2>{t('creatorUploadZip')}</h2><p>{t('browserUploadDescription')}</p></div>
        <label className={css.uploadZone}><span className={css.uploadButton}>{t('browserChooseArchive')}</span>
          <input className={css.fileInput} type="file" accept=".zip,application/zip" disabled={locked}
            onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void read(file) }} /></label>
        {phase !== 'idle' && <div role="status" aria-label={t('loading')}><StateDot state="ongoing" /></div>}
        {visibleSelection && <><p>{visibleSelection.fileName}</p><p className={css.hint}>{t('browserPreparedArchive')}</p></>}
        <label className={css.field}>{t('publisher')}<select value={chosen?.id ?? ''} disabled={locked}
          onChange={(event) => { setPublisher(event.target.value) }}><option value="">{t('choosePublisher')}</option>
          {(identity?.publishers ?? []).map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select></label>
        {!identity ? !identityLoading && <div className={css.notice}><p role="alert">{t(identityError ?? 'browserSignInHint')}</p>
          {identityError === 'signInRequired' || identityError === undefined ? <a href="/login">{t('browserSignIn')}</a>
            : <Button type="button" onClick={retryIdentity}>{t('retry')}</Button>}</div>
          : identity.publishers.length === 0 && <p className={css.notice}>{t('noPublisher')}</p>}
        {attempt && <p className={css.notice}>{t('browserUploadRetained')}</p>}
        <div className={css.actions}><Button type="submit" variant="primary"
          disabled={!visibleSelection || !chosen || !identity || phase !== 'idle' || Boolean(attempt && attempt.account !== identity.accountId)}>
          {t(attempt ? 'retryUpload' : 'upload')}</Button>
        {attempt && <Button variant="outline" disabled={phase !== 'idle'} onClick={() => { setDiscarding(true) }}>{t('discardUpload')}</Button>}</div>
        <p className={css.hint}>{t('privateDraftHint')}</p>
      </form>
    </div><aside className={css.preview} aria-label={t('creatorPreviewTitle')}>
      <div className={css.previewHeading}><h2>{t('creatorPreviewTitle')}</h2><span className={css.badge}>{t('creatorDraftBadge')}</span></div>
      {manifest ? <><SkillPortrait metadata={manifest} introductionLabel={t('meetSkill')} closeLabel={t('close')} />
        <div className={css.previewBody}><h3>{manifest.title}</h3><p>{manifest.description}</p></div>
        <dl className={css.previewFacts}><div><dt>{t('field.version')}</dt><dd>{manifest.version}</dd></div>
          <div><dt>{t('containedSkills')}</dt><dd>{manifest.skills.map(skill => skill.name).join(', ')}</dd></div>
          <div><dt>{t('field.license')}</dt><dd>{manifest.license}</dd></div></dl></>
        : <p>{t('browserArchivePending')}</p>}
    </aside></div>
    <Modal open={discarding} title={t('discardUpload')} closeLabel={t('close')} onClose={() => { setDiscarding(false) }}>
      <p>{t('discardUploadHint')}</p><Button onClick={() => { setAttempt(undefined); setDiscarding(false) }}>{t('confirm')}</Button>
    </Modal>
  </section>
}
