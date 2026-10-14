/** Props-only browsing of display records with no character binding actions. */
import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconSearchOutlineRegular, Input, Menu, MenuItemButton, Modal, Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { filterLibraryItems, safeLibraryPreviewSrc } from './catalog.ts'
import type { LibraryApprovalStatus, LibraryBrowserResult, LibraryBrowserSource, LibraryCategory, LibraryDisplayItem } from './types.ts'
import type { CharacterLibraryLocaleKey } from './locales.ts'
import css from './CharacterLibraryBody.module.css'

/** Display source and namespace-bound copy supplied by the entry wrapper. */
export interface CharacterLibraryBodyProps {
  /** Explicit read-only source; fixture sources must identify their result. */
  source: LibraryBrowserSource
  /** Typed character library copy. */
  t: TranslateNS<'characterLibrary'>
}

type LoadState = { source: LibraryBrowserSource } & (
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'loaded'; result: LibraryBrowserResult }
)

const categoryKeys = {
  urban: 'category.urban', ancient: 'category.ancient', unknown: 'category.unknown',
} as const satisfies Record<LibraryCategory, CharacterLibraryLocaleKey>
const approvalKeys = {
  pending_review: 'approval.pending_review', approved: 'approval.approved',
  rejected: 'approval.rejected', unknown: 'approval.unknown',
} as const satisfies Record<LibraryApprovalStatus, CharacterLibraryLocaleKey>

/**
 * Browse a read-only catalog, cancelling loads when the source or view changes.
 * @param props - Explicit display source and localized labels.
 * @returns Searchable cards, details, and contained image previews.
 */
export function CharacterLibraryBody({ source, t }: CharacterLibraryBodyProps): ReactNode {
  const [load, setLoad] = useState<LoadState>({ source, phase: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [q, setQ] = useState('')
  const [category, setCategory] = useState<'all' | LibraryCategory>('all')
  const [gender, setGender] = useState<string | undefined>()
  const [style, setStyle] = useState<string | undefined>()
  const [appearance, setAppearance] = useState<string | undefined>()
  const [approvalStatus, setApprovalStatus] = useState<'all' | LibraryApprovalStatus>('all')
  const [selectedId, setSelectedId] = useState<string | undefined>()

  useEffect(() => {
    const controller = new AbortController()
    setLoad({ source, phase: 'loading' })
    setSelectedId(undefined)
    const read = async (): Promise<void> => {
      try {
        const result = await source.load({ signal: controller.signal })
        if (!controller.signal.aborted) setLoad({ source, phase: 'loaded', result })
      } catch (_error) {
        // Source failures use fixed copy; private backend details are not UI data.
        if (!controller.signal.aborted) setLoad({ source, phase: 'error' })
      }
    }
    void read()
    return () => { controller.abort() }
  }, [source, attempt])

  const resetFilters = (): void => {
    setQ('')
    setCategory('all')
    setGender(undefined)
    setStyle(undefined)
    setAppearance(undefined)
    setApprovalStatus('all')
    setSelectedId(undefined)
  }
  const current = load.source === source ? load : { source, phase: 'loading' as const }
  if (current.phase === 'loading') return <div className={css.root} aria-busy="true">
    <p className={css.srOnly} role="status">{t('loading')}</p>
    <ul className={css.cards} aria-hidden="true">
      {[0, 1, 2].map(index => <li key={index} className={clsx(css.card, css.skeleton)}>
        <span className={css.skeletonImage} /><span className={css.skeletonLine} />
      </li>)}
    </ul>
  </div>
  if (current.phase === 'error') return <div className={css.root}>
    <div className={css.state} role="alert"><p>{t('error')}</p><Button variant="outline" size="sm" onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</Button></div>
  </div>
  if (current.result.kind === 'unconfigured') return <div className={css.root}>
    <div className={css.state}><p>{t('unconfigured')}</p><p className={css.secondary}>{t('unconfiguredDescription')}</p></div>
  </div>

  const result = current.result
  const items = filterLibraryItems(result.items, {
    q, category, approvalStatus,
    ...(gender === undefined ? {} : { gender }),
    ...(style === undefined ? {} : { style }),
    ...(appearance === undefined ? {} : { appearance }),
  })
  const selected = items.find(item => item.displayId === selectedId)
  return <section className={css.root} aria-label={t('title')}>
    <div className={css.notices}>
      <Tag tone="neutral">{t('readOnly')}</Tag>
      {result.origin === 'fixture' && <p className={css.fixtureBanner} role="note">{t('fixtureBanner')}</p>}
    </div>
    {selected !== undefined
      ? <CharacterDetails item={selected} t={t} onBack={() => { setSelectedId(undefined) }} />
      : <>
        <div className={css.controls}>
          <Input className={css.search} icon={<IconSearchOutlineRegular size={16} />} aria-label={t('search')} placeholder={t('searchPlaceholder')}
            value={q} onChange={(event) => { setQ(event.target.value) }} />
          <div className={css.filters}>
            <FilterMenu label={t('filter.category')} value={category} t={t} onChange={setCategory}
              options={categoryOptions(t)} />
            <FilterMenu label={t('filter.gender')} value={gender} t={t} onChange={setGender}
              options={valueOptions(result.items.flatMap(item => item.gender === undefined ? [] : [item.gender]), t)} />
            <FilterMenu label={t('filter.style')} value={style} t={t} onChange={setStyle}
              options={valueOptions(result.items.flatMap(item => item.style === undefined ? [] : [item.style]), t)} />
            <FilterMenu label={t('filter.appearance')} value={appearance} t={t} onChange={setAppearance}
              options={valueOptions(result.items.flatMap(item => item.appearanceTags), t)} />
            <FilterMenu label={t('filter.approval')} value={approvalStatus} t={t} onChange={setApprovalStatus}
              options={approvalOptions(t)} />
          </div>
          <p className={css.count} role="status">{t('resultsCount', { count: items.length })}</p>
        </div>
        <div className={css.content}>
          {items.length === 0
            ? <div className={css.state}><p>{t(result.items.length === 0 ? 'empty' : 'noMatches')}</p>
              {result.items.length !== 0 && <Button variant="outline" size="sm" onClick={resetFilters}>{t('resetFilters')}</Button>}
            </div>
            : <ul className={css.cards} aria-label={t('list')}>
              {items.map(item => <li key={item.displayId}>
                <button type="button" className={css.card} aria-label={t('openDetails', { name: item.name })} onClick={() => { setSelectedId(item.displayId) }}>
                  <LibraryImage key={safeLibraryPreviewSrc(item.thumbnailSrc)} src={safeLibraryPreviewSrc(item.thumbnailSrc)}
                    name={item.name} t={t} />
                  <span className={css.cardText}>
                    <span className={css.name}>{item.name}</span><span className={css.secondary}>{item.displayId}</span>
                    <span className={css.badges}><Tag tone="info">{t(categoryKeys[item.category])}</Tag><ApprovalTag status={item.approvalStatus} t={t} /></span>
                    <span className={css.secondary}>{displayValue(item.gender, t)} · {displayValue(item.style, t)}</span>
                    <span className={css.cardAppearance}>{item.appearanceTags.length === 0 ? t('unknown') : item.appearanceTags.map(value => displayValue(value, t)).join(' · ')}</span>
                  </span>
                </button>
              </li>)}
            </ul>}
        </div>
      </>}
  </section>
}

interface FilterOption<Value> { value: Value; label: string }

function FilterMenu<Value extends string | undefined>({ label, value, options, onChange, t }: {
  label: string
  value: Value
  options: readonly FilterOption<Value>[]
  onChange: (value: Value) => void
  t: TranslateNS<'characterLibrary'>
}): ReactNode {
  const [open, setOpen] = useState(false)
  const selected = options.find(option => option.value === value)
  return <Menu open={open} portal autoFocus
    anchor={<Button size="sm" variant="outline" aria-haspopup="menu" aria-expanded={open}
      aria-label={t('filterNamed', { label, value: selected?.label ?? t('all') })} onClick={() => { setOpen(value => !value) }}>
      {label}<span className={css.filterValue}>{selected?.label ?? t('all')}</span><IconChevronDownOutlineRegular size={14} />
    </Button>}
    onClose={() => { setOpen(false) }}>
    {options.map((option, index) => <MenuItemButton key={index}
      onSelect={() => {
        onChange(option.value)
        setOpen(false)
      }}>
      <span className={css.filterOptionLabel}>{option.label}{option.value === value && <IconCheckOutlineRegular size={14} />}</span>
    </MenuItemButton>)}
  </Menu>
}

function categoryOptions(t: TranslateNS<'characterLibrary'>): readonly FilterOption<'all' | LibraryCategory>[] {
  return [{ value: 'all', label: t('all') }, ...(['ancient', 'urban', 'unknown'] as const).map(value => ({ value, label: t(categoryKeys[value]) }))]
}

function approvalOptions(t: TranslateNS<'characterLibrary'>): readonly FilterOption<'all' | LibraryApprovalStatus>[] {
  return [{ value: 'all', label: t('all') }, ...(['pending_review', 'approved', 'rejected', 'unknown'] as const).map(value => ({ value, label: t(approvalKeys[value]) }))]
}

function valueOptions(values: readonly string[], t: TranslateNS<'characterLibrary'>): readonly FilterOption<string | undefined>[] {
  const known = [...new Set(values.filter(value => value.trim() !== '' && value !== 'unknown'))].sort((a, b) => a.localeCompare(b))
  return [{ value: undefined, label: t('all') }, ...known.map(value => ({ value, label: value })), { value: 'unknown', label: t('unknown') }]
}

function displayValue(value: string | undefined, t: TranslateNS<'characterLibrary'>): string {
  return value === undefined || value.trim() === '' || value === 'unknown' ? t('unknown') : value
}

function ApprovalTag({ status, t }: { status: LibraryApprovalStatus; t: TranslateNS<'characterLibrary'> }): ReactNode {
  const tone = status === 'approved' ? 'success' : status === 'rejected' ? 'danger' : status === 'pending_review' ? 'warning' : 'neutral'
  return <Tag tone={tone}>{t(approvalKeys[status])}</Tag>
}

function CharacterDetails({ item, t, onBack }: { item: LibraryDisplayItem; t: TranslateNS<'characterLibrary'>; onBack: () => void }): ReactNode {
  const [preview, setPreview] = useState(false)
  const previewSrc = safeLibraryPreviewSrc(item.previewSrc)
  return <div className={css.content}>
    <Button size="sm" variant="ghost" onClick={onBack}>{t('back')}</Button>
    <article className={css.details} aria-label={t('details')}>
      <h2 className={css.detailName}>{item.name}</h2>
      <div className={css.detailImage}>
        <LibraryImage key={previewSrc} src={previewSrc} name={item.name} t={t} />
        {previewSrc !== undefined && <Button size="sm" variant="outline" onClick={() => { setPreview(true) }}>{t('openPreview', { name: item.name })}</Button>}
      </div>
      <dl className={css.facts}>
        <dt>{t('displayId')}</dt><dd>{item.displayId}</dd>
        <dt>{t('source')}</dt><dd>{displayValue(item.sourceDescription, t)}</dd>
        <dt>{t('filter.category')}</dt><dd>{t(categoryKeys[item.category])}</dd>
        <dt>{t('filter.gender')}</dt><dd>{displayValue(item.gender, t)}</dd>
        <dt>{t('filter.style')}</dt><dd>{displayValue(item.style, t)}</dd>
        <dt>{t('description')}</dt><dd>{displayValue(item.description, t)}</dd>
        <dt>{t('tags')}</dt><dd>{item.tags.length === 0 ? t('unknown') : item.tags.join(' · ')}</dd>
        <dt>{t('appearance')}</dt><dd>{item.appearanceTags.length === 0 ? t('unknown') : item.appearanceTags.map(value => displayValue(value, t)).join(' · ')}</dd>
        <dt>{t('approval')}</dt><dd><ApprovalTag status={item.approvalStatus} t={t} /></dd>
        <dt>{t('binding')}</dt><dd>{t('bindingUnavailable')}</dd>
      </dl>
      <h3 className={css.metadataTitle}>{t('metadata')}</h3>
      {item.metadataSummary.length === 0 ? <p className={css.secondary}>{t('noMetadata')}</p>
        : <dl className={css.facts}>{item.metadataSummary.map((entry, index) => <div className={css.metadataEntry} key={index}>
          <dt>{entry.label}</dt><dd>{entry.value}</dd>
        </div>)}</dl>}
    </article>
    {preview && previewSrc !== undefined && <Modal open title={t('previewTitle', { name: item.name })} closeLabel={t('closePreview')}
      className={clsx(css.previewModal)} onClose={() => { setPreview(false) }}>
      <LibraryImage key={previewSrc} src={previewSrc} name={item.name} t={t} />
    </Modal>}
  </div>
}

function LibraryImage({ src, name, t }: { src: string | undefined; name: string; t: TranslateNS<'characterLibrary'> }): ReactNode {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  return <span className={css.imageFrame}>
    {src !== undefined && state !== 'error' && <img className={css.image} src={src} alt={t('imageAlt', { name })} loading="lazy" decoding="async" referrerPolicy="no-referrer"
      onLoad={() => { setState('ready') }} onError={() => { setState('error') }} />}
    {(src === undefined || state !== 'ready') && <span className={css.imageStatus} role="status">{t(src === undefined ? 'noImage' : state === 'error' ? 'imageError' : 'imageLoading')}</span>}
  </span>
}
