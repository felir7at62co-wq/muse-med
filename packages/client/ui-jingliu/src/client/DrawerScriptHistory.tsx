/** Review a saved episode revision before restoring it as a new revision. */
import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ScriptDraftHistoryRestore, ScriptDraftHistoryRestoreRequest, ScriptDraftLayer } from '@deepseek-ai/dsh-workbench-connection/types'
import { address, type Read, type Text } from './Production.tsx'
import { StoryboardPreview } from './DrawerScriptStoryboard.tsx'
import { useDraftMutation } from './useDraftMutation.ts'
import data from './DrawerData.module.css'
import css from './DrawerScriptDraft.module.css'
import scripts from './DrawerScripts.module.css'

function dateLabel(date: string | null, t: Text): string {
  const time = date === null ? Number.NaN : Date.parse(date)
  return Number.isFinite(time) ? new Intl.DateTimeFormat(t('numberLocale'), { dateStyle: 'medium', timeStyle: 'short' }).format(time) : ''
}

/**
 * Show the stored history of the active episode layer and restore one selected version on request.
 * @param props - The episode and layer under review, their revision, and the account's data access.
 * @returns The revision list, preview and restore confirmation.
 */
export function DraftHistory({ draftId, episode, layer, baseRevision, epoch, revision, t, useResource, restore, restored, close }: {
  draftId: number
  episode: number
  layer: ScriptDraftLayer
  baseRevision: string
  epoch: number
  revision: number
  t: Text
  useResource: Read
  restore: (request: ScriptDraftHistoryRestoreRequest) => Promise<ScriptDraftHistoryRestore>
  restored: (result: ScriptDraftHistoryRestore) => void
  close: () => void
}) {
  const [selected, select] = useState<number>()
  const [retry, retryReads] = useState(0)
  const mutation = useDraftMutation()
  const params = { id: String(draftId), episode: String(episode), layer, retry: String(retry) }
  const history = useResource<'workshop-draft-history'>(address('workshop-draft-history', epoch, revision, params))
  const entry = useResource<'workshop-draft-history-entry'>(selected === undefined ? 'studio://inactive'
    : address('workshop-draft-history-entry', epoch, revision, { ...params, row: String(selected) }))
  const preview = entry.status === 'live' && entry.value?.id === selected ? entry.value : undefined
  const canRestore = !mutation.busy && mutation.problem !== 'conflict' && preview !== undefined
  const failure = history.status === 'failed' || (selected !== undefined && entry.status === 'failed')
  const label = t('episodeHistory')
  return <Modal open title={label} closeLabel={t('close')} onClose={() => { if (!mutation.busy) close() }} footer={<>
    <Button size="sm" variant="ghost" disabled={mutation.busy} onClick={close}>{t('close')}</Button>
    <Button size="sm" variant="primary" disabled={!canRestore} onClick={() => {
      if (!canRestore) return
      void mutation.run(async () => { restored(await restore({ draftId, episode, layer, historyId: preview.id, baseRevision })) })
    }}>{t('restoreDraftVersion')}</Button>
  </>}>
    <div className={css.editor}>
      <div className={css.episodeBar}>
        <h3>{t('episodeNumber', { number: String(episode) })} · {t(layer === 'chapter' ? 'draftChapter' : 'draftStoryboard')}</h3>
      </div>
      {failure ? <div className={data.failure} role="alert"><span>{t('draftHistoryFailed')}</span>
        <Button variant="ghost" size="sm" onClick={() => { retryReads(value => value + 1) }}>{t('retry')}</Button></div>
        : history.value === undefined ? <p className={data.quiet} role="status">{t('loading')}</p>
          : history.value.items.length === 0 ? <p className={data.quiet}>{t('emptyDraftHistory')}</p>
            : <label className={css.field}>{t('chooseDraftVersion')}
              <select className={css.select} value={selected ?? ''} disabled={mutation.busy} onChange={(event) => {
                select(Number(event.target.value) || undefined)
                if (mutation.problem !== 'conflict') mutation.reset()
              }}>
                <option value="" disabled>{t('chooseDraftVersion')}</option>
                {history.value.items.map(item => <option key={item.id} value={item.id}>
                  {t('versionLabel', { number: item.version })}{item.createdAt ? ` · ${dateLabel(item.createdAt, t)}` : ''}
                </option>)}
              </select>
            </label>}
      {!failure && selected !== undefined && (preview === undefined ? <p className={data.quiet} role="status">{t('loading')}</p>
        : <div className={css.historyPreview}>
          {layer === 'chapter' ? <div className={css.manuscript}>{preview.content || t('nothingHere')}</div>
            : <StoryboardPreview json={preview.content} t={t} />}
        </div>)}
      {mutation.problem !== null && <p role="alert" className={scripts.failed}>{t(mutation.problem === 'conflict' ? 'draftConflict' : 'draftRestoreFailed')}</p>}
    </div>
  </Modal>
}
