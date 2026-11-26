/** Read-only catalog cards and verified image previews. */
import { useState, type ReactNode } from 'react'
import { Button, IconLoadingOutlineRegular, IconSearchOutlineRegular, IconWarningOutlineRegular, Input, Modal, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CharacterLibraryEntry } from '@deepseek-ai/dsh-api-character-library/types'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import s from './LibraryPage.module.css'

type Collection = 'all' | 'ancient' | 'urban'
type PageProps = PropsRuntime<'main'> & PropsLocale<'characterLibrary'>
type CardProps = Pick<PageProps, 'useResource' | 't'> & {
  readonly entry: CharacterLibraryEntry
  readonly revision: number
  readonly onOpen: () => void
}

function imageAddress(id: string, revision: number): string {
  return `dsh-resource://character-library-image/${encodeURIComponent(id)}?revision=${revision}`
}

function CharacterCard({ entry, revision, onOpen, useResource, t }: CardProps): ReactNode {
  const image = useResource<'character-library-image'>(imageAddress(entry.catalogAssetId, revision))
  return <button type="button" className={s.card} onClick={onOpen} aria-label={`${t('preview')}: ${entry.originalAssetId}`}>
    <div className={s.thumbnail} aria-busy={image.status === 'loading'}>
      {image.value === undefined
        ? image.status === 'failed'
          ? <span className={s.imageFailure}><IconWarningOutlineRegular size={24} />{t('imageFailed')}</span>
          : <div className={s.imageSkeleton} />
        : <img src={image.value.dataUrl} alt={entry.originalAssetId} loading="lazy" />}
    </div>
    <span className={s.cardTitle}>{entry.originalAssetId}</span>
    <span className={s.caption}>{[entry.artStyle, ...entry.appearance, ...entry.tags].filter(Boolean).join(' · ') || t(entry.collection)}</span>
  </button>
}

/**
 * Render the catalog with local viewing state and framework-owned resources.
 * @param props - Resource reader and localized page copy supplied by the slot renderer.
 * @returns Read-only catalog cards, navigation and a full-image preview dialog.
 */
export function LibraryPage({ useResource, t }: PageProps): ReactNode {
  const [collection, setCollection] = useState<Collection>('all')
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [cursors, setCursors] = useState<readonly string[]>([])
  const [revision, setRevision] = useState(0)
  const [selected, setSelected] = useState<CharacterLibraryEntry | null>(null)
  const status = useResource<'character-library-status'>(`dsh-resource://character-library-status/current?revision=${revision}`)
  const parameters = new URLSearchParams({ collection, query, revision: String(revision) })
  const cursor = cursors.at(-1)
  if (cursor !== undefined) parameters.set('cursor', cursor)
  const catalog = useResource<'character-library-catalog'>(status.value?.configured === true
    ? `dsh-resource://character-library-catalog/current?${parameters}` : 'library://inactive')
  const preview = useResource<'character-library-image'>(selected === null ? 'library://inactive' : imageAddress(selected.catalogAssetId, revision))
  const entries = catalog.value?.entries ?? []
  const nextCursor = catalog.value?.nextCursor
  const refresh = (): void => { setCursors([]); setRevision(value => value + 1) }
  const chooseCollection = (value: Collection): void => { setCollection(value); setCursors([]); setSelected(null) }
  const search = (): void => { setQuery(draft.trim()); setCursors([]); setSelected(null) }
  const loading = status.status === 'loading' || catalog.status === 'loading'
  const failed = status.status === 'failed' || catalog.status === 'failed'
  const previewTitle = selected === null ? t('preview') : selected.originalAssetId
  const tabs = [
    { value: 'all', label: t('all'), id: 'characters-all', panelId: 'characters-results' },
    { value: 'ancient', label: t('ancient'), id: 'characters-ancient', panelId: 'characters-results' },
    { value: 'urban', label: t('urban'), id: 'characters-urban', panelId: 'characters-results' },
  ] as const
  return <div className={s.page}>
    <section className={s.section}>
      <header className={s.header}>
        <div><h1>{t('title')}</h1><p>{t('description')}</p></div>
        <span className={s.badge}>{t('readOnly')}</span>
      </header>
      <div className={s.toolbar}>
        <SegmentedTabs items={tabs} value={collection} onChange={chooseCollection} label={t('collection')} size="sm" />
        <form className={s.search} onSubmit={(event) => { event.preventDefault(); search() }}>
          <Input icon={<IconSearchOutlineRegular size={16} />} value={draft} maxLength={200} placeholder={t('search')} aria-label={t('search')} onChange={(event) => { setDraft(event.target.value) }} />
          <Button type="submit" variant="outline">{t('searchAction')}</Button>
        </form>
        <Button variant="outline" onClick={refresh}>{t('refresh')}</Button>
      </div>
      {failed && <div className={s.notice} role="alert">{t('failed')}<Button onClick={refresh}>{t('retry')}</Button></div>}
      {status.value?.configured === false && <div className={s.empty}>{t('unavailable')}</div>}
      <div id="characters-results" role="tabpanel" aria-labelledby={`characters-${collection}`} aria-busy={loading}>
        {loading && entries.length === 0 && <div className={s.skeletons} aria-label={t('loading')}><div /><div /><div /><div /></div>}
        {!loading && !failed && status.value?.configured === true && entries.length === 0 && <div className={s.empty}>{t('empty')}</div>}
        {entries.length > 0 && <div className={s.grid}>{entries.map(entry => <CharacterCard
          key={entry.catalogAssetId} entry={entry} revision={revision} useResource={useResource} t={t}
          onOpen={() => { setSelected(entry) }}
        />)}</div>}
      </div>
      {(entries.length > 0 || cursors.length > 0) && <footer className={s.footer}>
        <span>{t('count', { count: entries.length })}</span>
        <div className={s.paging}>
          <Button variant="outline" disabled={cursors.length === 0 || loading} onClick={() => { setCursors(value => value.slice(0, -1)) }}>{t('previous')}</Button>
          <Button variant="outline" disabled={nextCursor == null || loading} onClick={nextCursor == null
            ? undefined : () => { setCursors(value => [...value, nextCursor]) }}>{t('next')}</Button>
        </div>
      </footer>}
    </section>
    <Modal open={selected !== null} onClose={() => { setSelected(null) }} title={previewTitle} closeLabel={t('close')} description={t('referenceOnly')} className={s.modal as string}>
      {preview.status === 'loading' && <div className={s.previewState} aria-label={t('loading')}><IconLoadingOutlineRegular size={24} /></div>}
      {preview.status === 'failed' && <div role="alert" className={s.notice}>{t('previewFailed')}<Button onClick={refresh}>{t('retry')}</Button></div>}
      {preview.value !== undefined && <img className={s.preview} src={preview.value.dataUrl} alt={previewTitle} />}
      {selected !== null && <p className={s.caption}>{[selected.artStyle, ...selected.appearance, ...selected.tags].filter(Boolean).join(' · ')}</p>}
    </Modal>
  </div>
}
