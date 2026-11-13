/** Prepare exactly one existing Skill and explicitly upload a validated local release as a private draft. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarketCreatorDraft } from './market-view-store.ts'
import type { MarketActions, MarketIdentity, MarketInjected, MarketInstallation, MarketTranslate } from './market-actions.ts'
import { downloadMarketFile, marketFailureOutcome } from './market-actions.ts'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { parseMarketUploadRequestId } from '@deepseek-ai/dsh-muse-market/cloud-values'
import css from './MarketSection.module.css'

/** Creator form with a retained upload identity; preparation and upload never enable the package. */
export function MarketCreatorPage({
  actions, draft, setDraft, prepared, completeUpload, discardUpload, sources, identity, installed,
  onPrepared, onPublished, reportOutcome, t,
}: {
  readonly actions: MarketActions
  readonly draft: MarketCreatorDraft
  readonly setDraft: (value: MarketCreatorDraft) => void
  readonly prepared: (revision: number, id: MarketInstallation['release']['id']) => void
  readonly completeUpload: (key: NonNullable<MarketCreatorDraft['uploadRequest']>['key']) => void
  readonly discardUpload: (key: NonNullable<MarketCreatorDraft['uploadRequest']>['key']) => void
  readonly sources: Awaited<ReturnType<MarketActions['sources']>>
  readonly identity: MarketIdentity | undefined
  readonly installed: readonly MarketInstallation[]
  readonly onPrepared: (item: MarketInstallation) => void
  readonly onPublished: () => void
  readonly reportOutcome: MarketInjected['reportOutcome']
  readonly t: MarketTranslate
}): ReactNode {
  const { source, metadata, publisher } = draft
  const selected = installed.find(item => item.release.id === draft.selectedId)
  const [pending, setPending] = useState(false), [discarding, setDiscarding] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const prepare = async (): Promise<void> => {
    setPending(true)
    try {
      const item = await actions.prepare({ ...metadata, requirements: metadata.requirements.filter(value => value.trim()),
        examples: metadata.examples.filter(value => value.trim()) }, source)
      onPrepared(item); prepared(draft.revision, item.release.id); reportOutcome('done', false)
    } catch (error) { reportOutcome(marketFailureOutcome(error), true) }
    finally { if (alive.current) setPending(false) }
  }
  const upload = async (): Promise<void> => {
    // oxlint-disable typescript/no-non-null-assertion -- Enabled uploads require this release and its current authorized publisher.
    const item = selected!, account = identity!
    const target = account.publishers.find(row => row.id === publisher)!
    // oxlint-enable typescript/no-non-null-assertion
    const prior = draft.uploadRequest
    const current = prior?.releaseId === item.release.id && prior.publisherId === target.id ? prior : {
      key: parseMarketUploadRequestId(randomUUID()), releaseId: item.release.id,
      publisherId: target.id, accountId: account.accountId,
    }
    setDraft({ ...draft, uploadRequest: current }); setPending(true)
    try {
      await actions.publishDraft(current.releaseId, current.publisherId, current.key)
      completeUpload(current.key); reportOutcome('draftDone', false); if (alive.current) onPublished()
    } catch (error) { reportOutcome(marketFailureOutcome(error), true) }
    finally { if (alive.current) setPending(false) }
  }
  const exportSelected = async (): Promise<void> => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- Export is rendered for the selected package and disabled while pending.
    const item = selected!
    setPending(true)
    try { downloadMarketFile(await actions.exportPackage(item.release.id)); reportOutcome('done', false) }
    catch (error) { reportOutcome(marketFailureOutcome(error), true) }
    finally { if (alive.current) setPending(false) }
  }
  const fields = ['name', 'title', 'description', 'version', 'license', 'category'] as const
  return <section className={css.form} aria-label={t('creator')}><h2>{t('creator')}</h2><p>{t('prepareHint')}</p>
    {!sources.complete && <p className={css.notice}>{t('sourcesIncomplete')}</p>}
    <form className={css.form} onSubmit={(event) => { event.preventDefault(); void prepare() }}>
      <label>{t('source')}<select required disabled={pending || Boolean(draft.uploadRequest)} value={source} onChange={(event) => { setDraft({ ...draft, source: event.target.value }) }}>
        <option value="">{t('chooseSource')}</option>{sources.skills.map(skill => <option key={skill.name} value={skill.name}>{skill.name}</option>)}
      </select></label>
      {fields.map(field => <label key={field}>{t(`field.${field}`)}<Input required disabled={pending || Boolean(draft.uploadRequest)} value={metadata[field]}
        onChange={(event) => { setDraft({ ...draft, metadata: { ...metadata, [field]: event.target.value } }) }} /></label>)}
      {(['requirements', 'examples'] as const).map(field => <label key={field}>{t(`field.${field}`)}<textarea disabled={pending || Boolean(draft.uploadRequest)} rows={3}
        value={metadata[field].join('\n')} onChange={(event) => { setDraft({ ...draft, metadata: { ...metadata, [field]: event.target.value.split('\n') } }) }} /></label>)}
      <Button type="submit" disabled={pending || Boolean(draft.uploadRequest) || !source}>{t('prepare')}</Button>
    </form>
    <label>{t('chooseLocal')}<select value={selected?.release.id ?? ''} disabled={pending || Boolean(draft.uploadRequest)} onChange={(event) => {
      setDraft({ ...draft, selectedId: installed.find(item => item.release.id === event.target.value)?.release.id ?? null })
    }}><option value="">{t('chooseLocal')}</option>{installed.map(item => <option key={item.release.id} value={item.release.id}>
        {item.release.manifest.title} · {item.release.manifest.version} · {item.release.sha256.slice(0, 12)}
      </option>)}</select></label>
    {selected && <div className={css.actions}><Button disabled={pending || Boolean(draft.uploadRequest)} onClick={() => { void exportSelected() }}>{t('export')}</Button>
      <label>{t('publisher')}<select required disabled={pending || Boolean(draft.uploadRequest)} value={publisher} onChange={(event) => { setDraft({ ...draft, publisher: event.target.value }) }}>
        <option value="">{t('choosePublisher')}</option>{(identity?.publishers ?? []).map(row => <option key={row.id} value={row.id}>{row.title}</option>)}
      </select></label><Button variant="primary" disabled={pending || !identity || !(identity.publishers.some(row => row.id === publisher)) || Boolean(draft.uploadRequest && draft.uploadRequest.accountId !== identity.accountId)} onClick={() => { void upload() }}>{t(draft.uploadRequest ? 'retryUpload' : 'upload')}</Button></div>}
    {draft.uploadRequest && <Button variant="outline" onClick={() => { setDiscarding(true) }}>{t('discardUpload')}</Button>}
    {(identity?.publishers ?? []).length === 0 && <p>{t('noPublisher')}</p>}<p>{t('privateDraftHint')}</p>
    <Modal open={discarding} title={t('discardUpload')} closeLabel={t('close')} onClose={() => { setDiscarding(false) }}>
      <p>{t('discardUploadHint')}</p><Button onClick={() => {
        if (draft.uploadRequest) discardUpload(draft.uploadRequest.key)
        setDiscarding(false)
      }}>{t('confirm')}</Button>
    </Modal>
  </section>
}
