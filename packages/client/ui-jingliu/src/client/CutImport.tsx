/** Pick a Jingliu episode and explicitly send its available shots to the editor. */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { CutEpisode, CutProject } from '../cut-import-protocol.ts'
import type { CutImportActions } from './cut-import-actions.ts'
import type { CutImportKey } from './locales/cut-import.ts'
import css from './CutImport.module.css'

interface Props {
  frameRef: RefObject<HTMLIFrameElement>
  editorUrl: string
  actions: CutImportActions
  t: (key: CutImportKey) => string
}

/** Render the collapsed import action and its project and episode choices.
 * @param props - Local editor frame, Muse API and translation function.
 * @returns Accessible import controls above the editor.
 */
export function CutImport({ frameRef, editorUrl, actions, t }: Props): ReactNode {
  const controller = useRef<AbortController>()
  const [open, setOpen] = useState(false)
  const [projects, setProjects] = useState<CutProject[]>([])
  const [episodes, setEpisodes] = useState<CutEpisode[]>([])
  const [project, setProject] = useState('')
  const [episode, setEpisode] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  useEffect(() => () => controller.current?.abort(), [])

  async function run(task: (signal: AbortSignal) => Promise<void>) {
    controller.current?.abort()
    const active = new AbortController()
    controller.current = active
    setBusy(true); setStatus('')
    try { await task(active.signal) }
    catch (error) {
      if (!active.signal.aborted) setStatus(t(error instanceof Error && error.message === 'sign-in' ? 'cutSignIn' : 'cutError'))
    } finally { if (!active.signal.aborted) setBusy(false) }
  }

  function toggle() {
    if (open) {
      controller.current?.abort(); setOpen(false); setBusy(false); setStatus(''); return
    }
    setProject(''); setEpisode(''); setProjects([]); setEpisodes([]); setOpen(true)
    void run(async (signal) => {
      const options = await actions.projects(signal)
      if (!signal.aborted) { setProjects(options); if (!options.length) setStatus(t('cutEmpty')) }
    })
  }
  const current = episodes.find(ep => String(ep.order) === episode)
  return <div className={css.bar}>
    <button type="button" aria-expanded={open} onClick={toggle}>{t('cutImport')}</button>
    {open && <>
      <select aria-label={t('cutProject')} value={project} disabled={busy && !projects.length} onChange={(e) => {
        const id = e.currentTarget.value; setProject(id); setEpisode(''); setEpisodes([])
        if (!id) { controller.current?.abort(); setBusy(false); setStatus(''); return }
        void run(async (signal) => {
          const values = await actions.episodes(id, signal)
          if (!signal.aborted) { setEpisodes(values); if (!values.length) setStatus(t('cutEmpty')) }
        })
      }}>
        <option value="">{t('cutProject')}</option>
        {projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
      </select>
      <select aria-label={t('cutEpisode')} value={episode} disabled={!episodes.length || busy} onChange={e => setEpisode(e.currentTarget.value)}>
        <option value="">{t('cutEpisode')}</option>
        {episodes.map(ep => <option key={ep.order} value={String(ep.order)} disabled={!ep.ready}>
          {t('cutEpisode')} {ep.order} · {ep.ready}/{ep.total} {t('cutShots')}
        </option>)}
      </select>
      <button type="button" disabled={busy || !current?.ready} onClick={() => {
        if (!current || !frameRef.current?.contentWindow) return
        const frame = frameRef.current.contentWindow
        void run(async (signal) => {
          await actions.send(frame, editorUrl, project, current.order, signal, (done, total) => setStatus(t('cutProgress') + ' ' + done + '/' + total))
          if (!signal.aborted) { setOpen(false); setStatus(t('cutDone')) }
        })
      }}>{t('cutCreate')}</button>
    </>}
    <span role="status">{status || (busy ? t('cutLoading') : '')}</span>
  </div>
}
