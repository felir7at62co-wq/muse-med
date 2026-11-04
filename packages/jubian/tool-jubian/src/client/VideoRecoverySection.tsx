/** Project-scoped recovery settings and persisted human review. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ApprovedClipDeliveryInput, ApprovedEpisodeDeliverySummary, VideoRecoveryAdoptionInput,
  VideoRecoveryConfigurationInput, VideoRecoveryReview,
  VideoRecoveryReviewInput, VideoRecoveryStatus,
} from '../types.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import css from './JubianTokenSection.module.css'

/** Project recovery operations exposed by the authenticated Host. */
export interface VideoRecoveryControls {
  /** Read saved settings and project reports. */
  status: () => Promise<RemoteResult<VideoRecoveryStatus>>
  /**
   * Save the selected project and enable or disable its worker.
   * @param input - Project selection and desired enabled state.
   * @returns Saved settings and reports.
   */
  configure: (input: VideoRecoveryConfigurationInput) => Promise<RemoteResult<VideoRecoveryStatus>>
  /**
   * Record a human decision against the report shown in the page.
   * @param input - The report key, digest and decision.
   * @returns Host acceptance or refusal.
   */
  review: (input: VideoRecoveryReviewInput) => Promise<RemoteResult<VideoRecoveryReview>>
  /**
   * Import a local derivative into an undecided report.
   * @param input - The report key, digest and project-relative media path.
   * @returns The updated report with its current digest and decode checks.
   */
  adopt: (input: VideoRecoveryAdoptionInput) => Promise<RemoteResult<VideoRecoveryReview>>
  /**
   * Create the editable draft for the approved video.
   * @param input - Report key and approved digest.
   * @returns The updated report with its draft.
   */
  createDraft: (input: ApprovedClipDeliveryInput) => Promise<RemoteResult<VideoRecoveryReview>>
  /**
   * Verify the editor's export against the approved video.
   * @param input - Report key, approved digest and project-relative export path.
   * @returns The updated report with its verified export.
   */
  verifyExport: (input: VideoRecoveryAdoptionInput) => Promise<RemoteResult<VideoRecoveryReview>>
  /**
   * Create the draft and verify its editor export.
   * @param input - Report key and approved digest.
   * @returns The updated report with verified delivery.
   */
  deliverApprovedClip: (input: ApprovedClipDeliveryInput) => Promise<RemoteResult<VideoRecoveryReview>>
  /**
   * Deliver the exact approved MP4 into the project's exports folder.
   * @param input - Report key and approved digest.
   * @returns The updated report with the direct MP4 receipt.
   */
  deliverApprovedMp4: (input: ApprovedClipDeliveryInput) => Promise<RemoteResult<VideoRecoveryReview>>
  /**
   * Render the episode from its current approved project plan.
   * @param input - Episode number and exact plan digest.
   * @returns The updated readiness summary and durable output receipt.
   */
  deliverApprovedEpisode: (input: { episode: number; digest: string }) => Promise<RemoteResult<ApprovedEpisodeDeliverySummary>>
  /** Open the available directory chooser. */
  pickDirectory?: () => Promise<string | null>
}

type RecoveryProps = PropsLocale<'settings.jubian'> & { controls: VideoRecoveryControls }
const actionLabels = {
  approve: 'recoveryApprove',
  reject: 'recoveryReject',
  adopt: 'recoveryImport',
  createDraft: 'recoveryCreateDraft',
  verifyExport: 'recoveryVerifyExport',
} as const
type ReportAction = keyof typeof actionLabels
type DeliveryMethod = 'mp4' | 'jianying'

function remoteValue<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error(result.error.message || result.error.code)
  return result.value
}

function canDeliver(report: VideoRecoveryReview): boolean {
  const [check] = report.mediaChecks
  return report.status === 'awaiting_review' && report.decision === 'approve'
    && report.mediaChecks.length === 1 && check?.video === true && check.audio
    && (report.derivative !== undefined || /^sha256:[a-f0-9]{64}$/.test(check.sha256))
}

function reviewStatus(report: VideoRecoveryReview, t: RecoveryProps['t']): string {
  if (report.decision === 'approve') return t('recoveryApproved')
  if (report.decision === 'reject') return t('recoveryRejected')
  return t(report.status === 'provider_failed' ? 'recoveryProviderFailed' : 'recoveryAwaiting')
}

/**
 * Render the project folder settings and reports for its recovered videos.
 * @param props - Localized copy and authenticated recovery controls.
 * @returns The project recovery controls and report action dialog.
 */
export function VideoRecoverySection({ t, controls }: RecoveryProps): ReactNode {
  const [state, setState] = useState<VideoRecoveryStatus>()
  const [projectDir, setProjectDir] = useState('')
  const [episodeNumber, setEpisodeNumber] = useState<number>()
  const [episodeDelivering, setEpisodeDelivering] = useState(false)
  const [busy, setBusy] = useState(true)
  const [notice, setNotice] = useState<string>()
  const [pending, setPending] = useState<{ action: ReportAction; report: VideoRecoveryReview }>()
  const [reviewError, setReviewError] = useState<string>()
  const [activeDelivery, setActiveDelivery] = useState<{ key: string; method: DeliveryMethod }>()
  const [reviewReason, setReviewReason] = useState('')
  const [mediaPath, setMediaPath] = useState('')

  useEffect(() => {
    let active = true
    setBusy(true)
    void controls.status().then(remoteValue).then((value) => {
      if (!active) return
      setState(value)
      setProjectDir(value.projectDir ?? '')
    }).catch((error: unknown) => {
      if (active) setNotice(error instanceof Error ? error.message : String(error))
    }).finally(() => {
      if (active) setBusy(false)
    })
    return () => { active = false }
  }, [controls])

  async function run(operation: () => Promise<void>, reportError = setNotice): Promise<void> {
    setBusy(true)
    reportError(undefined)
    try {
      await operation()
    } catch (error) {
      reportError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const configure = (enabled: boolean) => run(async () => {
    const value = remoteValue(await controls.configure(enabled
      ? { enabled, projectDir: projectDir.trim() }
      : { enabled }))
    setState(value)
    setProjectDir(value.projectDir ?? '')
  })
  const refresh = () => run(async () => {
    const value = remoteValue(await controls.status())
    setState(value)
    if (state === undefined) setProjectDir(value.projectDir ?? '')
  })
  const selectedEpisode = state?.episodes?.find(row => row.episode === episodeNumber) ?? state?.episodes?.[0]
  const deliverEpisode = async () => {
    if (selectedEpisode?.readiness !== 'ready' || !selectedEpisode.digest) return
    const { episode, digest } = selectedEpisode
    setEpisodeDelivering(true)
    try {
      await run(async () => {
        const result = remoteValue(await controls.deliverApprovedEpisode({ episode, digest }))
        setState(current => current?.episodes === undefined ? current : {
          ...current,
          episodes: current.episodes.map(row => row.episode === episode && row.digest === digest ? result : row),
        })
      })
    } finally {
      setEpisodeDelivering(false)
    }
  }
  const chooseProject = () => run(async () => {
    const path = await controls.pickDirectory?.()
    if (path) setProjectDir(path)
  })
  const requestAction = (action: ReportAction, report: VideoRecoveryReview) => {
    setReviewError(undefined)
    setReviewReason('')
    setMediaPath('')
    setPending({ action, report })
  }
  const reason = reviewReason.trim()
  const needsReason = pending?.action === 'reject'
  const isImport = pending?.action === 'adopt'
  const isExport = pending?.action === 'verifyExport'
  const needsPath = isImport || isExport
  const path = mediaPath.trim()
  const incomplete = (needsReason && !reason) || (needsPath && !path)
  const updateReport = (report: VideoRecoveryReview, saved: VideoRecoveryReview) => {
    setState(current => current && ({
      ...current,
      reports: current.reports.map(row => row.idempotencyKey === report.idempotencyKey && row.digest === report.digest
        ? saved
        : row),
    }))
  }
  const deliver = async (report: VideoRecoveryReview, method: DeliveryMethod) => {
    setActiveDelivery({ key: report.idempotencyKey, method })
    try {
      await run(async () => {
        const input = { idempotencyKey: report.idempotencyKey, digest: report.digest }
        const saved = remoteValue(await (method === 'mp4' ? controls.deliverApprovedMp4(input) : controls.deliverApprovedClip(input)))
        updateReport(report, saved)
      })
    } finally {
      setActiveDelivery(undefined)
    }
  }
  const confirm = () => {
    if (!pending || incomplete) return
    void run(async () => {
      const { action, report } = pending
      const target = { idempotencyKey: report.idempotencyKey, digest: report.digest }
      let result: RemoteResult<VideoRecoveryReview>
      switch (action) {
        case 'adopt':
          result = await controls.adopt({ ...target, path })
          break
        case 'createDraft':
          result = await controls.createDraft(target)
          break
        case 'verifyExport':
          result = await controls.verifyExport({ ...target, path })
          break
        case 'approve':
          result = await controls.review({ ...target, action })
          break
        case 'reject':
          result = await controls.review({ ...target, action, reason })
          break
      }
      updateReport(report, remoteValue(result))
      setPending(undefined)
      if (action === 'approve' || action === 'reject') {
        try { setState(remoteValue(await controls.status())) }
        catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
      }
    }, setReviewError)
  }

  const hasNewFolder = projectDir.trim() !== state?.projectDir
  return (
    <section className={css.recovery} aria-label={t('recoveryTitle')} aria-busy={busy}>
      <h3 className={css.recoveryTitle}>{t('recoveryTitle')}</h3>
      <p className={css.label}>{t('recoveryHint')}</p>
      {!state && busy && <div className={css.recoveryLoading}><StateDot state="ongoing" /></div>}
      {state && (
        <>
          <p className={css.label} role="status">{t(state.enabled ? 'recoveryEnabled' : 'recoveryDisabled')}</p>
          {state.decoderAvailable ? null : <p className={css.notice}>{t('recoveryDecoderUnavailable')}</p>}
          {state.configurable ? null : <p className={css.notice}>{t('recoveryReadOnly')}</p>}
          <label className={css.field}>
            <span className={css.label}>{t('recoveryFolder')}</span>
            <input
              className={css.input}
              type="text"
              value={projectDir}
              disabled={busy || !state.configurable}
              spellCheck={false}
              onChange={(event) => { setProjectDir(event.currentTarget.value) }}
            />
          </label>
        </>
      )}
      <div className={css.actions}>
        {state?.configurable && controls.pickDirectory && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { void chooseProject() }}>
            {t('recoveryChoose')}
          </Button>
        )}
        {state?.configurable && (
          <Button variant="primary" size="sm"
            disabled={busy || !state.decoderAvailable || !projectDir.trim() || (state.enabled && !hasNewFolder)}
            onClick={() => { void configure(true) }}>
            {t('recoveryEnable')}
          </Button>
        )}
        {state?.configurable && state.enabled && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { void configure(false) }}>
            {t('recoveryDisable')}
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { void refresh() }}>
          {t('recoveryRefresh')}
        </Button>
      </div>
      {notice && <p role="alert" className={css.notice}>{t('failed', { reason: notice })}</p>}
      {state?.projectDir && (
        <section className={css.recoveryReport} aria-label={t('episodeDeliveryTitle')}>
          <h4 className={css.recoveryTitle}>{t('episodeDeliveryTitle')}</h4>
          {selectedEpisode ? (
            <>
              <label className={css.field}>
                <span className={css.label}>{t('episodeDeliveryEpisode')}</span>
                <select className={css.input} value={selectedEpisode.episode} disabled={busy}
                  onChange={(event) => { setEpisodeNumber(Number(event.currentTarget.value)) }}>
                  {state.episodes?.map(row => <option key={row.episode} value={row.episode}>
                    {t('episodeDeliveryNumber', { episode: String(row.episode) })}
                  </option>)}
                </select>
              </label>
              <p className={css.label}>{t('episodeDeliveryShots', {
                approved: String(selectedEpisode.approvedShots), total: String(selectedEpisode.totalShots),
              })}</p>
              {selectedEpisode.readiness !== 'ready' && (
                <p className={css.notice}>
                  {t(selectedEpisode.readiness === 'invalid' ? 'episodeDeliveryInvalid' : 'episodeDeliveryIncomplete', {
                    shots: selectedEpisode.missing.join(', '), reason: selectedEpisode.missing.join(' '),
                  })}
                </p>
              )}
              {state.episodeRendererAvailable === false && (
                <p className={css.notice}>{t('episodeRendererUnavailable')}</p>
              )}
              {selectedEpisode.delivery && (
                <>
                  <p className={css.recoveryTitle}>{t('episodeDelivered')}</p>
                  <p className={css.label}>{selectedEpisode.delivery.path}</p>
                  <p className={css.label}>{t('recoveryMp4Digest', { digest: selectedEpisode.delivery.sha256 })}</p>
                  <p className={css.label}>{t('episodeDuration', { seconds: selectedEpisode.delivery.durationSeconds.toFixed(2) })}</p>
                </>
              )}
              <div className={css.actions}>
                <Button variant="primary" size="sm" disabled={busy || state.episodeRendererAvailable === false
                  || selectedEpisode.readiness !== 'ready' || !selectedEpisode.digest}
                onClick={() => { void deliverEpisode() }}>
                  {t('episodeDeliverMp4')}
                </Button>
                {episodeDelivering && <p className={css.label} role="status">{t('episodeDelivering')}</p>}
              </div>
            </>
          ) : <p className={css.label}>{t('episodeDeliveryNoPlan')}</p>}
        </section>
      )}
      {state?.projectDir && (
        <div className={css.recoveryReports}>
          <h4 className={css.recoveryTitle}>{t('recoveryReports')}</h4>
          <p className={css.label}>{state.projectDir}</p>
          {!state.reports.length && <p className={css.label}>{t('recoveryEmpty')}</p>}
          {state.reports.map(report => (
            <article key={report.idempotencyKey} className={css.recoveryReport}>
              <p className={css.recoveryTitle}>{t('recoveryTask', { id: String(report.taskId) })}</p>
              <p className={css.label} role="status">{reviewStatus(report, t)}</p>
              {report.decision === 'reject' && report.reason && (
                <div className={css.field}>
                  <p className={css.label}>{t('recoveryReason')}</p>
                  <p className={css.recoveryReason}>{report.reason}</p>
                </div>
              )}
              {report.derivative && (
                <div className={css.field}>
                  <p className={css.recoveryTitle}>{t('recoveryDerivative')}</p>
                  <p className={css.label}>{report.derivative.path}</p>
                </div>
              )}
              {report.mediaChecks.map((check, index) => (
                <div className={css.field} key={index}>
                  <p className={css.label}>{t('recoveryOutput', { index: String(index + 1) })}</p>
                  <p className={css.label}>{t(check.video ? 'recoveryVideoPass' : 'recoveryVideoFail')}</p>
                  <p className={css.label}>{t(check.audio ? 'recoveryAudioPass' : 'recoveryAudioFail')}</p>
                </div>
              ))}
              {canDeliver(report) && (
                <div className={css.field}>
                  {report.directDelivery && (
                    <>
                      <p className={css.recoveryTitle}>{t('recoveryMp4Delivered')}</p>
                      <p className={css.label}>{report.directDelivery.path}</p>
                      <p className={css.label}>{t('recoveryMp4Digest', { digest: report.directDelivery.sha256 })}</p>
                    </>
                  )}
                  <div className={css.actions}>
                    <Button variant="outline" size="sm" disabled={busy}
                      onClick={() => { void deliver(report, 'mp4') }}>
                      {t('recoveryDeliverMp4')}
                    </Button>
                    {activeDelivery?.key === report.idempotencyKey && activeDelivery.method === 'mp4' && (
                      <p className={css.label} role="status">{t('recoveryDeliveringMp4')}</p>
                    )}
                  </div>
                  {report.delivery && (
                    <>
                      <p className={css.recoveryTitle}>{t('recoveryDraftCreated', { name: report.delivery.draft.name })}</p>
                      <p className={css.label}>{report.delivery.draft.path}</p>
                    </>
                  )}
                  {report.delivery?.export && (
                    <>
                      <p className={css.recoveryTitle}>{t('recoveryExportVerified')}</p>
                      <p className={css.label}>{report.delivery.export.path}</p>
                      <p className={css.label}>{t('recoveryExportSimilarity', {
                        video: String(Math.round(report.delivery.export.videoSimilarity * 100)),
                        audio: String(Math.round(report.delivery.export.audioSimilarity * 100)),
                      })}</p>
                    </>
                  )}
                  {state.automaticExportAvailable && (
                    <div className={css.actions}>
                      <Button variant="primary" size="sm" disabled={busy}
                        onClick={() => { void deliver(report, 'jianying') }}>
                        {t('recoveryDeliverClip')}
                      </Button>
                      {activeDelivery?.key === report.idempotencyKey && activeDelivery.method === 'jianying' && (
                        <p className={css.label} role="status">{t('recoveryDeliveringClip')}</p>
                      )}
                    </div>
                  )}
                  {!report.delivery && (
                    state.draftAvailable ? (
                      <div className={css.actions}>
                        <Button variant="outline" size="sm" disabled={busy}
                          onClick={() => { requestAction('createDraft', report) }}>
                          {t('recoveryCreateDraft')}
                        </Button>
                      </div>
                    ) : <p className={css.label}>{t('recoveryDraftUnavailable')}</p>
                  )}
                  {report.delivery && state.decoderAvailable && (
                    <div className={css.actions}>
                      <Button variant="outline" size="sm" disabled={busy}
                        onClick={() => { requestAction('verifyExport', report) }}>
                        {t('recoveryVerifyExport')}
                      </Button>
                    </div>
                  )}
                </div>
              )}
              {report.status === 'awaiting_review' && report.decision === null && (
                <div className={css.actions}>
                  {!report.derivative && state.decoderAvailable && (
                    <Button variant="outline" size="sm" disabled={busy}
                      onClick={() => { requestAction('adopt', report) }}>
                      {t('recoveryImport')}
                    </Button>
                  )}
                  <Button variant="outline" size="sm" disabled={busy}
                    onClick={() => { requestAction('approve', report) }}>
                    {t('recoveryApprove')}
                  </Button>
                  <Button variant="outline" size="sm" disabled={busy}
                    onClick={() => { requestAction('reject', report) }}>
                    {t('recoveryReject')}
                  </Button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
      {pending && (
        <Modal
          open
          backdropBlur={false}
          onClose={() => { if (!busy) setPending(undefined) }}
          closeLabel={t('recoveryCancel')}
          title={t(actionLabels[pending.action])}
          description={isImport ? t('recoveryImportHint') : isExport ? t('recoveryExportHint')
            : pending.action === 'createDraft' ? t('recoveryDraftHint')
              : t('recoveryConfirmTask', { id: String(pending.report.taskId) })}
          footer={(
            <>
              <Button variant="outline" data-modal-autofocus={needsReason || needsPath ? undefined : true} disabled={busy} onClick={() => { setPending(undefined) }}>{t('recoveryCancel')}</Button>
              <Button variant="primary" disabled={busy || incomplete} onClick={confirm}>{t(isImport ? 'recoveryImportConfirm' : isExport || pending.action === 'createDraft'
                ? actionLabels[pending.action] : 'recoveryConfirm')}</Button>
            </>
          )}
        >
          {needsPath && (
            <label className={css.field}>
              <span className={css.label}>{t(isExport ? 'recoveryExportPath' : 'recoveryLocalPath')}</span>
              <input
                className={css.input}
                type="text"
                data-modal-autofocus
                spellCheck={false}
                required
                disabled={busy}
                value={mediaPath}
                onChange={(event) => { setMediaPath(event.currentTarget.value) }}
              />
            </label>
          )}
          {needsReason && (
            <label className={css.field}>
              <span className={css.label}>{t('recoveryReason')}</span>
              <textarea
                className={css.recoveryReasonInput}
                data-modal-autofocus
                rows={3}
                maxLength={1000}
                required
                disabled={busy}
                value={reviewReason}
                onChange={(event) => { setReviewReason(event.currentTarget.value) }}
              />
            </label>
          )}
          {reviewError && <p role="alert" className={css.notice}>{t('failed', { reason: reviewError })}</p>}
        </Modal>
      )}
    </section>
  )
}
