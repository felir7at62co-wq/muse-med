/** New draft, source import and manuscript download dialogs. */
import { useId, useRef, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { ScriptDraft, ScriptDraftCreateRequest, ScriptDraftExport, ScriptDraftExportRequest, ScriptDraftLayer } from '@deepseek-ai/dsh-workbench-connection/types'
import type { Text } from './Production.tsx'
import { useDraftMutation } from './useDraftMutation.ts'
import data from './DrawerData.module.css'
import css from './DrawerScriptDraft.module.css'
import scripts from './DrawerScripts.module.css'

// Workshop's decoded source limit leaves room for base64 in the transport.
const SOURCE_LIMIT = 4 * 1024 * 1024

function readSource(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string' || !reader.result.includes(',')) {
        reject(new Error('Workshop source was not read'))
        return
      }
      resolve(reader.result.slice(reader.result.indexOf(',') + 1))
    }
    reader.onerror = () => { reject(reader.error) }
    reader.readAsDataURL(file)
  })
}

/**
 * Create a draft with empty episodes or import a bounded source through the Workshop parser.
 * @param props - The creation mode, account action and drawer navigation callbacks.
 * @returns A modal that opens the new draft on success.
 */
export function NewDraft({ mode, t, create, opened, close }: {
  mode: 'blank' | 'file'
  t: Text
  create: (request: ScriptDraftCreateRequest) => Promise<ScriptDraft>
  opened: (draft: ScriptDraft) => void
  close: () => void
}) {
  const id = useId()
  const mutation = useDraftMutation()
  const [title, setTitle] = useState('')
  const [count, setCount] = useState('1')
  const sourceRead = useRef(0)
  const [source, setSource] = useState<ScriptDraftCreateRequest['file']>()
  const [fileProblem, setFileProblem] = useState<'format' | 'read' | null>(null)
  const [reading, setReading] = useState(false)
  // The same action can be retried after an uncertain network response.
  const [requestId, newRequest] = useState(randomUUID)
  const importing = mode === 'file'
  const label = t(importing ? 'importDraft' : 'newDraft')
  const episodeCount = Number(count)
  const validCount = Number.isInteger(episodeCount) && episodeCount >= 1 && episodeCount <= 300
  const ready = title.trim() !== '' && (importing ? source !== undefined : validCount) && !mutation.busy
  const changeInput = () => { newRequest(randomUUID()); mutation.reset() }
  const chooseFile = async (file: File | undefined) => {
    const request = ++sourceRead.current
    setSource(undefined)
    setFileProblem(null)
    setReading(false)
    changeInput()
    if (file === undefined) return
    if (file.size < 1 || file.size > SOURCE_LIMIT || !/\.(docx|txt|md)$/iu.test(file.name)) {
      setFileProblem('format')
      return
    }
    if (!title.trim()) setTitle(file.name.replace(/\.[^.]+$/u, '').slice(0, 200))
    setReading(true)
    try {
      const base64 = await readSource(file)
      if (sourceRead.current === request) setSource({ filename: file.name, base64 })
    } catch (_error) {
      if (sourceRead.current === request) setFileProblem('read')
    } finally {
      if (sourceRead.current === request) setReading(false)
    }
  }
  return <Modal open title={label} closeLabel={t('close')} onClose={() => { if (!mutation.busy) close() }} footer={<>
    <Button size="sm" variant="ghost" disabled={mutation.busy} onClick={close}>{t('cancel')}</Button>
    <Button size="sm" variant="primary" disabled={!ready} type="submit" form={id}>{label}</Button>
  </>}>
    <form id={id} className={css.editor} onSubmit={(event) => {
      event.preventDefault()
      if (!ready) return
      void mutation.run(async () => {
        const request = { title: title.trim(), requestId }
        const draft = await create(source === undefined ? { ...request, episodeCount } : { ...request, file: source })
        opened(draft)
      })
    }}>
      <label className={css.field}>{t('draftName')}
        <Input value={title} maxLength={200} required disabled={mutation.busy}
          onChange={(event) => { setTitle(event.target.value); changeInput() }} />
      </label>
      {importing ? <div className={css.field}>
        <label className={css.field}>{t('draftSource')}
          <input className={css.source} type="file" accept=".docx,.txt,.md" aria-describedby={id + '-source-tip'} disabled={mutation.busy}
            onChange={(event) => { void chooseFile(event.currentTarget.files?.[0]) }} />
        </label>
        <span id={id + '-source-tip'} role={fileProblem === 'format' ? 'alert' : undefined}>{t('draftSourceFormats')}</span>
        {reading && <p className={data.quiet} role="status">{t('loading')}</p>}
      </div> : <label className={css.field}>{t('draftEpisodes')}
        <Input type="number" min={1} max={300} value={count} required disabled={mutation.busy}
          onChange={(event) => { setCount(event.target.value); changeInput() }} />
      </label>}
      {(fileProblem === 'read' || mutation.problem !== null) && <p className={scripts.failed} role="alert">{t('draftCreateFailed')}</p>}
    </form>
  </Modal>
}

function download(file: ScriptDraftExport): void {
  const bytes = Uint8Array.from(atob(file.base64), char => char.charCodeAt(0))
  const href = URL.createObjectURL(new Blob([bytes], { type: file.mime }))
  const link = document.createElement('a')
  link.href = href
  link.download = file.filename
  link.click()
  setTimeout(() => { URL.revokeObjectURL(href) }, 0)
}

const exportKinds = {
  chapters: 'draftChapter', storyboards: 'draftStoryboard', mixed: 'draftMixed', outline: 'draftOutline',
} as const
const exportFormats = { docx: 'Word (.docx)', txt: '.txt', md: 'Markdown (.md)' } as const

/**
 * Download a document of the saved draft or one episode.
 * @param props - The selected episode/layer, account export action and close command.
 * @returns The format, contents and episode scope form.
 */
export function DraftExport({ draftId, episode, layer, t, exportDraft, close }: {
  draftId: number
  episode: number | undefined
  layer: ScriptDraftLayer
  t: Text
  exportDraft: (request: ScriptDraftExportRequest) => Promise<ScriptDraftExport>
  close: () => void
}) {
  const id = useId()
  const mutation = useDraftMutation()
  const [scope, setScope] = useState<'all' | 'episode'>('all')
  const [kind, setKind] = useState<ScriptDraftExportRequest['kind']>(layer === 'chapter' ? 'chapters' : 'storyboards')
  const [format, setFormat] = useState<ScriptDraftExportRequest['format']>('docx')
  const allowsEpisode = episode !== undefined && (kind === 'chapters' || kind === 'storyboards')
  const exportEpisode = allowsEpisode && scope === 'episode' ? episode : undefined
  return <Modal open title={t('exportScriptDraft')} closeLabel={t('close')} onClose={() => { if (!mutation.busy) close() }} footer={<>
    <Button size="sm" variant="ghost" disabled={mutation.busy} onClick={close}>{t('cancel')}</Button>
    <Button size="sm" variant="primary" disabled={mutation.busy} type="submit" form={id}>{t('exportScriptDraft')}</Button>
  </>}>
    <form id={id} className={css.editor} onSubmit={(event) => {
      event.preventDefault()
      void mutation.run(async () => {
        const output = await exportDraft({ draftId, kind, format,
          ...(exportEpisode === undefined ? {} : { episode: exportEpisode }),
        })
        download(output)
        close()
      })
    }}>
      <label className={css.field}>{t('draftExportKind')}
        <select className={css.select} value={kind} disabled={mutation.busy} onChange={(event) => {
          const value = event.target.value
          if (value === 'chapters' || value === 'storyboards' || value === 'mixed' || value === 'outline') setKind(value)
        }}>
          <option value="chapters">{t(exportKinds.chapters)}</option>
          <option value="storyboards">{t(exportKinds.storyboards)}</option>
          <option value="mixed">{t(exportKinds.mixed)}</option>
          <option value="outline">{t(exportKinds.outline)}</option>
        </select>
      </label>
      <label className={css.field}>{t('draftExportEpisodes')}
        <select className={css.select} value={allowsEpisode ? scope : 'all'} disabled={mutation.busy || !allowsEpisode}
          onChange={(event) => { setScope(event.target.value === 'episode' ? 'episode' : 'all') }}>
          <option value="all">{t('all')}</option>
          {allowsEpisode && <option value="episode">{t('episodeNumber', { number: String(episode) })}</option>}
        </select>
      </label>
      <label className={css.field}>{t('draftExportFormat')}
        <select className={css.select} value={format} disabled={mutation.busy} onChange={(event) => {
          const value = event.target.value
          if (value === 'docx' || value === 'txt' || value === 'md') setFormat(value)
        }}>
          <option value="docx">{exportFormats.docx}</option>
          <option value="txt">{exportFormats.txt}</option>
          <option value="md">{exportFormats.md}</option>
        </select>
      </label>
      {mutation.problem !== null && <p className={scripts.failed} role="alert">{t('draftExportFailed')}</p>}
    </form>
  </Modal>
}
