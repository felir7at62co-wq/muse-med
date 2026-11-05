/** Project recovery controls over renderer-bound facts and explicit human actions. */
import { useState, type ReactNode } from 'react'
import { Button, Modal, StateDot, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { VideoRecoveryReview } from '../types.ts'
import type { RecoveryAction, RecoveryDialog, RecoveryNotice, RecoveryState } from './recovery-directory.ts'
import css from './VideoRecoverySection.module.css'

/** Registration-private recovery facts and callbacks; components never receive a Remote service. */
export interface RecoveryInjected {
  hooks: { recoveryState: ObservableSnapshot<RecoveryState> }
  setRecoveryProjectDir(path: string): void
  chooseRecoveryProject(): Promise<void>
  configureRecovery(enabled: boolean): Promise<void>
  refreshRecovery(): Promise<void>
  openRecoveryAction(action: RecoveryAction, report: VideoRecoveryReview): void
  closeRecoveryDialog(): void
  confirmRecoveryDialog(id: number, text: string): Promise<void>
  deliverRecovery(report: VideoRecoveryReview): Promise<void>
}

/** Shell-owned outcome facts supplied independently of the Settings panel. */
export interface RecoveryToastInjected {
  hooks: { recoveryNotice: ObservableSnapshot<RecoveryNotice> }
  dismissRecoveryNotice(sequence: number): void
}

/** Settings sub-section props derived from the same registration's injection and locale. */
export type RecoverySectionProps = InjectFace<RecoveryInjected> & PropsLocale<'settings.jubian'>
type RecoveryToastProps = InjectFace<RecoveryToastInjected> & PropsLocale<'settings.jubian'>
const actionLabels = { approve: 'recoveryApprove', reject: 'recoveryReject', reopen: 'recoveryReopen', adopt: 'recoveryImport' } as const
const sourceLabels = {
  verified: 'recoverySourceVerified', unmaterialized: 'recoverySourceUnmaterialized', missing: 'recoverySourceMissing',
  changed: 'recoverySourceChanged', unreadable: 'recoverySourceUnreadable', unverifiable: 'recoverySourceUnverifiable',
} as const
const deliveryLabels = { missing: 'recoveryDeliveryMissing', changed: 'recoveryDeliveryChanged', unreadable: 'recoveryDeliveryUnreadable' } as const
const noticeLabels = {
  configured: 'recoveryConfiguredNotice', approve: 'recoveryApprovedNotice', reject: 'recoveryRejectedNotice',
  reopen: 'recoveryReopenedNotice', adopt: 'recoveryImportedNotice', delivered: 'recoveryDeliveredNotice',
} as const

/**
 * Keep completed mutation feedback visible after navigation leaves Settings.
 * @param props - Shell notice hook, dismissal callback and localized copy.
 * @returns A shared Toast, or no banner while no outcome is pending.
 */
export function RecoveryToast({ useRecoveryNotice, dismissRecoveryNotice, t }: RecoveryToastProps): ReactNode {
  const notice = useRecoveryNotice(value => value)
  if (notice.kind === null) return null
  const kind = notice.kind
  const failed = kind === 'failed'
  const text = kind === 'failed' ? t('failed', { reason: notice.reason }) : t(noticeLabels[kind])
  return <Toast key={notice.sequence} text={text} onDone={() => { dismissRecoveryNotice(notice.sequence) }}
    {...failed ? {} : { tone: 'success' as const }} />
}

function canDeliver(report: VideoRecoveryReview): boolean {
  const [check] = report.mediaChecks
  return check?.video === true && check.audio && report.mediaChecks.length === 1
    && report.status === 'awaiting_review' && report.decision === 'approve'
    && (report.derivative !== undefined || /^sha256:[a-f0-9]{64}$/u.test(check.sha256))
}

function canApprove(report: VideoRecoveryReview): boolean {
  const [check] = report.mediaChecks
  return check?.video === true && check.audio && report.mediaChecks.length === 1
    && (report.source.state === 'verified' || (report.source.kind === 'provider' && report.source.state === 'unmaterialized'))
}

function SourceDetails({ report, t }: { report: VideoRecoveryReview; t: RecoverySectionProps['t'] }): ReactNode {
  if (report.source.kind === 'none') return <p className={css.notice}>{t('recoverySourceUnverifiable')}</p>
  return <div className={css.feedback}>
    <p className={css.line}>{t(report.source.state === 'verified' ? 'recoveryFile' : 'recoveryExpectedFile')}</p>
    <code>{report.source.path}</code><code>{t('recoverySha', { hash: report.source.sha256 })}</code>
  </div>
}

function statusText(report: VideoRecoveryReview, t: RecoverySectionProps['t']): string {
  if (report.decision === 'approve') return t('recoveryApproved')
  if (report.decision === 'reject') return t('recoveryRejected')
  return t(report.status === 'provider_failed' ? 'recoveryProviderFailed' : 'recoveryAwaiting')
}

type DialogProps = Pick<RecoverySectionProps, 't' | 'confirmRecoveryDialog' | 'closeRecoveryDialog'> & {
  dialog: RecoveryDialog
  busy: boolean
}

function ReviewDialog({ dialog, busy, closeRecoveryDialog, confirmRecoveryDialog, t }: DialogProps): ReactNode {
  const [text, setText] = useState('')
  const needsText = dialog.action !== 'approve'
  const label = t(actionLabels[dialog.action])
  return <Modal open onClose={closeRecoveryDialog} title={label} closeLabel={t('recoveryClose')}
    description={t(busy ? 'recoveryPendingHint' : 'recoveryDialogHint')} footer={<>
      <Button variant="outline" size="sm" onClick={closeRecoveryDialog}>{t(busy ? 'recoveryClose' : 'recoveryCancel')}</Button>
      <Button variant="primary" size="sm" disabled={busy || (needsText && !text.trim())}
        onClick={() => { void confirmRecoveryDialog(dialog.id, text) }}>{label}</Button>
    </>}>
    <p className={css.line}>{t('recoveryTask', { id: dialog.report.taskId })}</p>
    <SourceDetails report={dialog.report} t={t} />
    {dialog.action === 'approve' && dialog.report.source.kind === 'provider'
      && dialog.report.source.state === 'unmaterialized' && <p className={css.notice}>{t('recoveryApproveDownloadHint')}</p>}
    {needsText && <label className={css.field}>
      <span className={css.line}>{t(dialog.action === 'adopt' ? 'recoveryLocalPath' : 'recoveryReason')}</span>
      <input className={css.input} value={text} data-modal-autofocus disabled={busy} spellCheck={false}
        placeholder={dialog.action === 'adopt' ? t('recoveryPathExample') : undefined}
        onChange={(event) => { setText(event.currentTarget.value) }} />
    </label>}
  </Modal>
}

/**
 * Render the selected project's last accepted reports through connection loss and query failures.
 * @param props - Framework-bound recovery facts, explicit callbacks and locale.
 * @returns Project controls, exact report rows and one decision dialog.
 */
export function VideoRecoverySection(props: RecoverySectionProps): ReactNode {
  const { useRecoveryState, t, setRecoveryProjectDir, chooseRecoveryProject, configureRecovery,
    refreshRecovery, openRecoveryAction, closeRecoveryDialog, confirmRecoveryDialog, deliverRecovery } = props
  const state = useRecoveryState(value => value)
  const status = state.status
  if (!state.seen && !state.connected) return null
  const disabled = state.busy || !state.connected
  const selectionChanged = state.projectDir.trim() !== (status?.projectDir ?? '')
  return <section className={css.section} aria-label={t('recoveryTitle')} aria-busy={state.busy}>
    <div className={css.heading}><h3 className={css.title}>{t('recoveryTitle')}</h3>
      {status !== null && state.busy && <span role="status" aria-label={t('recoveryWorking')}><StateDot state="ongoing" /></span>}
    </div>
    <p className={css.line}>{t('recoveryHint')}</p>
    {status === null && state.loading && <div className={css.loading}><StateDot state="ongoing" /></div>}
    {!state.connected && <p className={css.notice} role="status">{t('recoveryOffline')}</p>}
    {state.queryError !== null && <div className={css.feedback} role="status">
      <p className={css.notice}>{t('recoveryQueryFailed')}</p>
      <details><summary>{t('videoErrorDetails')}</summary><p className={css.line}>{state.queryError}</p></details>
    </div>}
    {status !== null && <>
      <p className={css.line} role="status">{t(status.enabled ? 'recoveryEnabled' : 'recoveryDisabled')}</p>
      {selectionChanged && status.projectDir !== null && <p className={css.line}>{t('recoverySavedProject', { path: status.projectDir })}</p>}
      {status.projectProblem !== undefined && <p className={css.notice}>{t('recoveryProjectUnavailable')}</p>}
      {!status.decoderAvailable && <p className={css.notice}>{t('recoveryDecoderUnavailable')}</p>}
    </>}
    <label className={css.field}>
      <span className={css.line}>{t('recoveryFolder')}</span>
      <input className={css.input} value={state.projectDir} disabled={disabled || status?.configurable === false}
        spellCheck={false} aria-invalid={state.fieldError} onChange={(event) => { setRecoveryProjectDir(event.currentTarget.value) }} />
      {state.fieldError && <span className={css.notice}>{t('recoveryFolderRequired')}</span>}
    </label>
    <div className={css.actions}>
      {state.pickerAvailable && <Button variant="outline" size="sm" disabled={disabled}
        onClick={() => { void chooseRecoveryProject() }}>{t('recoveryChoose')}</Button>}
      <Button variant="primary" size="sm"
        disabled={disabled || !status?.configurable || !status.decoderAvailable || !state.projectDir.trim()
          || (status.enabled && !selectionChanged)} onClick={() => { void configureRecovery(true) }}>{t('recoveryEnable')}</Button>
      {status?.enabled && <Button variant="outline" size="sm" disabled={disabled || !status.configurable}
        onClick={() => { void configureRecovery(false) }}>{t('recoveryDisable')}</Button>}
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => { void refreshRecovery() }}>{t('recoveryRefresh')}</Button>
    </div>
    {status?.reports.length === 0 && <p className={css.line}>{t('recoveryEmpty')}</p>}
    {status?.reports.map(report => <article className={css.report} key={report.idempotencyKey}>
      <div className={css.heading}><h4 className={css.reportTitle}>{t('recoveryTask', { id: report.taskId })}</h4>
        <span className={css.line}>{statusText(report, t)}</span></div>
      <p className={css.line}>{t(report.derivative === undefined ? 'recoveryOriginal' : 'recoveryDerivative')}</p>
      {report.mediaChecks.map((check, index) => <p className={css.line} key={check.sha256 + ':' + String(index)}>
        {t(check.video ? 'recoveryVideoOk' : 'recoveryVideoBad')}{' · '}{t(check.audio ? 'recoveryAudioOk' : 'recoveryAudioBad')}
      </p>)}
      <p className={css.notice}>{t(sourceLabels[report.source.state])}</p>
      <details className={css.feedback}><summary>{t('recoveryDetails')}</summary>
        <SourceDetails report={report} t={t} />
        <code>{report.idempotencyKey}</code><code>{report.digest}</code>
      </details>
      {report.reason !== undefined && <p className={css.line}>{report.reason}</p>}
      {report.directDelivery !== undefined && <div className={css.feedback}>
        <p className={css.line}>{t('recoveryDelivered')}</p><code>{report.directDelivery.path}</code>
        <code>{t('recoverySha', { hash: report.directDelivery.sha256 })}</code>
      </div>}
      {report.directDeliveryProblem !== undefined && <p className={css.notice}>{t(deliveryLabels[report.directDeliveryProblem])}</p>}
      <div className={css.actions}>
        {report.status === 'awaiting_review' && report.decision === null && <>
          <Button variant="primary" size="sm" disabled={disabled || selectionChanged || !canApprove(report)}
            onClick={() => { openRecoveryAction('approve', report) }}>{t('recoveryApprove')}</Button>
          <Button variant="outline" size="sm" disabled={disabled || selectionChanged}
            onClick={() => { openRecoveryAction('reject', report) }}>{t('recoveryReject')}</Button>
          {report.derivative === undefined && <Button variant="outline" size="sm"
            disabled={disabled || selectionChanged || !status.decoderAvailable}
            onClick={() => { openRecoveryAction('adopt', report) }}>{t('recoveryImport')}</Button>}
        </>}
        {report.decision === 'reject' && report.reopenedFrom === undefined && <Button variant="outline" size="sm"
          disabled={disabled || selectionChanged} onClick={() => { openRecoveryAction('reopen', report) }}>{t('recoveryReopen')}</Button>}
        {canDeliver(report) && <Button variant="primary" size="sm" disabled={disabled || selectionChanged}
          onClick={() => { void deliverRecovery(report) }}>{t('recoveryDeliver')}</Button>}
      </div>
    </article>)}
    {state.dialog !== null && <ReviewDialog key={state.dialog.id} dialog={state.dialog} busy={state.busy} t={t}
      closeRecoveryDialog={closeRecoveryDialog} confirmRecoveryDialog={confirmRecoveryDialog} />}
  </section>
}
