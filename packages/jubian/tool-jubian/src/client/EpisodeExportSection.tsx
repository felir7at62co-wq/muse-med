/** Explicit episode checks and original-task selection over registration-owned resources. */
import type { ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { EpisodeReadinessInput, EpisodeStatusInput } from '../types.ts'
import type { EpisodeDirectory } from './episode-directory.ts'
import type { RecoverySectionProps } from './VideoRecoverySection.tsx'
import type {} from './episode-resources.ts'
import css from './VideoRecoverySection.module.css'

/** Registration-owned episode interaction source and explicit user actions. */
export interface EpisodeInjected {
  hooks: { episodeState: EpisodeDirectory['state'] }
  setEpisodeText(value: string): void
  checkEpisode(input: EpisodeReadinessInput): void
  loadEpisodeHistory(input: EpisodeReadinessInput): void
  selectEpisodeOriginal(input: EpisodeStatusInput, address: string): void
  refreshEpisode(): void
  admitEpisode(resume?: boolean): Promise<void>
}
/** Same Settings registration's framework hooks and locale. */
export type EpisodeSectionProps = InjectFace<EpisodeInjected> & PropsLocale<'settings.jubian'>
  & Pick<RecoverySectionProps, 'useRecoveryState'> & Pick<PropsRuntime<'settings.section'>, 'useResource'>
const stateKeys = { 'not-admitted': 'episodeNotAdmitted', queued: 'episodeQueued', preparing: 'episodePreparing',
  running: 'episodeRunning', stopping: 'episodeStopping', completed: 'episodeComplete', cancelled: 'episodeCancelled',
  failed: 'episodeFailed', unknown: 'episodeUnknown' } as const

/** Render query facts and explicit export actions; mounting performs no expensive input check.
 * Query and original-selection callbacks are present only for a valid episode number.
 * @param props - Framework resource/state hooks, action callbacks and locale.
 * @returns The episode subsection in the existing Jubian Settings column.
 */
export function EpisodeExportSection({ useEpisodeState, useRecoveryState, useResource, t, setEpisodeText,
  checkEpisode, loadEpisodeHistory, selectEpisodeOriginal, refreshEpisode, admitEpisode }: EpisodeSectionProps): ReactNode {
  const state = useEpisodeState(value => value), recovery = useRecoveryState(value => value)
  const saved = recovery.status?.projectDir ?? '', project = recovery.projectDir.trim() === saved ? saved : ''
  const episode = /^[1-9]\d?$/u.test(state.episodeText) ? Number(state.episodeText) : null
  const available = state.connected && project !== '' && episode !== null && !state.busy
  const ready = useResource<'jubian-episode-readiness'>(state.readinessAddress)
  const history = useResource<'jubian-episode-history'>(state.historyAddress)
  const observed = useResource<'jubian-episode-status'>(state.statusAddress)
  const status = observed.value ?? state.displayedStatus ?? undefined
  const readiness = ready.value ?? state.displayedReadiness ?? undefined
  const historyValue = history.value ?? state.displayedHistory ?? undefined
  const canAdmit = available && state.checked && ready.status === 'live' && readiness?.ready === true
    && readiness.digest !== null && observed.status === 'live' && status?.state === 'not-admitted'
    && status.digest === readiness.digest && (state.target === null || state.target.digest === readiness.digest)
  const canResume = available && state.target !== null && observed.status === 'live' && status?.canResume === true
  const loading = ready.status === 'loading' || history.status === 'loading' || observed.status === 'loading'
  const historyRows = episode === null ? [] : historyValue?.entries.map(entry => <div key={entry.attempt} className={css.report}>
    <code>{t('episodeAttempt', { id: entry.attempt })}</code><code>{t('recoverySha', { hash: entry.digest })}</code>
    <p className={css.line}>{t(entry.recordedState === null ? 'episodeRecordedUnknown' : stateKeys[entry.recordedState])}</p>
    <Button size="sm" variant="outline" disabled={!available || history.status !== 'live' || state.historyAddress === ''}
      onClick={() => { selectEpisodeOriginal({ projectDir: project, episode, digest: entry.digest }, state.historyAddress) }}>{t('episodeSelect')}</Button>
  </div>) ?? []
  return <section className={css.section} aria-label={t('episodeTitle')} aria-busy={state.busy || loading}>
    <h3 className={css.title}>{t('episodeTitle')}</h3>
    <p className={css.line}>{t('episodeHint')}</p>
    <label className={css.field}><span className={css.line}>{t('episodeNumber')}</span>
      <input className={css.input} type="number" inputMode="numeric" min={1} max={99} step={1}
        value={state.episodeText} aria-invalid={episode === null} disabled={state.busy}
        onChange={(event) => { setEpisodeText(event.currentTarget.value) }} /></label>
    {!state.connected && <p className={css.notice}>{t('episodeOffline')}</p>}
    <div className={css.actions}>
      <Button size="sm" variant="outline" disabled={!available}
        onClick={episode === null ? undefined : () => { checkEpisode({ projectDir: project, episode }) }}>{t('episodeCheck')}</Button>
      <Button size="sm" variant="outline" disabled={!available}
        onClick={episode === null ? undefined : () => { loadEpisodeHistory({ projectDir: project, episode }) }}>{t('episodeHistory')}</Button>
    </div>
    {loading && <div className={css.loading}><StateDot state="ongoing" /></div>}
    {ready.status === 'failed' && <p className={css.notice}>{t('episodeCheckFailed')}</p>}
    {readiness !== undefined && <div className={css.feedback}>
      <p className={css.line}>{t(readiness.ready ? 'episodeReady' : 'episodeBlocked')}</p>
      {readiness.issues.map(issue => <p key={issue} className={css.notice}>{issue}</p>)}
    </div>}
    {history.status === 'failed' && <p className={css.notice}>{t('episodeHistoryFailed')}</p>}
    {historyValue !== undefined && <div className={css.feedback} aria-label={t('episodeHistory')}>
      {historyValue.entries.length === 0 && <p className={css.line}>{t('episodeHistoryEmpty')}</p>}
      {historyValue.truncated && <p className={css.notice}>{t('episodeHistoryTruncated')}</p>}
      {historyValue.unreadableRecords > 0 && <p className={css.notice}>{t('episodeHistoryUnreadable', { count: historyValue.unreadableRecords })}</p>}
      {historyRows}
    </div>}
    {observed.status === 'failed' && <p className={css.notice}>{t('episodeStatusFailed')}</p>}
    {status !== undefined && <div className={css.feedback}>
      <p className={css.line} role="status">{t(stateKeys[status.state])}</p>
      {status.attempt !== null && <code>{t('episodeAttempt', { id: status.attempt })}</code>}
      {status.problem !== undefined && <p className={css.notice}>{status.problem}</p>}
      {status.output !== undefined && <>
        <p className={css.line}>{t('episodePublishedReceipt')}</p><code>{status.output.path}</code>
        <code>{t('recoverySha', { hash: status.output.sha256 })}</code>
      </>}
    </div>}
    <div className={css.actions}>
      <Button size="sm" variant="primary" disabled={!canAdmit} onClick={() => { void admitEpisode() }}>{t(state.target === null ? 'episodeExport' : 'episodeRetry')}</Button>
      {status?.canResume === true && <Button size="sm" variant="outline" disabled={!canResume}
        onClick={() => { void admitEpisode(true) }}>{t('episodeResume')}</Button>}
      <Button size="sm" variant="outline" disabled={!available || state.statusAddress === ''}
        onClick={refreshEpisode}>{t('episodeRefresh')}</Button>
    </div>
  </section>
}
