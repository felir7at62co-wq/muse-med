/** The asset library tab of the Bot team's details drawer: shared assets by kind, most used first. */
import { useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StudioAsset } from '@deepseek-ai/dsh-jingliu-connection/types'
import { address, Failure, Picture, type Read, type Text } from './Production.tsx'
import css from './DrawerLibrary.module.css'

/** Every kind the library offers, in the order the drawer shows them. */
const KINDS = ['character', 'location', 'prop', 'poster', 'video', 'effect', 'audio', 'sound', 'bgm'] as const
type Kind = typeof KINDS[number]
type Served = 'character' | 'location' | 'prop'
const served = (kind: Kind): kind is Served => kind === 'character' || kind === 'location' || kind === 'prop'
const PAGE = 24

/** What the drawer's owner hands the tab. */
export interface DrawerLibraryProps {
  t: Text
  useResource: Read
  useAccountEpoch<T>(select: (value: number) => T): T
  /** Put text into the message box of the drawer's conversation. */
  compose: (text: string) => void
}

/**
 * Browse the shared asset library inside the Bot team's details drawer.
 * @param props - Library resources scoped to the current login and the conversation's message box.
 * @returns The asset library tab.
 */
export function DrawerLibrary(props: DrawerLibraryProps) {
  const epoch = props.useAccountEpoch(n => n)
  return <Library key={epoch} epoch={epoch} {...props} />
}

function Library({ epoch, t, useResource, compose }: DrawerLibraryProps & { epoch: number }) {
  const [kind, setKind] = useState<Kind>('character')
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [revision, refresh] = useState(0)
  // A search covers every kind; without one the chosen kind is listed.
  const kindOf = query !== '' ? 'all' : served(kind) ? kind : undefined
  const list = useResource<'jingliu-library'>(kindOf === undefined ? 'studio://inactive'
    : address('jingliu-library', epoch, revision, { kind: kindOf, query, offset: String(offset) }))
  const items = kindOf === undefined ? [] : list.value?.items ?? []
  const total = kindOf === undefined ? 0 : list.value?.total ?? 0
  const reference = (asset: StudioAsset) => t('libraryReference', { kind: t(served(asset.kind as Kind) ? asset.kind as Served : 'asset'), name: asset.name })
  const pick = (next: Kind) => { setKind(next); setQuery(''); setDraft(''); setOffset(0) }
  const failed = kindOf !== undefined && (list.status === 'failed' || list.status === 'none')
  const notice = failed ? <Failure t={t} retry={() => { refresh(n => n + 1) }} />
    : kindOf !== undefined && list.status !== 'live' ? <p className={css.quiet}>{t('loading')}</p>
      : items.length === 0 ? <p className={css.quiet}>{t('noneFound')}</p> : null
  return <section className={css.library}>
    <form className={css.search} role="search" onSubmit={(e) => { e.preventDefault(); setQuery(draft.trim()); setOffset(0) }}>
      <Input aria-label={t('searchLibrary')} placeholder={t('searchLibrary')} maxLength={200} value={draft}
        onChange={(e) => { setDraft(e.target.value); if (e.target.value.trim() === '') { setQuery(''); setOffset(0) } }} />
    </form>
    <div className={css.kinds} role="group" aria-label={t('assetType')}>
      {KINDS.map(value => <button key={value} type="button" className={css.kind} aria-pressed={query === '' && kind === value}
        onClick={() => { pick(value) }}>{t(value)}</button>)}
    </div>
    {notice ?? <ul className={css.rows}>{items.map(asset => <li key={asset.id}>
      <button type="button" className={css.row} draggable aria-label={t('libraryRow', { name: asset.name, count: String(asset.uses) })}
        onClick={() => { compose(reference(asset)) }}
        onDragStart={(e) => { e.dataTransfer.setData('text/plain', reference(asset)); e.dataTransfer.effectAllowed = 'copy' }}>
        <span className={css.thumb}><Picture path={asset.thumbnail} epoch={epoch} useResource={useResource} name={asset.name} unavailable={t('imageFailed')} /></span>
        <span className={css.text}>
          <span className={css.head}><strong>{asset.name}</strong>{asset.uses > 0 && <small>{t('usedTimes', { count: String(asset.uses) })}</small>}</span>
          {asset.description && <small className={css.prompt}>{asset.description}</small>}
        </span>
      </button>
    </li>)}</ul>}
    {(total > PAGE || offset > 0) && <div className={css.pages}>
      <Button variant="ghost" size="sm" disabled={offset === 0} onClick={() => { setOffset(n => Math.max(0, n - PAGE)) }}>{t('previous')}</Button>
      <Button variant="ghost" size="sm" disabled={offset + PAGE >= total} onClick={() => { setOffset(n => n + PAGE) }}>{t('next')}</Button>
    </div>}
  </section>
}
