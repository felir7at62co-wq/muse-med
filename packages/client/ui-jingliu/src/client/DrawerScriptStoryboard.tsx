/** Read and edit the Workshop's structured scene rows without rewriting other fields. */
import { useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { Text } from './Production.tsx'
import data from './DrawerData.module.css'
import css from './DrawerScriptDraft.module.css'
import scripts from './DrawerScripts.module.css'

type Scene = Record<string, unknown>
type Key = Parameters<Text>[0]

function record(value: unknown): value is Scene {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parse(json: string): Scene[] | undefined {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) && value.every(record) ? value : undefined
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

function hasUnsafeNumber(rows: Scene[]): boolean {
  const pending: unknown[] = [...rows]
  while (pending.length > 0) {
    const value = pending.pop()
    if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
      return true
    }
    if (Array.isArray(value) || record(value)) {
      for (const member of Object.values(value)) pending.push(member)
    }
  }
  return false
}

function field(row: Scene, key: string): string {
  const value = row[key]
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function cast(row: Scene): string {
  return Array.isArray(row.characters)
    ? row.characters.filter(value => typeof value === 'string').join('、')
    : field(row, 'characters')
}

function label(row: Scene, index: number, t: Text): string {
  const scene = field(row, 'scene_no') || field(row, 'scene')
  return scene ? t('draftSceneNumber', { number: scene }) : t('shotNumber', { index: field(row, 'shot_no') || String(index + 1) })
}

function elementText(el: unknown, t: Text): string {
  if (typeof el === 'string') return el
  if (!record(el)) return ''
  const kind = field(el, 'type')
  if (kind === 'flashback_start' || kind === 'flashback_end') return t(kind === 'flashback_start' ? 'draftFlashbackStart' : 'draftFlashbackEnd')
  const text = field(el, 'content') || field(el, 'dialogue') || field(el, 'line') || field(el, 'text')
  const speaker = field(el, 'character')
  const mode = field(el, 'mode') || field(el, 'parenthetical')
  const action = field(el, 'action')
  const attribution = [speaker, mode && `(${mode})`, action && `【${action}】`].filter(Boolean).join(' ')
  return attribution && text ? `${attribution} · ${text}` : text || attribution
}

function SceneText({ row, t }: { row: Scene; t: Text }) {
  const events = Array.isArray(row.elements) && row.elements.length ? row.elements : Array.isArray(row.lines) ? row.lines : null
  return <>
    {events === null || !Array.isArray(row.elements) || row.elements.length === 0
      ? field(row, 'action') && <p className={css.sceneText}>{field(row, 'action')}</p> : null}
    {events === null ? field(row, 'dialogue') && <p className={css.sceneText}>{field(row, 'dialogue')}</p>
      : <ol className={css.sceneLines}>{events.map((value, index) => {
        const text = elementText(value, t)
        return text && <li key={`${String(index)}:${text}`}>{text}</li>
      })}</ol>}
    {field(row, 'notes') && <p className={css.sceneNote}>{field(row, 'notes')}</p>}
  </>
}

/**
 * Display structured scenes in stored order, including action, dialogue and notes.
 * @param props - The stored JSON and locale reader.
 * @returns Scene cards or a visible empty/invalid state.
 */
export function StoryboardPreview({ json, t }: { json: string; t: Text }) {
  const rows = parse(json)
  if (rows === undefined) return <p className={scripts.failed} role="alert">{t('draftStoryboardInvalid')}</p>
  if (rows.length === 0) return <p className={data.quiet}>{t('emptyStoryboard')}</p>
  return <ol className={css.scenes}>{rows.map((row, index) => {
    const sceneLabel = label(row, index, t)
    const head = [field(row, 'time_loc'), field(row, 'location'), field(row, 'shot_type')].filter(Boolean).join(' · ')
    return <li className={css.scene} key={`${String(index)}:${sceneLabel}`}>
      <header><h4>{sceneLabel}</h4>{head && <span>{head}</span>}</header>
      {cast(row) && <p className={css.sceneNote}>{cast(row)}</p>}
      <SceneText row={row} t={t} />
    </li>
  })}</ol>
}

const sceneFields = [
  ['scene_no', 'draftSceneId'], ['time_loc', 'draftSceneTime'], ['location', 'location'],
  ['shot_type', 'draftShotType'], ['subtitle', 'draftSubtitle'],
] as const satisfies ReadonlyArray<readonly [string, Key]>

interface EditableScene {
  id: string
  data: Scene
}

function makeEditable(data: Scene): EditableScene {
  return { id: randomUUID(), data }
}

function SceneFields({ row, t, busy, change }: { row: Scene; t: Text; busy: boolean; change: (scene: Scene) => void }) {
  const set = (key: string, value: string) => { change({ ...row, [key]: value }) }
  const usesElements = Array.isArray(row.elements) && row.elements.length > 0
  const lines = usesElements && Array.isArray(row.elements) ? row.elements : Array.isArray(row.lines) ? row.lines : null
  const linesKey = usesElements ? 'elements' : 'lines'
  return <>
    <div className={css.sceneFields}>
      {sceneFields.map(([key, title]) => {
        const storedKey = key === 'scene_no' && !('scene_no' in row) && 'scene' in row ? 'scene' : key
        return <label className={css.field} key={key}>{t(title)}
          <Input value={field(row, storedKey)} disabled={busy} onChange={(event) => { set(storedKey, event.target.value) }} />
        </label>
      })}
      <label className={css.field}>{t('character')}
        <Input defaultValue={cast(row)} disabled={busy} onChange={(event) => {
          change({ ...row, characters: event.target.value.split(/[、,，]/u).map(value => value.trim()).filter(Boolean) })
        }} />
      </label>
    </div>
    {!usesElements && <label className={css.field}>{t('draftSceneAction')}
      <textarea className={css.sceneInput} rows={3} value={field(row, 'action')} disabled={busy}
        onChange={(event) => { set('action', event.target.value) }} />
    </label>}
    {lines === null ? <label className={css.field}>{t('draftSceneDialogue')}
      <textarea className={css.sceneInput} rows={3} value={field(row, 'dialogue')} disabled={busy}
        onChange={(event) => { set('dialogue', event.target.value) }} />
    </label> : <div className={css.sceneElements}>
      {lines.map((line, index) => <SceneLine key={index} value={line} t={t} busy={busy}
        update={(value) => { change({ ...row, [linesKey]: lines.map((item, offset) => offset === index ? value : item) }) }} />)}
      <div className={css.controls}>
        {usesElements && <Button variant="ghost" size="sm" disabled={busy} onClick={() => {
          change({ ...row, elements: [...lines, { type: 'action', content: '' }] })
        }}>{t('addSceneAction')}</Button>}
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => {
          change({ ...row, [linesKey]: [...lines, { type: 'dialogue', character: '', content: '' }] })
        }}>{t('addSceneDialogue')}</Button>
      </div>
    </div>}
    <label className={css.field}>{t('draftSceneNotes')}
      <textarea className={css.sceneInput} rows={2} value={field(row, 'notes')} disabled={busy}
        onChange={(event) => { set('notes', event.target.value) }} />
    </label>
  </>
}

function SceneLine({ value, t, busy, update }: { value: unknown; t: Text; busy: boolean; update: (line: unknown) => void }) {
  if (typeof value === 'string') return <label className={css.field}>{t('draftSceneDialogue')}
    <textarea className={css.sceneInput} rows={2} value={value} disabled={busy} onChange={(event) => { update(event.target.value) }} />
  </label>
  if (!record(value)) return null
  const kind = field(value, 'type')
  if (kind && kind !== 'action' && kind !== 'dialogue') return <p className={css.sceneNote}>{elementText(value, t)}</p>
  const contentKey = ['content', 'dialogue', 'line', 'text'].find(key => key in value) ?? 'content'
  return <div className={css.sceneLine}>
    {kind !== 'action' && <label className={css.field}>{t('draftSpeaker')}
      <Input value={field(value, 'character')} disabled={busy} onChange={(event) => { update({ ...value, character: event.target.value }) }} />
    </label>}
    <label className={css.field}>{t(kind === 'action' ? 'draftSceneAction' : 'draftSceneDialogue')}
      <textarea className={css.sceneInput} rows={2} value={field(value, contentKey)} disabled={busy}
        onChange={(event) => { update({ ...value, [contentKey]: event.target.value }) }} />
    </label>
  </div>
}

/**
 * Edit the current structured episode on a separate local copy until save.
 * @param props - The stored JSON, locale, mutation status, and editor actions.
 * @returns Scene forms and the episode save/cancel controls.
 */
export function StoryboardEditor({ json, t, busy, blocked, cancel, save }: {
  json: string
  t: Text
  busy: boolean
  blocked: boolean
  cancel: () => void
  save: (json: string) => void
}) {
  const [source] = useState(() => {
    const saved = parse(json)
    if (saved === undefined) return { rows: [], problem: 'draftStoryboardInvalid' } as const
    if (hasUnsafeNumber(saved)) return { rows: [], problem: 'draftStoryboardUnsafeNumbers' } as const
    return { rows: saved.map(makeEditable), serialized: JSON.stringify(saved), problem: null }
  })
  const [rows, setRows] = useState<EditableScene[]>(() => [...source.rows])
  if (source.problem !== null) return <>
    <p className={scripts.failed} role="alert">{t(source.problem)}</p>
    <Button variant="ghost" size="sm" onClick={cancel}>{t('cancel')}</Button>
  </>
  const revised = JSON.stringify(rows.map(row => row.data))
  const canSave = revised !== source.serialized && !busy && !blocked
  return <form className={css.editor} onSubmit={(event) => { event.preventDefault(); if (canSave) save(revised) }}>
    <ol className={css.scenes}>{rows.map((row, index) => <li className={css.scene} key={row.id}>
      <header><h4>{label(row.data, index, t)}</h4>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setRows(rows.filter(item => item.id !== row.id)) }}>{t('removeDraftScene')}</Button>
      </header>
      <SceneFields row={row.data} t={t} busy={busy} change={(value) => {
        setRows(rows.map(item => item.id === row.id ? { ...item, data: value } : item))
      }} />
    </li>)}</ol>
    <div className={css.sceneToolbar}>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => {
        const numbers = rows.map(row => Number(field(row.data, 'shot_no'))).filter(Number.isSafeInteger)
        const highest = numbers.reduce((maximum, number) => Math.max(maximum, number), rows.length)
        let number = highest < Number.MAX_SAFE_INTEGER ? highest + 1 : rows.length + 1
        if (highest === Number.MAX_SAFE_INTEGER) {
          const occupied = new Set(numbers)
          while (occupied.has(number)) number += 1
        }
        setRows([...rows, makeEditable({ shot_no: number, action: '', dialogue: '' })])
      }}>{t('addDraftScene')}</Button>
      <div className={css.controls}>
        <Button variant="ghost" size="sm" disabled={busy} onClick={cancel}>{t('cancel')}</Button>
        <Button variant="primary" size="sm" type="submit" disabled={!canSave}>{t('save')}</Button>
      </div>
    </div>
  </form>
}
