/** Prepare one existing Skill or import a ZIP before explicitly uploading a private draft. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarketCreatorDraft } from './market-view-store.ts'
import type { MarketActions, MarketIdentity, MarketInjected, MarketInstallation, MarketTranslate } from './market-actions.ts'
import { archiveBase64, downloadMarketFile, marketFailureOutcome } from './market-actions.ts'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { parseMarketUploadRequestId } from '@deepseek-ai/dsh-muse-market/cloud-values'
import { resolveMarketSkillArtwork } from './market-skill-artwork.ts'
import { SkillPortrait } from './SkillPortrait.tsx'
import css from './MarketCreatorPage.module.css'

/** Creator form with a retained upload identity; preparation and upload never enable the package. */
export function MarketCreatorPage({
  actions, draft, setDraft, prepared, completeUpload, discardUpload, sources, identity, installed,
  onPrepared, onPublished, reportOutcome, t, showHeader = true, initialMode = 'skill',
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
  readonly showHeader?: boolean
  readonly initialMode?: 'skill' | 'upload'
}): ReactNode {
  const { source, metadata, publisher } = draft
  const uploadRequest = draft.uploadRequest
  const sourceName = sources.skills.find(skill => (skill.sourceId ?? skill.name) === source)?.name ?? source
  const selected = installed.find(item => item.release.id === draft.selectedId)
  const target = identity?.publishers.find(row => row.id === publisher)
  const [mode, setMode] = useState<'skill' | 'upload'>(initialMode)
  const [pending, setPending] = useState(false)
  const [discarding, setDiscarding] = useState<NonNullable<MarketCreatorDraft['uploadRequest']>['key']>()
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const locked = pending || Boolean(draft.uploadRequest)
  const prepare = async (): Promise<void> => {
    if (pending || !source || draft.uploadRequest) return
    setPending(true)
    try {
      const item = await actions.prepare({ ...metadata,
        presetPortrait: resolveMarketSkillArtwork({ ...metadata, skills: [{ name: sourceName }] }),
        requirements: metadata.requirements.filter(value => value.trim()),
        examples: metadata.examples.filter(value => value.trim()) }, source)
      onPrepared(item); prepared(draft.revision, item.release.id); reportOutcome('done', false)
    } catch (error) { reportOutcome(marketFailureOutcome(error), true) }
    finally { if (alive.current) setPending(false) }
  }
  const importZip = !locked ? async (file: File): Promise<void> => {
    setPending(true)
    try {
      const imported = await actions.importPackage(await archiveBase64(file))
      const item = await actions.prepareUpload(imported.release.id, resolveMarketSkillArtwork(imported.release.manifest))
      onPrepared(item); prepared(draft.revision, item.release.id); reportOutcome('installedDone', false)
    } catch (error) { reportOutcome(marketFailureOutcome(error), true) }
    finally { if (alive.current) setPending(false) }
  } : undefined
  const selectLocal = !locked ? async (id: string): Promise<void> => {
    const selected = installed.find(item => item.release.id === id)
    if (!selected) { setDraft({ ...draft, selectedId: null }); return }
    setPending(true)
    try {
      const item = await actions.prepareUpload(selected.release.id, resolveMarketSkillArtwork(selected.release.manifest))
      if (alive.current) { onPrepared(item); prepared(draft.revision, item.release.id) }
    } catch (error) { reportOutcome(marketFailureOutcome(error), true) }
    finally { if (alive.current) setPending(false) }
  } : undefined
  const upload = selected && target && identity && !pending
    && (!draft.uploadRequest || draft.uploadRequest.accountId === identity.accountId) ? async (): Promise<void> => {
      const prior = draft.uploadRequest
      const current = prior?.releaseId === selected.release.id && prior.publisherId === target.id ? prior : {
        key: parseMarketUploadRequestId(randomUUID()), releaseId: selected.release.id,
        publisherId: target.id, accountId: identity.accountId,
      }
      setDraft({ ...draft, uploadRequest: current }); setPending(true)
      try {
        await actions.publishDraft(current.releaseId, current.publisherId, current.key)
        completeUpload(current.key); reportOutcome('draftDone', false); if (alive.current) onPublished()
      } catch (error) { reportOutcome(marketFailureOutcome(error), true) }
      finally { if (alive.current) setPending(false) }
    } : undefined
  const exportSelected = selected && !pending && !draft.uploadRequest ? async (): Promise<void> => {
    setPending(true)
    try { downloadMarketFile(await actions.exportPackage(selected.release.id)); reportOutcome('done', false) }
    catch (error) { reportOutcome(marketFailureOutcome(error), true) }
    finally { if (alive.current) setPending(false) }
  } : undefined
  const preview = selected?.release.manifest ?? (mode === 'skill'
    ? { ...metadata, skills: source ? [{ name: sourceName }] : [] }
    : { name: '', title: '', description: '', category: '' })
  const title = preview.title || t('creatorUntitled')
  const description = preview.description || t('creatorPreviewHint')
  return <section className={css.page} aria-label={t('creator')} aria-busy={pending}>
    {showHeader && <header className={css.header}><h2>{t('creator')}</h2><p>{t('prepareHint')}</p></header>}
    <div className={css.modeSwitch} role="group" aria-label={t('creator')}>
      {(['skill', 'upload'] as const).map(value => <Button key={value} variant="ghost" disabled={locked}
        aria-pressed={mode === value} onClick={() => {
          setMode(value)
          if (value === 'skill') setDraft({ ...draft, selectedId: null })
        }}>{t(value === 'skill' ? 'creatorNewSkill' : 'creatorUploadZip')}</Button>)}
    </div>
    <div className={css.layout}>
      <div className={css.main}>
        {mode === 'skill' ? <form className={css.card} onSubmit={(event) => { event.preventDefault(); void prepare() }}>
          <div className={css.sectionHeading}><h3>{t('creatorMetadataTitle')}</h3><p>{t('creatorMetadataHint')}</p></div>
          {!sources.complete && <p className={css.notice}>{t('sourcesIncomplete')}</p>}
          <label className={css.field}>{t('source')}<select required disabled={locked} value={source}
            onChange={(event) => { setDraft({ ...draft, source: event.target.value, selectedId: null }) }}>
            <option value="">{t('chooseSource')}</option>{sources.skills.map(skill => <option key={skill.sourceId ?? skill.name} value={skill.sourceId ?? skill.name}>{skill.name}{skill.version ? ` · ${skill.version}` : ''}</option>)}
          </select><span className={css.hint}>{t('creatorSourceHint')}</span></label>
          <div className={css.fields}>
            {(['title', 'name', 'version', 'license', 'category'] as const).map(field => <label key={field}
              className={field === 'title' ? `${css.field} ${css.fullField}` : css.field}>{t(`field.${field}`)}
              <Input required disabled={locked} value={metadata[field]} onChange={(event) => {
                setDraft({ ...draft, selectedId: null, metadata: { ...metadata, [field]: event.target.value } })
              }} /></label>)}
            <label className={`${css.field} ${css.fullField}`}>{t('field.description')}
              <textarea required disabled={locked} rows={4} value={metadata.description} onChange={(event) => {
                setDraft({ ...draft, selectedId: null, metadata: { ...metadata, description: event.target.value } })
              }} /></label>
            {(['requirements', 'examples'] as const).map(field => <label key={field} className={`${css.field} ${css.fullField}`}>{t(`field.${field}`)}
              <textarea disabled={locked} rows={3} value={metadata[field].join('\n')} onChange={(event) => {
                setDraft({ ...draft, selectedId: null, metadata: { ...metadata, [field]: event.target.value.split('\n') } })
              }} /></label>)}
          </div>
          <div className={css.actions}><Button variant="primary" type="submit" disabled={locked || !source}>{t('prepare')}</Button></div>
        </form> : <section className={css.card}>
          <div className={css.sectionHeading}><h3>{t('creatorUploadZip')}</h3><p>{t('creatorZipHint')}</p></div>
          <label className={css.uploadZone}><span className={css.uploadButton}>{t('import')}</span>
            <input className={css.fileInput} type="file" accept=".zip,application/zip" disabled={locked} onChange={importZip && ((event) => {
              const file = event.target.files?.[0]; event.target.value = ''
              if (file) void importZip(file)
            })} /></label>
          <label className={css.field}>{t('chooseLocal')}<select value={selected?.release.id ?? ''} disabled={locked}
            onChange={selectLocal && ((event) => { void selectLocal(event.target.value) })}>
            <option value="">{t('chooseLocal')}</option>{installed.map(item => <option key={item.release.id} value={item.release.id}>
              {item.release.manifest.title} · {item.release.manifest.version} · {item.release.sha256.slice(0, 12)}
            </option>)}</select></label>
        </section>}
        {selected && <section className={css.card}>
          <div className={css.sectionHeading}><h3>{t('creatorPreparedTitle')}</h3><p>{t('creatorPreparedHint')}</p></div>
          <div className={css.packageSummary}><strong>{selected.release.manifest.title}</strong>
            <span>{selected.release.manifest.version} · {selected.release.manifest.category}</span></div>
          <label className={css.field}>{t('publisher')}<select required disabled={locked} value={publisher}
            onChange={(event) => { setDraft({ ...draft, publisher: event.target.value }) }}>
            <option value="">{t('choosePublisher')}</option>{(identity?.publishers ?? []).map(row => <option key={row.id} value={row.id}>{row.title}</option>)}
          </select><span className={css.hint}>{t('creatorPublisherHint')}</span></label>
          <div className={css.actions}>
            <Button variant="outline" disabled={locked} onClick={exportSelected && (() => { void exportSelected() })}>{t('export')}</Button>
            <Button variant="primary" disabled={pending || !identity || !identity.publishers.some(row => row.id === publisher)
              || Boolean(draft.uploadRequest && draft.uploadRequest.accountId !== identity.accountId)}
            onClick={upload && (() => { void upload() })}>{t(draft.uploadRequest ? 'retryUpload' : 'upload')}</Button>
          </div>
          {uploadRequest && <Button variant="outline" disabled={pending} onClick={() => { setDiscarding(uploadRequest.key) }}>{t('discardUpload')}</Button>}
          {(identity?.publishers ?? []).length === 0 && <p className={css.notice}>{t('noPublisher')}</p>}
          <p className={css.hint}>{t('privateDraftHint')}</p>
        </section>}
      </div>
      <aside className={css.preview} aria-label={t('creatorPreviewTitle')}>
        <div className={css.previewHeading}><h3>{t('creatorPreviewTitle')}</h3>
          <span className={css.badge}>{t(selected ? 'creatorReadyBadge' : 'creatorDraftBadge')}</span></div>
        <SkillPortrait metadata={{ ...preview, title, description }} />
        <div className={css.previewBody}><h3>{title}</h3><p>{description}</p></div>
        <dl className={css.previewFacts}>
          <div><dt>{t('field.version')}</dt><dd>{(selected?.release.manifest.version ?? metadata.version) || '—'}</dd></div>
          <div><dt>{t('source')}</dt><dd>{(selected?.release.manifest.skills.map(skill => skill.name).join(', ') ?? sourceName) || '—'}</dd></div>
        </dl>
        <p className={css.hint}>{t('privateDraftHint')}</p>
      </aside>
    </div>
    <Modal open={discarding !== undefined} title={t('discardUpload')} closeLabel={t('close')} onClose={() => { setDiscarding(undefined) }}>
      {discarding !== undefined && <><p>{t('discardUploadHint')}</p><Button onClick={() => {
        discardUpload(discarding)
        setDiscarding(undefined)
      }}>{t('confirm')}</Button></>}
    </Modal>
  </section>
}
