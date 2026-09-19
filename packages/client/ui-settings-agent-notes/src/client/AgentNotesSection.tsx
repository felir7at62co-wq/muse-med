/**
 * Agent Notes Settings page, browser half.
 *
 * Two views over one `agentNotes` Remote namespace: a catalog of the notes
 * under the Host's configured root, grouped by category, and one note opened
 * either as rendered Markdown or as an editor over its raw text.
 *
 * The section adds no outer scroll container: the Settings shell already
 * scrolls its content column (about 564px wide inside the 800px panel), so
 * everything here is a plain stack that grows downward.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AgentNoteSummary, AgentNotesCatalog } from '@deepseek-ai/dsh-api-agent-notes/types'
import { Button, IconSearchOutline16, MarkdownText, Tag, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './AgentNotesSection.module.css'

/** One note's editable payload, as a read returned it. */
export interface AgentNoteDraft {
  /** Note id, exactly as the catalog listed it. */
  readonly id: string
  /** Resolved display title. */
  readonly title: string
  /** Note status, when the note declares one. */
  readonly status?: string
  /** The complete note text on the Host at read time. */
  readonly text: string
  /** Opaque freshness token a save must present. */
  readonly version: string
  /** Byte size of the note at read time. */
  readonly bytes: number
}

/** What one catalog read resolves to, or the failure it reported. */
export type AgentNotesCatalogOutcome =
  | { readonly ok: true; readonly catalog: AgentNotesCatalog }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** What one note read or write resolves to, or the failure it reported. */
export type AgentNoteOutcome =
  | { readonly ok: true; readonly note: AgentNoteDraft }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** What one save resolves to on success. */
export interface AgentNoteSaveSuccess {
  readonly ok: true
  readonly version: string
  readonly bytes: number
}

/** What one save resolves to, or the failure it reported. */
export type AgentNoteSaveOutcome = AgentNoteSaveSuccess | { readonly ok: false; readonly code: string; readonly message: string }

/** Registration-side face the page calls; every method reports failures as values. */
export interface AgentNotesSectionInjected {
  /** Read the current catalog of the Host's configured notes root. */
  list: () => Promise<AgentNotesCatalogOutcome>
  /**
   * Read one note.
   * @param id - note id from the catalog.
   */
  read: (id: string) => Promise<AgentNoteOutcome>
  /**
   * Replace one note's text.
   * @param id - note id from the catalog.
   * @param text - the complete new note text.
   * @param expectedVersion - the version the read returned.
   */
  save: (id: string, text: string, expectedVersion: string) => Promise<AgentNoteSaveOutcome>
}

/** Full component props assembled by the Settings slot renderer. */
export type AgentNotesSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.agentNotes'>
  & InjectFace<AgentNotesSectionInjected>

type Translate = AgentNotesSectionProps['t']

/** Catalog view state. */
type CatalogState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly catalog: AgentNotesCatalog }
  | { readonly status: 'error'; readonly message: string }

/** One open note's view state. */
type OpenState =
  | { readonly status: 'loading'; readonly id: string }
  | { readonly status: 'ready'; readonly note: AgentNoteDraft; readonly text: string }
  | { readonly status: 'error'; readonly id: string; readonly message: string }

/**
 * Human text for one failure.
 *
 * The Host diagnostic is shown as it stands, and a failure that carried none
 * falls back to its stable code, so a new Host failure is visible rather than
 * silently mapped onto an unrelated sentence.
 * @param code - the Remote failure code.
 * @param message - the Host diagnostic.
 * @returns the text to show the user.
 */
function failureText(code: string, message: string): string {
  return message.length > 0 ? message : code
}

/** The trailing path segment of a note id, shown as the row's identity. */
function noteFileName(id: string): string {
  return id.slice(id.lastIndexOf('/') + 1)
}

/** One category group of the catalog. */
interface NoteGroup {
  readonly category: string
  readonly notes: readonly AgentNoteSummary[]
}

/**
 * Group the catalog's notes, preserving the Host's own ordering inside each
 * category. The categories arrive sorted, so insertion order is display order.
 * @param notes - the catalog's notes.
 * @returns the groups in catalog order.
 */
function groupNotes(notes: readonly AgentNoteSummary[]): readonly NoteGroup[] {
  const groups = new Map<string, AgentNoteSummary[]>()
  for (const note of notes) {
    const existing = groups.get(note.category)
    if (existing === undefined) groups.set(note.category, [note])
    else existing.push(note)
  }
  return [...groups].map(([category, rows]) => ({ category, notes: rows }))
}

/** Whether one note matches the normalized query in its title, id, or status. */
function matchesNote(note: AgentNoteSummary, query: string): boolean {
  if (query.length === 0) return true
  return [note.title, note.id, note.status ?? '']
    .some(value => value.toLocaleLowerCase().includes(query))
}

/** Render one open note as Markdown, or as its editor while editing. */
function NoteDetail({ note, text, editing, draft, dirty, saving, failure, t, onDraft, onEdit, onCancel, onSave, onBack }: {
  readonly note: AgentNoteDraft
  readonly text: string
  readonly editing: boolean
  readonly draft: string
  readonly dirty: boolean
  readonly saving: boolean
  readonly failure: string | undefined
  readonly t: Translate
  readonly onDraft: (value: string) => void
  readonly onEdit: () => void
  readonly onCancel: () => void
  readonly onSave: () => void
  readonly onBack: () => void
}): ReactNode {
  const copyLabel = t('copy')
  const copiedLabel = t('copied')
  // Reference-stable per locale revision: a new identity discards the
  // renderer's parse cache.
  const labels = useMemo<MarkdownLabels>(
    () => ({ code: { copyLabel, copiedLabel }, footnotes: t('markdown.footnotes') }),
    [copyLabel, copiedLabel, t],
  )
  return (
    <div className={css.detail}>
      <div className={css.detailHead}>
        <Button variant="ghost" size="sm" onClick={onBack}>{t('back')}</Button>
        <div className={css.detailIdentity}>
          <span className={css.detailTitle}>{note.title}</span>
          <span className={css.detailMeta}>{note.id}</span>
        </div>
        {editing
          ? (
            <>
              <Button variant="primary" size="sm" disabled={saving || !dirty} onClick={onSave}>
                {saving ? t('saving') : t('save')}
              </Button>
              <Button variant="ghost" size="sm" onClick={onCancel}>{t('cancel')}</Button>
            </>
          )
          : <Button variant="outline" size="sm" onClick={onEdit}>{t('edit')}</Button>}
      </div>
      {note.status === undefined ? null : <p className={css.detailStatus}><Tag tone="neutral">{note.status}</Tag></p>}
      {editing && dirty ? <p className={css.dirty} data-dirty="true">{t('dirty')}</p> : null}
      {failure === undefined ? null : <p className={css.failure} role="alert">{failure}</p>}
      {editing
        ? (
          <textarea
            className={css.editor}
            value={draft}
            aria-label={t('editorLabel')}
            spellCheck={false}
            onChange={(event) => { onDraft(event.currentTarget.value) }}
          />
        )
        : <div className={css.markdown}><MarkdownText text={text} labels={labels} /></div>}
    </div>
  )
}

/**
 * Render the Agent Notes page.
 * @param props - composed slot props (see {@link AgentNotesSectionProps}).
 * @returns the settings page element tree.
 */
export function AgentNotesSection(props: AgentNotesSectionProps): ReactNode {
  const { t, list, read, save } = props
  const [reloads, setReloads] = useState(0)
  const [catalog, setCatalog] = useState<CatalogState>({ status: 'loading' })
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<OpenState | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  useEffect(() => {
    let current = true
    setCatalog({ status: 'loading' })
    void list().then((outcome) => {
      if (!current) return
      setCatalog(outcome.ok
        ? { status: 'ready', catalog: outcome.catalog }
        : { status: 'error', message: failureText(outcome.code, outcome.message) })
    })
    return () => { current = false }
  }, [list, reloads, t])

  /** Open one note, replacing any note already open. */
  const openNote = useCallback((id: string) => {
    setFailure(undefined)
    setEditing(false)
    setOpen({ status: 'loading', id })
    void read(id).then((outcome) => {
      setOpen(outcome.ok
        ? { status: 'ready', note: outcome.note, text: outcome.note.text }
        : { status: 'error', id, message: failureText(outcome.code, outcome.message) })
      if (outcome.ok) setDraft(outcome.note.text)
    })
  }, [read, t])

  const closeNote = useCallback(() => {
    setOpen(undefined)
    setEditing(false)
    setFailure(undefined)
  }, [])

  /**
   * Save the open note. A version conflict is a first-class outcome: the newest
   * Host text is reloaded so the next save is accepted, and the editor is left
   * showing the caller's own draft so nothing typed is lost.
   */
  const saveNote = useCallback(() => {
    if (open?.status !== 'ready') return
    setSaving(true)
    setFailure(undefined)
    void save(open.note.id, draft, open.note.version).then((outcome) => {
      setSaving(false)
      if (outcome.ok) {
        setOpen({ status: 'ready', note: { ...open.note, text: draft, version: outcome.version, bytes: outcome.bytes }, text: draft })
        setEditing(false)
        setReloads(value => value + 1)
        return
      }
      if (outcome.code === 'agent-note/stale') {
        setFailure(t('saveStale'))
        void read(open.note.id).then((refreshed) => {
          if (refreshed.ok) setOpen({ status: 'ready', note: refreshed.note, text: refreshed.note.text })
        })
        return
      }
      setFailure(t('savingFailed', { reason: failureText(outcome.code, outcome.message) }))
    })
  }, [draft, open, read, save, t])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const notes = catalog.status === 'ready' ? catalog.catalog.notes : []
  const visible = notes.filter(note => matchesNote(note, normalizedQuery))
  const groups = groupNotes(visible)
  const root = catalog.status === 'ready' ? catalog.catalog.root : ''
  const absent = catalog.status === 'ready' && catalog.catalog.state === 'absent'

  if (open !== undefined) {
    if (open.status === 'loading') return <div className={css.section} aria-busy="true"><p className={css.status}>{t('loading')}</p></div>
    if (open.status === 'error') {
      return (
        <div className={css.section}>
          <div className={css.detailHead}>
            <Button variant="ghost" size="sm" onClick={closeNote}>{t('back')}</Button>
          </div>
          <p className={css.failure} role="alert">{t('readFailed', { reason: open.message })}</p>
        </div>
      )
    }
    return (
      <div className={css.section}>
        <NoteDetail
          note={open.note}
          text={open.text}
          editing={editing}
          draft={draft}
          dirty={draft !== open.note.text}
          saving={saving}
          failure={failure}
          t={t}
          onDraft={setDraft}
          onEdit={() => { setEditing(true) }}
          onCancel={() => { setDraft(open.note.text); setEditing(false); setFailure(undefined) }}
          onSave={saveNote}
          onBack={closeNote}
        />
      </div>
    )
  }

  return (
    <div className={css.section} aria-busy={catalog.status === 'loading'}>
      {catalog.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {catalog.status === 'error' ? (
        <div className={css.failureBlock}>
          <p className={css.failure} role="alert">{t('listFailed', { reason: catalog.message })}</p>
          <Button variant="outline" size="sm" onClick={() => { setReloads(value => value + 1) }}>{t('retry')}</Button>
        </div>
      ) : null}
      {catalog.status === 'ready' ? (
        <>
          <div className={css.toolbar}>
            <label className={css.search}>
              <IconSearchOutline16 aria-hidden="true" />
              <input
                type="search"
                value={query}
                placeholder={t('search')}
                aria-label={t('search')}
                onChange={(event) => { setQuery(event.currentTarget.value) }}
              />
            </label>
            <Button variant="ghost" size="sm" onClick={() => { setReloads(value => value + 1) }}>{t('refresh')}</Button>
          </div>
          <p className={css.root}>
            {`${t('rootLabel')}: ${root}`}
            <span className={css.count}>{` · ${String(notes.length)} ${t('countUnit')}`}</span>
          </p>
          {absent ? <p className={css.status}>{t('missingRoot', { root })}</p> : null}
          {!absent && notes.length === 0 ? <p className={css.status}>{t('empty')}</p> : null}
          {notes.length > 0 && visible.length === 0 ? <p className={css.status}>{t('emptySearch')}</p> : null}
          {catalog.catalog.truncated ? <p className={css.status}>{t('truncated')}</p> : null}
          {groups.map(group => (
            <section key={group.category} className={css.group} data-note-category={group.category}>
              <h3 className={css.groupTitle}>{group.category.length === 0 ? t('categoryOther') : group.category}</h3>
              <ul className={css.list}>
                {group.notes.map(note => (
                  <li key={note.id}>
                    <button
                      type="button"
                      className={css.row}
                      aria-label={t('openNamed', { title: note.title })}
                      onClick={() => { openNote(note.id) }}
                    >
                      <span className={css.rowIdentity}>
                        <span className={css.rowTitle}>{note.title}</span>
                        <span className={css.rowMeta}>{noteFileName(note.id)}</span>
                      </span>
                      {note.status === undefined ? null : <Tag tone="neutral">{note.status}</Tag>}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      ) : null}
    </div>
  )
}
