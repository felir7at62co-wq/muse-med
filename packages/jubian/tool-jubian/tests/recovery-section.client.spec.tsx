// @vitest-environment jsdom
/** Recovery reports remain visible through transport loss and explicit actions use the shell notice. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { VideoArtifactSha256, VideoRecoveryDigest, VideoRecoveryReview, VideoRecoveryStatus } from '../src/types.ts'
import { RecoveryDirectory, type RecoveryClient } from '../src/client/recovery-directory.ts'
import { RecoveryToast, VideoRecoverySection, type RecoverySectionProps } from '../src/client/VideoRecoverySection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const hash = brandString<VideoArtifactSha256>('b'.repeat(64))
const report: VideoRecoveryReview = { idempotencyKey: 'original-key', taskId: 42, status: 'awaiting_review',
  digest: brandString<VideoRecoveryDigest>('a'.repeat(64)), decision: null,
  mediaChecks: [{ sha256: 'sha256:' + hash, video: true, audio: true }],
  source: { kind: 'provider', state: 'verified', path: 'video_tasks/review/original-' + hash + '.mp4', sha256: hash } }
const t: RecoverySectionProps['t'] = makeTranslate(en)

function ok<T>(value: T): RemoteResult<T> { return { ok: true, value } }
async function fixture(row = report, overrides: Partial<RecoveryClient> = {},
  statusFields: Partial<VideoRecoveryStatus> = {}, waitForStatus = true) {
  const status: VideoRecoveryStatus = { enabled: true, configurable: true, decoderAvailable: true,
    projectDir: '/project', reports: [row], ...statusFields }
  const api: RecoveryClient = {
    status: vi.fn(async () => ok(status)), configure: vi.fn(async () => ok(status)),
    review: vi.fn(async () => ok<VideoRecoveryReview>({ ...row, decision: 'approve' })),
    adopt: vi.fn(async () => ok(row)), deliverApprovedMp4: vi.fn(async () => ok<VideoRecoveryReview>({ ...row,
      directDelivery: { path: 'exports/approved.mp4', sha256: hash } })), ...overrides,
  }
  const directory = new RecoveryDirectory(), release = directory.connect(api)
  if (waitForStatus) await vi.waitFor(() => { expect(directory.state.getSnapshot().busy).toBe(false) })
  const props: RecoverySectionProps = {
    t, useRecoveryState: bindSnapshotSelector(directory.state),
    setRecoveryProjectDir: (path) => { directory.setProjectDir(path) },
    chooseRecoveryProject: () => directory.chooseProject(), configureRecovery: enabled => directory.configure(enabled),
    refreshRecovery: () => directory.refresh(), openRecoveryAction: (action, current) => { directory.open(action, current) },
    closeRecoveryDialog: () => { directory.closeDialog() }, confirmRecoveryDialog: (id, text) => directory.confirm(id, text),
    deliverRecovery: current => directory.deliver(current),
  }
  const toastProps = { t, useRecoveryNotice: bindSnapshotSelector(directory.notice),
    dismissRecoveryNotice: (sequence: number) => { directory.dismissNotice(sequence) } }
  const view = render(<><VideoRecoverySection {...props} /><RecoveryToast {...toastProps} /></>)
  return { directory, props, toastProps, view, api, release, status }
}

it('retains report rows and disables actions while reconnecting', async () => {
  const f = await fixture()
  expect(screen.getByText('Task 42')).toBeDefined()
  act(() => { f.release() })
  expect(screen.getByText('Task 42')).toBeDefined()
  expect(screen.getByText(en.recoveryOffline)).toBeDefined()
  expect((screen.getByRole<HTMLButtonElement>('button', { name: en.recoveryApprove })).disabled).toBe(true)
  act(() => { f.directory.connect(f.api) })
  await waitFor(() => { expect((screen.getByRole<HTMLButtonElement>('button', { name: en.recoveryApprove })).disabled).toBe(false) })
})

it('shows query failures with retained rows, a Retry action and the Host diagnostic', async () => {
  const f = await fixture()
  vi.mocked(f.api.status).mockResolvedValueOnce({ ok: false,
    error: new RemoteError('jubian-video-recovery/rejected', 'Report directory could not be read', {}) })
  fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.recoveryRefresh }))
  expect(await screen.findByText(en.recoveryQueryFailed)).toBeDefined()
  expect(screen.getByText('Task 42')).toBeDefined()
  expect(screen.getByText('Report directory could not be read')).toBeDefined()
  fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.recoveryRefresh }))
  await waitFor(() => { expect(screen.queryByText(en.recoveryQueryFailed)).toBeNull() })
})

it('identifies the reviewed file and checksum in the decision dialog', async () => {
  await fixture()
  fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.recoveryApprove }))
  const dialog = screen.getByRole('dialog', { name: en.recoveryApprove })
  expect(within(dialog).getByText(report.source.kind === 'none' ? '' : report.source.path)).toBeDefined()
  expect(within(dialog).getByText('SHA-256 ' + hash)).toBeDefined()
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
})

it('labels dismissal as Close while approval is pending and publishes the result after the panel closes', async () => {
  const pending = Promise.withResolvers<RemoteResult<VideoRecoveryReview>>()
  const f = await fixture(report, { review: () => pending.promise })
  fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.recoveryApprove }))
  let dialog = screen.getByRole('dialog', { name: en.recoveryApprove })
  fireEvent.click(within(dialog).getByRole<HTMLButtonElement>('button', { name: en.recoveryApprove }))
  expect(await screen.findByLabelText(en.recoveryWorking)).toBeDefined()
  dialog = screen.getByRole('dialog', { name: en.recoveryApprove })
  expect(within(dialog).getByText(en.recoveryPendingHint)).toBeDefined()
  fireEvent.click(within(dialog).getByText(en.recoveryClose, { exact: true }))
  f.view.rerender(<RecoveryToast {...f.toastProps} />)
  await act(async () => { pending.resolve(ok({ ...report, decision: 'approve' })); await pending.promise })
  expect(await screen.findByText(en.recoveryApprovedNotice)).toBeDefined()
  expect(f.directory.state.getSnapshot().status?.reports[0]?.decision).toBe('approve')
})

it('keeps the Host refusal reason in the global operation failure toast', async () => {
  const f = await fixture(report, { review: async () => ({ ok: false,
    error: new RemoteError('jubian-video-recovery/rejected', 'The reviewed local video is missing', {}) }) })
  fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.recoveryApprove }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole<HTMLButtonElement>('button', { name: en.recoveryApprove }))
  expect(await screen.findByText('Could not complete: The reviewed local video is missing')).toBeDefined()
  expect(screen.getByRole('dialog')).toBeDefined()
  expect(f.directory.state.getSnapshot().status?.reports[0]?.decision).toBeNull()
})

it('does not approve a missing derivative but still permits exact approved-export recovery', async () => {
  const missing: VideoRecoveryReview = { ...report, derivative: { path: 'video_tasks/review/artifact.mp4', sha256: hash },
    source: { kind: 'derivative', state: 'missing', path: 'video_tasks/review/artifact.mp4', sha256: hash } }
  const first = await fixture(missing)
  expect((screen.getByRole<HTMLButtonElement>('button', { name: en.recoveryApprove })).disabled).toBe(true)
  expect(screen.getByText(en.recoverySourceMissing)).toBeDefined()
  first.view.unmount()
  const approved = await fixture({ ...missing, decision: 'approve' })
  const deliver = screen.getByRole<HTMLButtonElement>('button', { name: en.recoveryDeliver })
  expect(deliver.disabled).toBe(false)
  fireEvent.click(deliver)
  expect(await screen.findByText(en.recoveryDelivered)).toBeDefined()
  expect(screen.getByText('exports/approved.mp4')).toBeDefined()
  expect(approved.api.deliverApprovedMp4).toHaveBeenCalledOnce()
})

it('asks for an import path and a reason before submitting either explicit action', async () => {
  const f = await fixture()
  fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.recoveryImport }))
  let dialog = screen.getByRole('dialog')
  let confirm = within(dialog).getByRole<HTMLButtonElement>('button', { name: en.recoveryImport })
  expect(confirm.disabled).toBe(true)
  fireEvent.change(within(dialog).getByRole<HTMLInputElement>('textbox', { name: en.recoveryLocalPath }), { target: { value: 'video_tasks/edit.mp4' } })
  fireEvent.click(confirm)
  await waitFor(() => { expect(f.api.adopt).toHaveBeenCalledOnce() })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.recoveryReject }))
  dialog = screen.getByRole('dialog')
  confirm = within(dialog).getByRole<HTMLButtonElement>('button', { name: en.recoveryReject })
  expect(confirm.disabled).toBe(true)
  fireEvent.change(within(dialog).getByRole<HTMLInputElement>('textbox', { name: en.recoveryReason }), { target: { value: 'Needs another edit' } })
  fireEvent.click(confirm)
  await waitFor(() => { expect(f.api.review).toHaveBeenCalledWith({ idempotencyKey: report.idempotencyKey,
    digest: report.digest, action: 'reject', reason: 'Needs another edit' }) })
})


it('keeps the first pending query visible, then supports empty selection and explicit enable and disable', async () => {
  const pending = Promise.withResolvers<RemoteResult<VideoRecoveryStatus>>()
  const f = await fixture(report, { status: () => pending.promise }, {}, false)
  expect(screen.getByRole('region', { name: en.recoveryTitle }).getAttribute('aria-busy')).toBe('true')
  await act(async () => { pending.resolve(ok({ ...f.status, enabled: false, projectDir: null, reports: [] })); await pending.promise })
  expect(screen.getByText(en.recoveryEmpty)).toBeDefined()
  fireEvent.change(screen.getByRole<HTMLInputElement>('textbox', { name: en.recoveryFolder }), { target: { value: '/new-project' } })
  fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.recoveryEnable }))
  await waitFor(() => { expect(f.api.configure).toHaveBeenCalledWith({ enabled: true, projectDir: '/new-project' }) })
  await waitFor(() => { expect(screen.getByRole('region').getAttribute('aria-busy')).toBe('false') })
  fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.recoveryDisable }))
  await waitFor(() => { expect(f.api.configure).toHaveBeenCalledWith({ enabled: false }) })
})

it('renders nothing before a connection and shows local validation, saved selection and chooser feedback', async () => {
  const f = await fixture()
  const unseen = new RecoveryDirectory()
  f.view.rerender(<VideoRecoverySection {...f.props} useRecoveryState={bindSnapshotSelector(unseen.state)} />)
  expect(screen.queryByRole('region')).toBeNull()
  f.view.rerender(<VideoRecoverySection {...f.props} />)
  act(() => { f.directory.setProjectDir(''); void f.directory.configure(true) })
  expect(screen.getByText(en.recoveryFolderRequired)).toBeDefined()
  expect(screen.getByText('Reports belong to /project')).toBeDefined()
  act(() => { f.directory.offerPicker(async () => '/chosen-project') })
  fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.recoveryChoose }))
  await waitFor(() => { expect((screen.getByRole<HTMLInputElement>('textbox', { name: en.recoveryFolder })).value).toBe('/chosen-project') })
  expect((screen.getByRole<HTMLButtonElement>('button', { name: en.recoveryApprove })).disabled).toBe(true)
})

it('reports unavailable project and decoder facts while retaining reports in a read-only Settings answer', async () => {
  await fixture(report, {}, { configurable: false, decoderAvailable: false, projectProblem: 'unavailable' })
  expect(screen.getByText(en.recoveryProjectUnavailable)).toBeDefined()
  expect(screen.getByText(en.recoveryDecoderUnavailable)).toBeDefined()
  expect((screen.getByRole<HTMLInputElement>('textbox', { name: en.recoveryFolder })).disabled).toBe(true)
  expect((screen.getByRole<HTMLButtonElement>('button', { name: en.recoveryEnable })).disabled).toBe(true)
  expect((screen.getByRole<HTMLButtonElement>('button', { name: en.recoveryImport })).disabled).toBe(true)
})

it('shows failed tracks and an unverifiable source without allowing approval or direct delivery', async () => {
  await fixture({ ...report, status: 'provider_failed', source: { kind: 'none', state: 'unverifiable' },
    mediaChecks: [{ sha256: 'unavailable', video: false, audio: false }] })
  expect(screen.getByText(en.recoveryProviderFailed)).toBeDefined()
  expect(screen.getByText('Video could not be decoded · Audio could not be decoded')).toBeDefined()
  expect(screen.getAllByText(en.recoverySourceUnverifiable)).toHaveLength(2)
  expect(screen.queryByRole('button', { name: en.recoveryApprove })).toBeNull()
  expect(screen.queryByRole('button', { name: en.recoveryDeliver })).toBeNull()
})

it.each(['changed', 'unreadable', 'unmaterialized'] as const)('shows current provider source %s and guards a new approval', async (state) => {
  await fixture({ ...report, source: { kind: 'provider', state, path: 'video_tasks/review/original.mp4', sha256: hash } })
  expect((screen.getByRole<HTMLButtonElement>('button', { name: en.recoveryApprove })).disabled).toBe(state !== 'unmaterialized')
  if (state === 'unmaterialized') {
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.recoveryApprove }))
    expect(within(screen.getByRole('dialog')).getByText(en.recoveryApproveDownloadHint)).toBeDefined()
  }
})

it('requires a reason when reopening a rejected report and removes a second reopen', async () => {
  const rejected: VideoRecoveryReview = { ...report, decision: 'reject', reason: 'Check the transition' }
  const f = await fixture(rejected)
  expect(screen.getByText(en.recoveryRejected)).toBeDefined()
  expect(screen.getByText('Check the transition')).toBeDefined()
  fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.recoveryReopen }))
  const dialog = screen.getByRole('dialog')
  fireEvent.change(within(dialog).getByRole<HTMLInputElement>('textbox', { name: en.recoveryReason }), { target: { value: 'checked again' } })
  fireEvent.click(within(dialog).getByRole<HTMLButtonElement>('button', { name: en.recoveryReopen }))
  await waitFor(() => { expect(f.api.review).toHaveBeenCalledWith({ idempotencyKey: report.idempotencyKey,
    digest: report.digest, action: 'reopen', reason: 'checked again' }) })
  f.view.unmount()
  await fixture({ ...rejected, reopenedFrom: { digest: report.digest, rejectionReason: rejected.reason ?? null, reason: 'Prior reopening' } })
  expect(screen.queryByRole('button', { name: en.recoveryReopen })).toBeNull()
})

it.each(['missing', 'changed', 'unreadable'] as const)('shows an approved export %s without reporting an unverified delivery', async (directDeliveryProblem) => {
  await fixture({ ...report, decision: 'approve', directDeliveryProblem })
  const text = { missing: en.recoveryDeliveryMissing, changed: en.recoveryDeliveryChanged, unreadable: en.recoveryDeliveryUnreadable }
  expect(screen.getByText(text[directDeliveryProblem])).toBeDefined()
  expect(screen.queryByText(en.recoveryDelivered)).toBeNull()
})

it.each([
  { ...report, mediaChecks: [] },
  { ...report, mediaChecks: [report.mediaChecks[0]!, report.mediaChecks[0]!] },
  { ...report, mediaChecks: [{ sha256: 'legacy-unverified', video: true, audio: true }], source: { kind: 'none', state: 'unverifiable' } },
] satisfies VideoRecoveryReview[])('does not offer direct delivery without one captured passing file: %j', async (row) => {
  await fixture({ ...row, decision: 'approve' })
  expect(screen.queryByRole('button', { name: en.recoveryDeliver })).toBeNull()
})

it('dismisses the shell outcome only after the shared Toast finishes', async () => {
  const f = await fixture()
  vi.useFakeTimers()
  try {
    await act(async () => { await f.directory.configure(false) })
    expect(screen.getByText(en.recoveryConfiguredNotice)).toBeDefined()
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(f.directory.notice.getSnapshot().kind).toBeNull()
    expect(screen.queryByText(en.recoveryConfiguredNotice)).toBeNull()
  } finally { f.view.unmount(); vi.useRealTimers() }
})


it('identifies a verified imported file in approval without promising a provider download', async () => {
  await fixture({ ...report, derivative: { path: 'video_tasks/review/imported.mp4', sha256: hash },
    source: { kind: 'derivative', state: 'verified', path: 'video_tasks/review/imported.mp4', sha256: hash } })
  fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: en.recoveryApprove }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText('video_tasks/review/imported.mp4')).toBeDefined()
  expect(within(dialog).queryByText(en.recoveryApproveDownloadHint)).toBeNull()
})
