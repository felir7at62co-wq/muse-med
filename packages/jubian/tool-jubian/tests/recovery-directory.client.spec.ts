/** Current connection, project and dialog identities fence every asynchronous completion. */
import { expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { VideoArtifactSha256, VideoRecoveryDigest, VideoRecoveryReview, VideoRecoveryStatus } from '../src/types.ts'
import { RecoveryDirectory, type RecoveryClient } from '../src/client/recovery-directory.ts'

const digest = brandString<VideoRecoveryDigest>('a'.repeat(64))
const report: VideoRecoveryReview = { idempotencyKey: 'original', digest, taskId: 42, status: 'awaiting_review',
  mediaChecks: [{ sha256: 'sha256:' + 'b'.repeat(64), video: true, audio: true }],
  source: { kind: 'provider', state: 'unmaterialized', path: 'video_tasks/review/original.mp4',
    sha256: brandString<VideoArtifactSha256>('b'.repeat(64)) }, decision: null }
const status: VideoRecoveryStatus = { enabled: false, configurable: true, decoderAvailable: true,
  projectDir: '/project', reports: [report] }

function ok<T>(value: T): RemoteResult<T> { return { ok: true, value } }
function client(overrides: Partial<RecoveryClient> = {}): RecoveryClient {
  return { status: vi.fn(async () => ok(status)), configure: vi.fn(async () => ok({ ...status, enabled: true })),
    review: vi.fn(async () => ok<VideoRecoveryReview>({ ...report, decision: 'approve' })), adopt: vi.fn(async () => ok(report)),
    deliverApprovedMp4: vi.fn(async () => ok<VideoRecoveryReview>({ ...report, decision: 'approve' })), ...overrides }
}
async function loaded(directory: RecoveryDirectory, api = client()): Promise<() => void> {
  const release = directory.connect(api)
  await vi.waitFor(() => { expect(directory.state.getSnapshot().busy).toBe(false) })
  return release
}

it('keeps accepted rows during connection loss and refuses a late old read', async () => {
  const directory = new RecoveryDirectory(), first = await loaded(directory)
  const pending = Promise.withResolvers<RemoteResult<VideoRecoveryStatus>>()
  first()
  const old = directory.connect(client({ status: () => pending.promise }))
  expect(directory.state.getSnapshot().status?.reports).toEqual([report])
  old()
  expect(directory.state.getSnapshot()).toMatchObject({ connected: false, status: { reports: [report] } })
  const current = { ...status, enabled: true, projectDir: '/new-project', reports: [] }
  await loaded(directory, client({ status: async () => ok(current) }))
  pending.resolve(ok({ ...status, projectDir: '/stale' }))
  await pending.promise
  expect(directory.state.getSnapshot().status).toEqual(current)
  first()
  expect(directory.state.getSnapshot().connected).toBe(true)
})

it('retains rows and the query diagnostic until a successful refresh', async () => {
  const directory = new RecoveryDirectory(), api = client()
  await loaded(directory, api)
  vi.mocked(api.status).mockResolvedValueOnce({ ok: false, error: new RemoteError('jubian-video-recovery/rejected', 'report is unreadable', {}) })
  await directory.refresh()
  expect(directory.state.getSnapshot()).toMatchObject({ queryError: 'report is unreadable', status: { reports: [report] } })
  expect(directory.notice.getSnapshot().kind).toBeNull()
  await directory.refresh()
  expect(directory.state.getSnapshot().queryError).toBeNull()
})

it('retires picker completions on a new project selection or picker scope', async () => {
  const directory = new RecoveryDirectory()
  await loaded(directory)
  const pick = Promise.withResolvers<string | null>()
  const first = directory.offerPicker(() => pick.promise)
  const choosing = directory.chooseProject()
  directory.setProjectDir('/typed-project')
  pick.resolve('/late-project')
  await choosing
  expect(directory.state.getSnapshot().projectDir).toBe('/typed-project')
  const second = directory.offerPicker(async () => '/current-picker')
  first()
  expect(directory.state.getSnapshot().pickerAvailable).toBe(true)
  await directory.chooseProject()
  expect(directory.state.getSnapshot()).toMatchObject({ projectDir: '/current-picker', busy: false })
  second()
  expect(directory.state.getSnapshot().pickerAvailable).toBe(false)
})

it('does not commit a picker result after its connection disappears', async () => {
  const directory = new RecoveryDirectory(), release = await loaded(directory)
  const pick = Promise.withResolvers<string | null>()
  directory.offerPicker(() => pick.promise)
  const choosing = directory.chooseProject()
  release()
  pick.resolve('/old-connection')
  await choosing
  expect(directory.state.getSnapshot().projectDir).toBe('/project')
})

it.each(['configure', 'adopt', 'deliver'] as const)('ignores a retired connection completion for %s', async (method) => {
  const directory = new RecoveryDirectory()
  const pending = Promise.withResolvers<RemoteResult<VideoRecoveryStatus & VideoRecoveryReview>>()
  const api = client({ configure: () => pending.promise, adopt: () => pending.promise, deliverApprovedMp4: () => pending.promise })
  const release = await loaded(directory, api)
  let operation: Promise<void>
  if (method === 'configure') operation = directory.configure(true)
  else if (method === 'deliver') operation = directory.deliver(report)
  else {
    directory.open('adopt', report)
    operation = directory.confirm(directory.state.getSnapshot().dialog!.id, 'video_tasks/edit.mp4')
  }
  release()
  const next = { ...status, reports: [], projectDir: '/next' }
  await loaded(directory, client({ status: async () => ok(next) }))
  pending.resolve(ok({ ...status, ...report, projectDir: '/stale' }))
  await operation
  expect(directory.state.getSnapshot().status).toEqual(next)
  expect(directory.notice.getSnapshot().kind).toBeNull()
})

it('preserves the Host failure diagnostic in a shell-owned mutation notice', async () => {
  const directory = new RecoveryDirectory()
  await loaded(directory, client({ review: async () => ({ ok: false,
    error: new RemoteError('jubian-video-recovery/rejected', 'The approval belongs to another version', {}) }) }))
  directory.open('approve', report)
  await directory.confirm(directory.state.getSnapshot().dialog!.id, '')
  expect(directory.notice.getSnapshot()).toMatchObject({ kind: 'failed', reason: 'The approval belongs to another version' })
  expect(directory.state.getSnapshot().dialog).not.toBeNull()
  expect(directory.state.getSnapshot().status?.reports[0]?.decision).toBeNull()
})

it('closing a pending dialog does not imply cancellation or hide its saved result and toast', async () => {
  const directory = new RecoveryDirectory(), pending = Promise.withResolvers<RemoteResult<VideoRecoveryReview>>()
  await loaded(directory, client({ review: () => pending.promise }))
  directory.open('approve', report)
  const operation = directory.confirm(directory.state.getSnapshot().dialog!.id, '')
  expect(directory.state.getSnapshot().busy).toBe(true)
  directory.closeDialog()
  pending.resolve(ok<VideoRecoveryReview>({ ...report, decision: 'approve' }))
  await operation
  expect(directory.state.getSnapshot()).toMatchObject({ dialog: null, busy: false, status: { reports: [{ decision: 'approve' }] } })
  const notice = directory.notice.getSnapshot()
  expect(notice.kind).toBe('approve')
  directory.dismissNotice(notice.sequence - 1)
  expect(directory.notice.getSnapshot().kind).toBe('approve')
  directory.dismissNotice(notice.sequence)
  expect(directory.notice.getSnapshot().kind).toBeNull()
})

it.each(['configure', 'query'] as const)('keeps a newer project draft when an earlier %s finishes', async (method) => {
  const directory = new RecoveryDirectory(), pending = Promise.withResolvers<RemoteResult<VideoRecoveryStatus>>()
  const api = client({ configure: () => pending.promise })
  await loaded(directory, api)
  if (method === 'query') vi.mocked(api.status).mockImplementationOnce(() => pending.promise)
  const save = method === 'query' ? directory.refresh() : directory.configure(true)
  expect(directory.state.getSnapshot().loading).toBe(method === 'query')
  directory.setProjectDir('/next-project')
  expect(directory.state.getSnapshot()).toMatchObject({ busy: false, loading: false })
  pending.resolve(ok({ ...status, enabled: true }))
  await save
  expect(directory.state.getSnapshot()).toMatchObject({ projectDir: '/next-project', status: { enabled: false }, busy: false, loading: false })
  expect(directory.notice.getSnapshot().kind).toBeNull()
})

it('retiring the registration prevents all outstanding work from publishing into its former view', async () => {
  const directory = new RecoveryDirectory(), pending = Promise.withResolvers<RemoteResult<VideoRecoveryStatus>>()
  const api = client({ status: () => pending.promise })
  directory.connect(api)
  directory.dispose()
  const state = directory.state.getSnapshot()
  pending.resolve(ok(status))
  await pending.promise
  await directory.configure(true)
  directory.setProjectDir('/retired')
  directory.offerPicker(async () => '/retired')
  expect(directory.state.getSnapshot()).toBe(state)
  expect(directory.notice.getSnapshot().kind).toBeNull()
})


it('validates an empty project locally and disables recovery without resubmitting the draft path', async () => {
  const directory = new RecoveryDirectory(), api = client()
  await loaded(directory, api)
  directory.setProjectDir('  ')
  await directory.configure(true)
  expect(directory.state.getSnapshot().fieldError).toBe(true)
  expect(api.configure).not.toHaveBeenCalled()
  await directory.configure(false)
  expect(api.configure).toHaveBeenCalledWith({ enabled: false })
  expect(directory.state.getSnapshot().fieldError).toBe(true)
})

it('does not choose without a picker, and a cancelled picker keeps the current project', async () => {
  const directory = new RecoveryDirectory()
  await loaded(directory)
  await directory.chooseProject()
  directory.offerPicker(async () => null)
  await directory.chooseProject()
  expect(directory.state.getSnapshot()).toMatchObject({ projectDir: '/project', busy: false })
  expect(directory.notice.getSnapshot().kind).toBeNull()
})

it('retires an old outstanding picker when the capability offers a replacement', async () => {
  const directory = new RecoveryDirectory(), first = Promise.withResolvers<string | null>()
  await loaded(directory)
  const release = directory.offerPicker(() => first.promise)
  const choosing = directory.chooseProject()
  directory.offerPicker(async () => '/replacement')
  release()
  first.resolve('/old-picker')
  await choosing
  expect(directory.state.getSnapshot().projectDir).toBe('/project')
  await directory.chooseProject()
  expect(directory.state.getSnapshot().projectDir).toBe('/replacement')
})

it('rejects stale dialog identities and report versions without making an RPC', async () => {
  const directory = new RecoveryDirectory(), api = client()
  await loaded(directory, api)
  directory.open('approve', report)
  const old = directory.state.getSnapshot().dialog!.id
  directory.closeDialog()
  directory.open('reject', report)
  await directory.confirm(old, '')
  await directory.deliver({ ...report, digest: brandString<VideoRecoveryDigest>('c'.repeat(64)) })
  directory.open('approve', { ...report, idempotencyKey: 'another-key' })
  expect(directory.state.getSnapshot().dialog?.action).toBe('reject')
  expect(api.review).not.toHaveBeenCalled()
  expect(api.deliverApprovedMp4).not.toHaveBeenCalled()
  directory.closeDialog()
  await directory.confirm(old, '')
})

it('suppresses a second operation while busy and changes only the matching report on review', async () => {
  const directory = new RecoveryDirectory(), pending = Promise.withResolvers<RemoteResult<VideoRecoveryReview>>()
  const another: VideoRecoveryReview = { ...report, idempotencyKey: 'another-key' }
  const api = client({ status: async () => ok({ ...status, reports: [report, another] }), review: () => pending.promise })
  await loaded(directory, api)
  directory.open('reopen', report)
  const operation = directory.confirm(directory.state.getSnapshot().dialog!.id, '  checked again  ')
  await directory.configure(true)
  await directory.refresh()
  directory.open('reject', another)
  expect(api.configure).not.toHaveBeenCalled()
  pending.resolve(ok<VideoRecoveryReview>({ ...report, decision: 'approve' }))
  await operation
  expect(directory.state.getSnapshot().status?.reports).toEqual([{ ...report, decision: 'approve' }, another])
})

it.each(['success', 'failure'] as const)('ignores a retired review %s without publishing another connection notice', async (result) => {
  const directory = new RecoveryDirectory(), pending = Promise.withResolvers<RemoteResult<VideoRecoveryReview>>()
  const release = await loaded(directory, client({ review: () => pending.promise }))
  directory.open('approve', report)
  const reviewing = directory.confirm(directory.state.getSnapshot().dialog!.id, '')
  release()
  await loaded(directory, client({ status: async () => ok({ ...status, reports: [] }) }))
  if (result === 'success') pending.resolve(ok(report))
  else pending.reject(new Error('Old connection failed'))
  await reviewing
  expect(directory.state.getSnapshot().status?.reports).toEqual([])
  expect(directory.notice.getSnapshot().kind).toBeNull()
})

it('keeps plain rejected values and an empty wire message actionable', async () => {
  const directory = new RecoveryDirectory(), api = client()
  await loaded(directory, api)
  vi.mocked(api.status).mockRejectedValueOnce('Local query is unavailable')
  await directory.refresh()
  expect(directory.state.getSnapshot().queryError).toBe('Local query is unavailable')
  vi.mocked(api.configure).mockRejectedValueOnce('Settings file is occupied')
  await directory.configure(true)
  expect(directory.notice.getSnapshot()).toMatchObject({ kind: 'failed', reason: 'Settings file is occupied' })
  vi.mocked(api.configure).mockResolvedValueOnce({ ok: false,
    error: new RemoteError('jubian-video-recovery/rejected', '', {}) })
  await directory.configure(false)
  expect(directory.notice.getSnapshot()).toMatchObject({ kind: 'failed', reason: 'jubian-video-recovery/rejected' })
})

it('keeps retained callbacks inert before a first report and after registration disposal', async () => {
  const directory = new RecoveryDirectory(), api = client()
  directory.open('approve', report)
  await directory.deliver(report)
  const release = await loaded(directory, api)
  directory.dispose()
  directory.connect(api)()
  directory.offerPicker(async () => '/retired')()
  directory.closeDialog()
  directory.dismissNotice(0)
  release()
  await directory.refresh()
  expect(api.status).toHaveBeenCalledOnce()
})


it('refuses a dialog after a later query accepts another version of the same report', async () => {
  const directory = new RecoveryDirectory(), api = client()
  await loaded(directory, api)
  directory.open('approve', report)
  const id = directory.state.getSnapshot().dialog!.id
  vi.mocked(api.status).mockResolvedValueOnce(ok({ ...status,
    reports: [{ ...report, digest: brandString<VideoRecoveryDigest>('d'.repeat(64)) }] }))
  await directory.refresh()
  await directory.confirm(id, '')
  expect(api.review).not.toHaveBeenCalled()
})
