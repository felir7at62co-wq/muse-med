/** Explicit portrait selection and animation generation, isolated from package publication. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarketSectionProps } from './MarketSection.tsx'
import { settleCharacterJob, type CharacterBrief, type CharacterCandidate, type CharacterCandidateId,
  type CharacterGenerationActions, type CharacterJob, type CharacterVersion } from './market-character-generation.ts'
import css from './MarketSection.module.css'
import { MarketCharacter } from './MarketCharacter.tsx'

/** Render the generation workflow; absent adapters remain explicitly unavailable.
 * @param props Frozen author brief, injected provider callbacks and local preview application.
 * @returns Candidate selector, task progress and explicit apply action.
 */
export function MarketCharacterGenerator({ brief, actions, onApply, appliedVersion, reportOutcome, t }: {
  brief: CharacterBrief
  actions?: CharacterGenerationActions | undefined
  onApply: (version: CharacterVersion) => void
  appliedVersion?: CharacterVersion['id'] | undefined
  reportOutcome: MarketSectionProps['reportOutcome']
  t: MarketSectionProps['t']
}): ReactNode {
  const [candidates, setCandidates] = useState<readonly CharacterCandidate[]>([])
  const [selected, setSelected] = useState<CharacterCandidateId>()
  const [version, setVersion] = useState<CharacterVersion>()
  const [phase, setPhase] = useState<'idle' | 'queued' | 'running' | 'failed' | 'stopped'>('idle')
  const [stage, setStage] = useState<'portraits' | 'animation'>('portraits')
  const operation = useRef<AbortController>()
  const candidateGroup = useId()
  const pending = phase === 'queued' || phase === 'running'
  useEffect(() => {
    setCandidates([]); setSelected(undefined); setVersion(undefined); setPhase('idle')
    return () => { operation.current?.abort(); operation.current = undefined }
  }, [actions])
  const candidate = candidates.find(row => row.id === selected)
  const run = async (kind: typeof stage): Promise<void> => {
    if (!actions || operation.current || kind === 'animation' && !candidate) return
    const controller = new AbortController(), signal = controller.signal
    operation.current = controller; setStage(kind); setPhase('queued')
    const current = (): boolean => operation.current === controller && !signal.aborted
    const timeout = setTimeout(() => { controller.abort() }, actions.timeoutMs)
    let onAbort: () => void = () => {}
    try {
      const work = async (): Promise<CharacterJob> => {
        let job: CharacterJob
        if (kind === 'portraits') job = await actions.startPortraits({ ...brief }, signal)
        else {
          if (!candidate) throw new Error('missing-candidate')
          job = await actions.startAnimation(candidate, signal)
        }
        return settleCharacterJob(actions, job, signal, (update) => {
          if (current() && (update.status === 'queued' || update.status === 'running')) setPhase(update.status)
        })
      }
      const interrupted = new Promise<never>((_resolve, reject) => {
        onAbort = () => { reject(new Error('interrupted')) }
        signal.addEventListener('abort', onAbort, { once: true })
      })
      const job = await Promise.race([work(), interrupted])
      if (!current()) return
      if (job.status !== 'succeeded') throw new Error('generation-failed')
      if (job.kind === 'portraits') {
        if (!job.candidates.length) throw new Error('generation-failed')
        setCandidates(job.candidates); setSelected(undefined); setVersion(undefined)
      } else { setVersion(job.version) }
      setPhase('idle'); reportOutcome('characterReady', false)
    } catch (_error) {
      // Provider diagnostics may include private request details; report bounded locale-owned copy.
      if (operation.current === controller) { setPhase('failed'); reportOutcome('characterFailed', true) }
    } finally {
      clearTimeout(timeout); signal.removeEventListener('abort', onAbort)
      if (operation.current === controller) operation.current = undefined
    }
  }
  return <section className={css.generator} aria-label={t('characterGeneration')}>
    <h3>{t('characterGeneration')}</h3>
    <p className={css.previewHint}>{t(!actions ? 'characterUnavailable' : actions.mode === 'preview' ? 'characterDemo' : 'characterConnected')}</p>
    <Button variant="outline" disabled={!actions || pending || !brief.title.trim() || !brief.description.trim() || !brief.role.trim() || !brief.introduction.trim()}
      onClick={() => { void run('portraits') }}>{t(candidates.length ? 'characterRegenerate' : 'characterGenerate')}</Button>
    {pending && <div className={css.generationStatus} role="status"><StateDot state="ongoing" />
      <span>{t(stage === 'portraits' ? 'characterPortraitStep' : 'characterAnimationStep')} · {t(phase === 'queued' ? 'characterQueued' : 'characterRunning')}</span>
      <Button size="sm" onClick={() => {
        const previous = operation.current; operation.current = undefined; previous?.abort(); setPhase('stopped')
      }}>{t('characterStop')}</Button></div>}
    {phase === 'stopped' && <p role="status">{t('characterStopped')}</p>}
    {phase === 'failed' && <div className={css.generationStatus}><p>{t('characterFailureRetained')}</p>
      <Button size="sm" onClick={() => { void run(stage) }}>{t('retry')}</Button></div>}
    {!!candidates.length && <fieldset className={css.candidates} disabled={pending}>
      <legend>{t('characterChoose')}</legend>
      {candidates.map(row => <label key={row.id} className={css.candidate}>
        <input type="radio" name={candidateGroup} value={row.id} checked={selected === row.id} onChange={() => {
          setSelected(row.id); setVersion(undefined); setPhase('idle')
        }} />
        <img src={row.posterUrl} alt={row.role} /><span>{row.role}</span>
      </label>)}
    </fieldset>}
    {candidate && <>
      <p className={css.previewHint}>{t('characterFrozenBrief', { role: candidate.role })}</p>
      <Button disabled={pending} onClick={() => { void run('animation') }}>{t('characterAnimate')}</Button>
    </>}
    {version && <div className={css.generationResult} aria-label={t('characterAnimationPreview')}>
      <MarketCharacter presentation={{ role: version.candidate.role, introduction: version.candidate.introduction,
        posterUrl: version.candidate.posterUrl, characterVersion: version.id, animation: version.animation }}
      introduceLabel={t('introduce')} sampleLabel={t('samplePortrait')} />
      <p>{t('characterResultReady')}</p>
      <Button variant="primary" disabled={pending || appliedVersion === version.id} onClick={() => {
        onApply(version); reportOutcome('characterApplied', false)
      }}>{t(appliedVersion === version.id ? 'characterAppliedLabel' : 'characterApply')}</Button></div>}
  </section>
}
