/** User-confirmed browser ZIP upload with a local metadata preview. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { MarketManifest, MarketRelease } from '@deepseek-ai/dsh-muse-market/types'
import type { MarketSectionProps } from './MarketSection.tsx'
import type { MarketWebActions } from './market-web-types.ts'
import { MarketCharacter } from './MarketCharacter.tsx'
import { boundMarketPresentation } from './market-stock-art.ts'
import { findMarketPresetPortrait, marketPresetPortraits, matchMarketPresetPortrait } from './market-preset-portraits.ts'
import { marketFailure } from './market-errors.ts'
import css from './MarketSection.module.css'

/** Preview a selected archive, then upload exactly those bytes as a private draft.
 * @param props Browser callbacks, admitted publishing teams and confirmed-upload feedback.
 * @returns Upload form; selecting a file alone never contacts the upload endpoint.
 */
export function MarketBrowserUpload({ actions, publishers, onUploaded, reportOutcome, t }: {
  actions: MarketWebActions
  publishers: readonly { id: string; title: string }[]
  onUploaded: (release: MarketRelease) => void
  reportOutcome: MarketSectionProps['reportOutcome']
  t: MarketSectionProps['t']
}): ReactNode {
  const [publisher, setPublisher] = useState(publishers[0]?.id ?? '')
  const [selection, setSelection] = useState<{ name: string; bytes: Uint8Array; manifest: MarketManifest }>()
  const [portrait, setPortrait] = useState<MarketManifest['presetPortrait'] | MarketManifest['portrait']>()
  const [phase, setPhase] = useState<'idle' | 'reading' | 'uploading'>('idle')
  const [error, setError] = useState<Parameters<typeof t>[0]>()
  const operation = useRef<symbol | null>(null)
  const keys = useRef(new Map<string, string>())
  useEffect(() => {
    operation.current = null; keys.current.clear()
    setSelection(undefined); setPortrait(undefined); setPhase('idle'); setError(undefined)
    return () => { operation.current = null }
  }, [actions])
  const read = async (file: File): Promise<void> => {
    const token = Symbol(); operation.current = token
    keys.current.clear(); setSelection(undefined); setPortrait(undefined); setError(undefined); setPhase('reading')
    try {
      if (file.size > actions.archiveBytes) throw Error('archive-too-large')
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (operation.current !== token) return
      const manifest = await actions.previewArchive(bytes)
      if (operation.current !== token) return
      if (manifest.kind === 'bot') {
        setPortrait(manifest.presetPortrait ?? manifest.portrait ?? matchMarketPresetPortrait(manifest).id)
      }
      setSelection({ name: file.name, bytes, manifest })
    } catch (failure) {
      if (operation.current === token) setError(marketFailure(failure))
    } finally {
      if (operation.current === token) { operation.current = null; setPhase('idle') }
    }
  }
  const upload = async (): Promise<void> => {
    if (!selection || operation.current || !publishers.some(row => row.id === publisher)) return
    const token = Symbol(); operation.current = token; setPhase('uploading')
    const choice = publisher + '/' + (portrait ?? '')
    const key = keys.current.get(choice) ?? randomUUID()
    keys.current.set(choice, key)
    try {
      const release = portrait
        ? await actions.uploadArchive(selection.bytes, publisher, key, portrait)
        : await actions.uploadArchive(selection.bytes, publisher, key)
      if (operation.current !== token) return
      keys.current.clear(); setSelection(undefined); setError(undefined)
      onUploaded(release); reportOutcome('draft', false)
    } catch (failure) {
      if (operation.current === token) reportOutcome(marketFailure(failure), true)
    } finally {
      if (operation.current === token) { operation.current = null; setPhase('idle') }
    }
  }
  const blocked = phase !== 'idle'
  const selectedPresentation = selection && boundMarketPresentation(selection.manifest, portrait)
  return <section className={css.browserUpload} aria-label={t('browserUploadTitle')}>
    <div><h3>{t('browserUploadTitle')}</h3><p>{t('browserUploadHint', { limit: String(actions.archiveBytes / 1024 / 1024) })}</p></div>
    <div className={css.authorLayout}><form className={css.form} onSubmit={(event) => { event.preventDefault(); void upload() }}>
      <label className={css.field}>{t('publisher')}<select value={publisher} disabled={blocked || !publishers.length}
        onChange={(event) => { setPublisher(event.target.value) }}>
        {!publishers.length && <option value="">{t('noPublisher')}</option>}
        {publishers.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select></label>
      <label className={css.field}>{t('browserArchive')}<input type="file" accept=".zip,application/zip" disabled={phase === 'uploading' || !publishers.length}
        onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void read(file) }} /></label>
      {phase === 'reading' && <div role="status" aria-label={t('loading')}><StateDot state="ongoing" /></div>}
      {error && <p role="alert">{t(error)}</p>}
      {selection && <><p className={css.meta}>{selection.name}</p><dl className={css.detailFacts}>
        <dt>{t('label')}</dt><dd>{selection.manifest.title}</dd><dt>{t('version')}</dt><dd>{selection.manifest.version}</dd>
        <dt>{t('license')}</dt><dd>{selection.manifest.license}</dd><dt>{t('category')}</dt><dd>{selection.manifest.category}</dd>
        <dt>{t('sourceSkillsShort')}</dt><dd>{selection.manifest.skills.map(row => row.name).join(', ') || t('noSelectedSkills')}</dd>
      </dl><p>{selection.manifest.description}</p><p className={css.previewHint}>{t('browserPreviewHint')}</p></>}
      {selection?.manifest.kind === 'bot' && <label className={css.field}>{t('releasePortrait')}
        <select value={portrait ?? ''} disabled={blocked} onChange={(event) => {
          const choice = event.target.value
          if (choice === 'storyboard-director' || findMarketPresetPortrait(choice)) {
            setPortrait(choice === 'storyboard-director' ? choice : findMarketPresetPortrait(choice)?.id)
          }
        }}>
          {selection.manifest.portrait === 'storyboard-director' && <option value="storyboard-director">{t('directorPortrait')}</option>}
          {marketPresetPortraits.map(row => <option key={row.id} value={row.id}>{t(`presetPortrait.${row.id}`)}</option>)}
        </select>
      </label>}
      <Button type="submit" variant="primary" disabled={blocked || !selection || !publishers.some(row => row.id === publisher)}>{t('upload')}</Button>
    </form><div className={css.browserPreview}>
      <h3>{t('preview')}</h3><p className={css.meta}>{t('localPreview')}</p>
      <MarketCharacter presentation={selectedPresentation ?? { role: selection?.manifest.title ?? t('browserArchivePending'),
        introduction: selection?.manifest.description ?? t('browserArchivePendingHint') }} introduceLabel={t('introduce')} sampleLabel={t('samplePortrait')} />
      <p className={css.previewHint}>{t(selectedPresentation ? 'boundPortraitHint' : 'stockArtworkHint')}</p>
    </div></div>
  </section>
}
