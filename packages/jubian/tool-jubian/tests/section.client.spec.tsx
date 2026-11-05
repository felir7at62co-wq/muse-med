// @vitest-environment jsdom
/**
 * The Jubian token page's presentation behavior: the status line in each
 * credential state, the Save and Clear paths, and every failure it can show.
 *
 * Props are fed directly (the documented component tier): `t` is built from the
 * package's own `en` dictionary so every assertion reads the copy a user sees,
 * and the injected face is a stub standing in for the Host.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JubianTokenSection } from '../src/client/JubianTokenSection.tsx'
import { VideoRecoverySection, type VideoRecoveryControls } from '../src/client/VideoRecoverySection.tsx'
import type {
  JubianTokenOutcome,
  JubianTokenSectionProps,
  JubianTokenStatus,
} from '../src/client/JubianTokenSection.tsx'
import { en, type JubianLocaleKey } from '../src/client/locales.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { VideoRecoveryReview, VideoRecoveryStatus } from '../src/types.ts'

afterEach(cleanup)

const t = ((key: JubianLocaleKey, params?: Record<string, string | number>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    en[key],
  )) as JubianTokenSectionProps['t']

const CONFIGURED: JubianTokenStatus = { configured: true, source: 'file', writable: true }
const ABSENT: JubianTokenStatus = { configured: false, writable: true }
const READ_ONLY: JubianTokenStatus = { configured: true, source: 'env', writable: false }

function recoveryFixture(overrides: Partial<VideoRecoveryStatus> = {}, reportOverrides: Partial<VideoRecoveryReview> = {}) {
  const report: VideoRecoveryReview = { idempotencyKey: 'fixture-video', taskId: 9, status: 'awaiting_review',
    digest: 'fixture-digest', decision: null, mediaChecks: [{ sha256: 'sha256:' + 'a'.repeat(64), video: true, audio: true }],
    ...reportOverrides }
  const status: VideoRecoveryStatus = { enabled: true, configurable: true, decoderAvailable: true,
    projectDir: '/project', reports: [report], ...overrides }
  const controls = {
    status: vi.fn<VideoRecoveryControls['status']>(async () => ({ ok: true, value: status })),
    configure: vi.fn<VideoRecoveryControls['configure']>(async () => ({ ok: true, value: status })),
    review: vi.fn<VideoRecoveryControls['review']>(async () => ({ ok: true, value: report })),
    adopt: vi.fn<VideoRecoveryControls['adopt']>(async () => ({ ok: true, value: report })),
    createDraft: vi.fn<VideoRecoveryControls['createDraft']>(async () => ({ ok: true, value: report })),
    verifyExport: vi.fn<VideoRecoveryControls['verifyExport']>(async () => ({ ok: true, value: report })),
    deliverApprovedClip: vi.fn<VideoRecoveryControls['deliverApprovedClip']>(async () => ({ ok: true, value: report })),
    deliverApprovedMp4: vi.fn<VideoRecoveryControls['deliverApprovedMp4']>(async () => ({ ok: true, value: report })),
    deliverApprovedEpisode: vi.fn<VideoRecoveryControls['deliverApprovedEpisode']>(async () => ({ ok: true, value: {
      episode: 1, approvedShots: 1, totalShots: 1, readiness: 'ready', missing: [],
    } })),
    pickDirectory: vi.fn(async (): Promise<string | null> => '/picked'),
  }
  return { controls, report, status }
}

describe('project recovery controls', () => {

  it.each([new Error('Refresh unavailable'), 'Refresh unavailable'])('reports post-review refresh errors safely (%s)', async (failure) => {
    const f = recoveryFixture()
    render(<VideoRecoverySection t={t} controls={f.controls} />)
    fireEvent.click(await screen.findByRole('button', { name: en.recoveryApprove }))
    f.controls.status.mockRejectedValueOnce(failure)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.recoveryConfirm }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', t('failed', { reason: 'Refresh unavailable' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps a busy review dialog open until the Host settles and shows thrown diagnostics', async () => {
    const f = recoveryFixture()
    const pending = Promise.withResolvers<RemoteResult<VideoRecoveryReview>>()
    f.controls.review.mockReturnValueOnce(pending.promise)
    render(<VideoRecoverySection t={t} controls={f.controls} />)
    fireEvent.click(await screen.findByRole('button', { name: en.recoveryApprove }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.recoveryConfirm }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeDefined()
    pending.reject('Host disconnected')
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', t('failed', { reason: 'Host disconnected' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('refreshes a missing folder without inventing a project selection', async () => {
    const f = recoveryFixture({ projectDir: null, reports: [] })
    f.controls.status.mockRejectedValueOnce('unavailable')
    render(<VideoRecoverySection t={t} controls={f.controls} />)
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: en.recoveryRefresh }))
    expect(await screen.findByLabelText(en.recoveryFolder)).toHaveProperty('value', '')
  })

  it('retains a newly selected project when the previous episode export resolves later', async () => {
    const f = recoveryFixture({ reports: [], episodes: [
      { episode: 1, approvedShots: 1, totalShots: 1, readiness: 'ready', missing: [], digest: 'old-plan' },
    ] })
    const pending = Promise.withResolvers<Awaited<ReturnType<VideoRecoveryControls['deliverApprovedEpisode']>>>()
    f.controls.deliverApprovedEpisode.mockReturnValueOnce(pending.promise)
    const view = render(<VideoRecoverySection t={t} controls={f.controls} />)
    fireEvent.click(await screen.findByRole('button', { name: en.episodeDeliverMp4 }))
    const next = recoveryFixture({ projectDir: '/next', reports: [] })
    view.rerender(<VideoRecoverySection t={t} controls={next.controls} />)
    await screen.findByText('/next')
    pending.resolve({ ok: true, value: { ...f.status.episodes![0]!, delivery: {
      path: 'exports/stale.mp4', sha256: 'f'.repeat(64), durationSeconds: 1, checks: [],
    } } })
    await waitFor(() => { expect(screen.queryByText(en.episodeDelivering)).toBeNull() })
    expect(screen.queryByText('exports/stale.mp4')).toBeNull()
    expect(screen.getByLabelText(en.recoveryFolder)).toHaveProperty('value', '/next')
  })
  it.each([new Error('Unavailable'), 'plain rejection'])('recovers from an initial status failure %s by refreshing the project', async (failure) => {
    const f = recoveryFixture({ reports: [] })
    f.controls.status.mockRejectedValueOnce(failure)
    render(<VideoRecoverySection t={t} controls={f.controls} />)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', t('failed', { reason: failure instanceof Error ? failure.message : failure }))
    fireEvent.click(screen.getByRole('button', { name: en.recoveryRefresh }))
    expect(await screen.findByLabelText(en.recoveryFolder)).toHaveProperty('value', '/project')
    expect(screen.getByText(en.recoveryEmpty)).toBeDefined()
  })

  it.each(['resolve', 'reject'] as const)('ignores a %s status reply after unmount', async (outcome) => {
    const f = recoveryFixture()
    const pending = Promise.withResolvers<RemoteResult<VideoRecoveryStatus>>()
    f.controls.status.mockReturnValueOnce(pending.promise)
    const view = render(<VideoRecoverySection t={t} controls={f.controls} />)
    expect(view.container.querySelector('[aria-busy="true"]')).not.toBeNull()
    view.unmount()
    if (outcome === 'resolve') pending.resolve({ ok: true, value: f.status })
    else pending.reject('late failure')
    await pending.promise.catch(() => {})
    await Promise.resolve()
    expect(view.container.childElementCount).toBe(0)
  })

  it('chooses and trims a project, disables recovery, and retains edits across refresh', async () => {
    const f = recoveryFixture({ enabled: false, projectDir: null, reports: [] })
    render(<VideoRecoverySection t={t} controls={f.controls} />)
    await screen.findByText(en.recoveryDisabled)
    fireEvent.click(screen.getByRole('button', { name: en.recoveryChoose }))
    await waitFor(() => { expect(screen.getByLabelText(en.recoveryFolder)).toHaveProperty('value', '/picked') })
    f.controls.pickDirectory.mockResolvedValueOnce(null)
    fireEvent.click(screen.getByRole('button', { name: en.recoveryChoose }))
    await waitFor(() => { expect(f.controls.pickDirectory).toHaveBeenCalledTimes(2) })
    fireEvent.change(screen.getByLabelText(en.recoveryFolder), { target: { value: ' /new-project ' } })
    const enabled = { ...f.status, enabled: true, projectDir: '/new-project' }
    f.controls.configure.mockResolvedValueOnce({ ok: true, value: enabled })
    fireEvent.click(screen.getByRole('button', { name: en.recoveryEnable }))
    expect(await screen.findByText(en.recoveryEnabled)).toBeDefined()
    expect(f.controls.configure).toHaveBeenLastCalledWith({ enabled: true, projectDir: '/new-project' })
    fireEvent.change(screen.getByLabelText(en.recoveryFolder), { target: { value: '/unsaved' } })
    f.controls.status.mockResolvedValueOnce({ ok: true, value: enabled })
    fireEvent.click(screen.getByRole('button', { name: en.recoveryRefresh }))
    await waitFor(() => { expect(f.controls.status).toHaveBeenCalledTimes(2) })
    expect(screen.getByLabelText(en.recoveryFolder)).toHaveProperty('value', '/unsaved')
    f.controls.configure.mockResolvedValueOnce({ ok: true, value: f.status })
    fireEvent.click(screen.getByRole('button', { name: en.recoveryDisable }))
    await screen.findByText(en.recoveryDisabled)
    expect(f.controls.configure).toHaveBeenLastCalledWith({ enabled: false })
  })

  it.each(['approve', 'reject', 'adopt', 'createDraft', 'verifyExport'] as const)('confirms the %s action against the displayed report digest', async (action) => {
    const approved = action === 'createDraft' || action === 'verifyExport'
    const delivery = { draft: { name: 'Reviewed draft', path: 'drafts/reviewed' } }
    const f = recoveryFixture({ draftAvailable: true }, { decision: approved ? 'approve' : null,
      ...(action === 'verifyExport' ? { delivery } : {}) })
    const saved: VideoRecoveryReview = { ...f.report,
      ...(action === 'approve' || action === 'reject' ? { decision: action } : {}),
      ...(action === 'reject' ? { reason: 'Fix framing' } : {}),
      ...(action === 'adopt' ? { derivative: { path: 'media/updated.mp4', sha256: 'a'.repeat(64) } } : {}),
      ...(action === 'createDraft' ? { delivery } : {}),
      ...(action === 'verifyExport' ? { delivery: { ...delivery, export: {
        path: 'exports/approved.mp4', sha256: 'b'.repeat(64), videoSimilarity: 1, audioSimilarity: 1,
      } } } : {}),
    }
    f.controls[action === 'approve' || action === 'reject' ? 'review' : action].mockResolvedValueOnce({ ok: true, value: saved })
    render(<VideoRecoverySection t={t} controls={f.controls} />)
    const labels = { approve: en.recoveryApprove, reject: en.recoveryReject, adopt: en.recoveryImport,
      createDraft: en.recoveryCreateDraft, verifyExport: en.recoveryVerifyExport }
    fireEvent.click(await screen.findByRole('button', { name: labels[action] }))
    const dialog = screen.getByRole('dialog')
    const confirmLabel = action === 'adopt' ? en.recoveryImportConfirm
      : action === 'createDraft' || action === 'verifyExport' ? labels[action] : en.recoveryConfirm
    const confirm = within(dialog).getByRole('button', { name: confirmLabel })
    if (action === 'reject') {
      expect(confirm.hasAttribute('disabled')).toBe(true)
      fireEvent.change(screen.getByLabelText(en.recoveryReason), { target: { value: ' Fix framing ' } })
    }
    if (action === 'adopt' || action === 'verifyExport') {
      expect(confirm.hasAttribute('disabled')).toBe(true)
      fireEvent.change(screen.getByLabelText(action === 'adopt' ? en.recoveryLocalPath : en.recoveryExportPath),
        { target: { value: ' media/updated.mp4 ' } })
    }
    f.controls.status.mockResolvedValueOnce({ ok: true, value: { ...f.status, reports: [saved] } })
    fireEvent.click(confirm)
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    const target = { idempotencyKey: f.report.idempotencyKey, digest: f.report.digest }
    if (action === 'approve' || action === 'reject') {
      expect(f.controls.review).toHaveBeenCalledWith({ ...target, action, ...(action === 'reject' ? { reason: 'Fix framing' } : {}) })
      expect(f.controls.status).toHaveBeenCalledTimes(2)
    } else if (action === 'adopt' || action === 'verifyExport') {
      expect(f.controls[action]).toHaveBeenCalledWith({ ...target, path: 'media/updated.mp4' })
    } else expect(f.controls.createDraft).toHaveBeenCalledWith(target)
  })

  it('keeps a rejected review dialog open and reports failure without changing the decision', async () => {
    const f = recoveryFixture()
    f.controls.review.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', '', {}) })
    render(<VideoRecoverySection t={t} controls={f.controls} />)
    fireEvent.click(await screen.findByRole('button', { name: en.recoveryApprove }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.recoveryConfirm }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', t('failed', { reason: 'gateway/internal' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByText(en.recoveryCancel))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(f.controls.status).toHaveBeenCalledOnce()
  })

  it('reports a refresh failure after saving a review and cancels a subsequent dialog with Escape', async () => {
    const f = recoveryFixture()
    f.controls.status.mockRejectedValueOnce(new Error('initial'))
    f.controls.status.mockResolvedValueOnce({ ok: true, value: f.status })
    render(<VideoRecoverySection t={t} controls={f.controls} />)
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: en.recoveryRefresh }))
    fireEvent.click(await screen.findByRole('button', { name: en.recoveryApprove }))
    f.controls.status.mockRejectedValueOnce('refresh failed')
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.recoveryConfirm }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(screen.getByRole('alert')).toHaveProperty('textContent', t('failed', { reason: 'refresh failed' }))
    fireEvent.click(screen.getByRole('button', { name: en.recoveryReject }))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('selects a ready episode and publishes its exact MP4 receipt while retaining other episodes', async () => {
    const f = recoveryFixture({ reports: [], episodeRendererAvailable: true, episodes: [
      { episode: 1, approvedShots: 0, totalShots: 1, readiness: 'incomplete', missing: ['P01'] },
      { episode: 2, approvedShots: 0, totalShots: 1, readiness: 'invalid', missing: ['Invalid input'] },
      { episode: 3, approvedShots: 1, totalShots: 1, readiness: 'ready', missing: [], digest: 'episode-digest' },
    ] })
    const pending = Promise.withResolvers<Awaited<ReturnType<VideoRecoveryControls['deliverApprovedEpisode']>>>()
    f.controls.deliverApprovedEpisode.mockReturnValueOnce(pending.promise)
    render(<VideoRecoverySection t={t} controls={f.controls} />)
    const selector = await screen.findByLabelText(en.episodeDeliveryEpisode)
    expect(screen.getByRole('button', { name: en.episodeDeliverMp4 }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(selector, { target: { value: '2' } })
    expect(screen.getByText(t('episodeDeliveryInvalid', { shots: 'Invalid input', reason: 'Invalid input' }))).toBeDefined()
    fireEvent.change(selector, { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: en.episodeDeliverMp4 }))
    expect(f.controls.deliverApprovedEpisode).toHaveBeenCalledWith({ episode: 3, digest: 'episode-digest' })
    expect(screen.getByText(en.episodeDelivering)).toBeDefined()
    pending.resolve({ ok: true, value: { ...f.status.episodes![2]!, delivery: {
      path: 'exports/episode.mp4', sha256: 'f'.repeat(64), durationSeconds: 5.125, checks: [],
    } } })
    expect(await screen.findByText('exports/episode.mp4')).toBeDefined()
    expect(screen.queryByText(en.episodeDelivering)).toBeNull()
    fireEvent.change(selector, { target: { value: '1' } })
    expect(screen.getByText(t('episodeDeliveryIncomplete', { shots: 'P01', reason: 'P01' }))).toBeDefined()
  })

  it('shows unavailable rendering and failed media without offering a decision for a provider failure', async () => {
    const f = recoveryFixture({ configurable: false, episodeRendererAvailable: false, episodes: [
      { episode: 1, approvedShots: 1, totalShots: 1, readiness: 'ready', missing: [], digest: 'digest' },
    ] }, { status: 'provider_failed', mediaChecks: [{ sha256: 'unknown', video: false, audio: false }] })
    render(<VideoRecoverySection t={t} controls={f.controls} />)
    await screen.findByText(en.recoveryReadOnly)
    expect(screen.getByText(en.episodeRendererUnavailable)).toBeDefined()
    expect(screen.getByText(en.recoveryProviderFailed)).toBeDefined()
    expect(screen.getByText(en.recoveryVideoFail)).toBeDefined()
    expect(screen.queryByRole('button', { name: en.recoveryApprove })).toBeNull()
    expect(screen.getByRole('button', { name: en.episodeDeliverMp4 }).hasAttribute('disabled')).toBe(true)
  })
})

/** One successful answer carrying the status the Host reported. */
function ok(status: JubianTokenStatus): JubianTokenOutcome {
  return { ok: true, status }
}

/** Props for one render, with a stubbed Host face. */
function props(overrides: Partial<JubianTokenSectionProps> = {}): JubianTokenSectionProps {
  return {
    t,
    close: vi.fn(),
    describe: async () => ok(ABSENT),
    set: async () => ok(CONFIGURED),
    unset: async () => ok(ABSENT),
    ...overrides,
  } as JubianTokenSectionProps
}

/** Type one token into the password field. */
function typeToken(value: string): void {
  fireEvent.change(screen.getByLabelText(en.fieldLabel), { target: { value } })
}

describe('JubianTokenSection — status', () => {
  it('shows the loading line until the Host answers, then the unconfigured state and where to get a token', async () => {
    let answer: (outcome: JubianTokenOutcome) => void = () => {}
    render(<JubianTokenSection {...props({
      describe: () => new Promise<JubianTokenOutcome>((resolve) => { answer = resolve }),
    })} />)

    expect(screen.getByText(en.loading)).toBeDefined()
    answer(ok(ABSENT))
    await screen.findByText(`${en.statusLabel}: ${en.statusMissing}`)
    expect(screen.getByText(en.hint)).toBeDefined()
    expect(screen.queryByText(en.readOnly)).toBeNull()
  })

  it('names the source of a configured token and drops the hint', async () => {
    render(<JubianTokenSection {...props({ describe: async () => ok(CONFIGURED) })} />)

    await screen.findByText(`${en.statusLabel}: ${en.statusConfigured}`)
    expect(screen.getByText(en.sourceNamed.replace('{source}', 'file'))).toBeDefined()
    expect(screen.queryByText(en.hint)).toBeNull()
  })

  it('says a read-only deployment cannot be written here and disables both writes', async () => {
    render(<JubianTokenSection {...props({ describe: async () => ok(READ_ONLY) })} />)

    await screen.findByText(en.readOnly)
    typeToken('a-token')
    expect(screen.getByRole('button', { name: en.save }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: en.clear }).hasAttribute('disabled')).toBe(true)
  })

  it('shows the Host diagnostic for a status read that failed', async () => {
    render(<JubianTokenSection {...props({
      describe: async () => ({ ok: false, code: 'gateway/internal', message: 'host exploded' }),
    })} />)

    await screen.findByText('host exploded')
  })

  it('falls back to the stable code when a failure carried no diagnostic', async () => {
    render(<JubianTokenSection {...props({
      describe: async () => ({ ok: false, code: 'gateway/internal', message: '' }),
    })} />)

    await screen.findByText('gateway/internal')
  })

  it('ignores an answer that arrives after the page is gone', async () => {
    let answer: (outcome: JubianTokenOutcome) => void = () => {}
    const view = render(<JubianTokenSection {...props({
      describe: () => new Promise<JubianTokenOutcome>((resolve) => { answer = resolve }),
    })} />)

    view.unmount()
    answer(ok(CONFIGURED))
    await Promise.resolve()
    expect(view.container.innerHTML).toBe('')
  })
})

describe('JubianTokenSection — writes', () => {
  it('keeps Save disabled until a non-blank token is typed, then stores it and empties the field', async () => {
    const set = vi.fn(async () => ok(CONFIGURED))
    render(<JubianTokenSection {...props({ set })} />)
    await screen.findByText(`${en.statusLabel}: ${en.statusMissing}`)

    const save = screen.getByRole('button', { name: en.save })
    expect(save.hasAttribute('disabled')).toBe(true)
    typeToken('   ')
    expect(save.hasAttribute('disabled')).toBe(true)

    typeToken('  eyJhbGci.payload.sig  ')
    expect(save.hasAttribute('disabled')).toBe(false)
    fireEvent.click(save)

    await screen.findByText(en.saved)
    // The value is sent as typed; the Host is what repairs a paste's padding.
    expect(set).toHaveBeenCalledWith('  eyJhbGci.payload.sig  ')
    expect(screen.getByLabelText<HTMLInputElement>(en.fieldLabel).value).toBe('')
    expect(screen.getByText(`${en.statusLabel}: ${en.statusConfigured}`)).toBeDefined()
  })

  it('shows the busy label while a write is in flight', async () => {
    const pending: { resolve: (outcome: JubianTokenOutcome) => void } = { resolve: () => {} }
    const set = vi.fn(() => new Promise<JubianTokenOutcome>((resolve) => { pending.resolve = resolve }))
    render(<JubianTokenSection {...props({ set })} />)
    await screen.findByText(`${en.statusLabel}: ${en.statusMissing}`)

    typeToken('a-token')
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    const saving = screen.getByRole('button', { name: en.saving })
    expect(saving.hasAttribute('disabled')).toBe(true)

    pending.resolve(ok(CONFIGURED))
    await screen.findByRole('button', { name: en.save })
  })

  it('clears the stored token and reports the reference unconfigured afterwards', async () => {
    const unset = vi.fn(async () => ok(ABSENT))
    render(<JubianTokenSection {...props({ describe: async () => ok(CONFIGURED), unset })} />)
    await screen.findByText(`${en.statusLabel}: ${en.statusConfigured}`)

    const clear = screen.getByRole('button', { name: en.clear })
    expect(clear.hasAttribute('disabled')).toBe(false)
    typeToken('leftover')
    fireEvent.click(clear)

    await screen.findByText(en.cleared)
    expect(unset).toHaveBeenCalledOnce()
    expect(screen.getByLabelText<HTMLInputElement>(en.fieldLabel).value).toBe('')
    expect(screen.getByText(`${en.statusLabel}: ${en.statusMissing}`)).toBeDefined()
  })

  it('reports a refused write with the Host diagnostic and leaves the status alone', async () => {
    const set = vi.fn(async (): Promise<JubianTokenOutcome> => ({
      ok: false, code: 'credential/rejected', message: 'refusing to write a shadowed reference',
    }))
    render(<JubianTokenSection {...props({ describe: async () => ok(ABSENT), set })} />)
    await screen.findByText(`${en.statusLabel}: ${en.statusMissing}`)

    typeToken('a-token')
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await screen.findByText(en.failed.replace('{reason}', 'refusing to write a shadowed reference'))
    expect(screen.getByText(`${en.statusLabel}: ${en.statusMissing}`)).toBeDefined()
    expect(screen.getByLabelText<HTMLInputElement>(en.fieldLabel).value).toBe('a-token')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: en.save }).hasAttribute('disabled')).toBe(false)
    })
  })
})

it('reopens a returned video with a reason and waits for a new decision', async () => {
  let report: VideoRecoveryReview = {
    idempotencyKey: 'reviewed-video', taskId: 562626, status: 'awaiting_review', digest: 'old-digest',
    decision: 'reject', reason: 'Check lip sync', mediaChecks: [],
  }
  const status = async (): Promise<RemoteResult<VideoRecoveryStatus>> => ({ ok: true,
    value: { enabled: true, configurable: true, decoderAvailable: true, projectDir: '/project', reports: [report] } })
  const review = vi.fn(async () => {
    report = { ...report, digest: 'new-digest', decision: null,
      reopenedFrom: { digest: 'old-digest', rejectionReason: 'Check lip sync', reason: 'Action only' } }
    return { ok: true as const, value: report }
  })
  const read = async (): Promise<RemoteResult<VideoRecoveryReview>> => ({ ok: true, value: report })
  render(<JubianTokenSection {...props({ recovery: {
    status, configure: status, review, adopt: read, createDraft: read, verifyExport: read,
    deliverApprovedClip: read, deliverApprovedMp4: read,
    deliverApprovedEpisode: async () => ({ ok: true, value: {
      episode: 1, approvedShots: 0, totalShots: 0, readiness: 'invalid', missing: [],
    } }),
  } })} />)
  fireEvent.click(await screen.findByRole('button', { name: en.recoveryReopen }))
  const confirm = screen.getByRole('button', { name: en.recoveryConfirm })
  expect(confirm.hasAttribute('disabled')).toBe(true)
  fireEvent.change(screen.getByLabelText(en.recoveryReopenReason), { target: { value: 'Action only' } })
  fireEvent.click(confirm)
  await screen.findByText(en.recoveryAwaiting)
  expect(review).toHaveBeenCalledWith({ action: 'reopen', idempotencyKey: 'reviewed-video', digest: 'old-digest', reason: 'Action only' })
  expect(screen.getByText(en.recoveryPreviousRejection)).toBeDefined()
  expect(screen.getByText('Check lip sync')).toBeDefined()
  expect(screen.getByRole('button', { name: en.recoveryApprove })).toBeDefined()
  expect(screen.queryByRole('button', { name: en.recoveryImport })).toBeNull()
})

describe('Jubian recovery delivery', () => {
  it.each(['derivative', 'original'] as const)('exports an approved %s again and displays the updated verification', async (source) => {
    const sha256 = 'sha256:' + 'a'.repeat(64)
    const report: VideoRecoveryReview = {
      idempotencyKey: 'reviewed-video',
      taskId: 744521,
      status: 'awaiting_review',
      digest: 'approved-digest',
      mediaChecks: [{ sha256, video: true, audio: true }],
      ...(source === 'derivative' ? { derivative: { path: 'video_tasks/review/derivative.mp4', sha256 } } : {}),
      decision: 'approve',
      delivery: {
        draft: { name: 'Approved video', path: 'drafts/approved-video' },
        export: { path: 'exports/previous.mp4', sha256: 'previous-hash', videoSimilarity: 1, audioSimilarity: 1 },
      },
    }
    const status: VideoRecoveryStatus = {
      enabled: true, configurable: true, decoderAvailable: true, automaticExportAvailable: true,
      projectDir: '/project', reports: [
        report,
        { idempotencyKey: 'unhashed-original', taskId: 744524, status: 'awaiting_review', digest: 'unhashed-digest',
          decision: 'approve', mediaChecks: [{ sha256: 'unknown', video: true, audio: true }] },
        { ...report, idempotencyKey: 'rejected-video', decision: 'reject' },
        { idempotencyKey: 'failed-original', taskId: 744522, status: 'awaiting_review', digest: 'failed-digest',
          decision: 'approve', mediaChecks: [{ sha256, video: true, audio: false }] },
        { idempotencyKey: 'ambiguous-original', taskId: 744523, status: 'awaiting_review', digest: 'ambiguous-digest',
          decision: 'approve', mediaChecks: [{ sha256, video: true, audio: true }, { sha256: 'failed', video: true, audio: false }] },
      ],
    }
    const delivery = Promise.withResolvers<RemoteResult<VideoRecoveryReview>>()
    const deliverApprovedClip = vi.fn(() => delivery.promise)
    render(<JubianTokenSection {...props({
      recovery: {
        status: async () => ({ ok: true, value: status }),
        configure: async () => ({ ok: true, value: status }),
        review: async () => ({ ok: true, value: report }),
        adopt: async () => ({ ok: true, value: report }),
        createDraft: async () => ({ ok: true, value: report }),
        verifyExport: async () => ({ ok: true, value: report }),
        deliverApprovedClip,
        deliverApprovedMp4: async () => ({ ok: true, value: report }),
        deliverApprovedEpisode: async () => ({ ok: true, value: {
          episode: 1, approvedShots: 0, totalShots: 0, readiness: 'invalid', missing: [],
        } }),
      },
    })} />)

    const button = await screen.findByRole('button', { name: en.recoveryDeliverClip })
    fireEvent.click(button)
    expect(deliverApprovedClip).toHaveBeenCalledExactlyOnceWith({
      idempotencyKey: 'reviewed-video', digest: 'approved-digest',
    })
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(en.recoveryDeliveringClip)).toBeDefined()

    delivery.resolve({
      ok: true,
      value: {
        ...report,
        delivery: {
          draft: { name: 'Approved video', path: 'drafts/approved-video' },
          export: { path: 'exports/updated.mp4', sha256: 'updated-hash', videoSimilarity: 0.98, audioSimilarity: 0.99 },
        },
      },
    })
    expect(await screen.findByText('exports/updated.mp4')).toBeDefined()
    expect(screen.queryByText(en.recoveryDeliveringClip)).toBeNull()
    expect(button.hasAttribute('disabled')).toBe(false)
  })

  it('delivers an approved MP4 without a decoder or Jianying and restores the receipt on refresh', async () => {
    const sha256 = 'a'.repeat(64)
    const report: VideoRecoveryReview = {
      idempotencyKey: 'direct-video', taskId: 744522, status: 'awaiting_review', digest: 'approved-digest',
      mediaChecks: [{ sha256: 'sha256:' + sha256, video: true, audio: true }], decision: 'approve',
    }
    const directDelivery = { path: 'exports/direct.mp4', sha256 }
    const delivered = { ...report, directDelivery }
    const status: VideoRecoveryStatus = {
      enabled: true, configurable: true, decoderAvailable: false, projectDir: '/project', reports: [report],
    }
    const load = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: status })
      .mockResolvedValueOnce({ ok: true, value: { ...status, reports: [delivered] } })
    const delivery = Promise.withResolvers<RemoteResult<VideoRecoveryReview>>()
    const deliverApprovedMp4 = vi.fn(() => delivery.promise)
    const deliverApprovedClip = vi.fn(async () => ({ ok: true, value: report }) as const)
    render(<JubianTokenSection {...props({
      recovery: {
        status: load,
        configure: async () => ({ ok: true, value: status }),
        review: async () => ({ ok: true, value: report }),
        adopt: async () => ({ ok: true, value: report }),
        createDraft: async () => ({ ok: true, value: report }),
        verifyExport: async () => ({ ok: true, value: report }),
        deliverApprovedClip,
        deliverApprovedMp4,
        deliverApprovedEpisode: vi.fn(async () => ({ ok: true as const, value: {
          episode: 1, approvedShots: 0, totalShots: 0, readiness: 'invalid' as const, missing: [],
        } })),
      },
    })} />)

    const direct = await screen.findByRole('button', { name: en.recoveryDeliverMp4 })
    expect(screen.queryByRole('button', { name: en.recoveryDeliverClip })).toBeNull()
    expect(screen.getByText(en.recoveryDecoderUnavailable)).toBeDefined()
    expect(direct.hasAttribute('disabled')).toBe(false)
    fireEvent.click(direct)
    expect(deliverApprovedMp4).toHaveBeenCalledExactlyOnceWith({
      idempotencyKey: report.idempotencyKey, digest: report.digest,
    })
    expect(deliverApprovedClip).not.toHaveBeenCalled()
    expect(direct.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(en.recoveryDeliveringMp4)).toBeDefined()

    delivery.resolve({ ok: true, value: delivered })
    expect(await screen.findByText(en.recoveryMp4Delivered)).toBeDefined()
    expect(screen.getByText(directDelivery.path)).toBeDefined()
    expect(screen.getByText(en.recoveryMp4Digest.replace('{digest}', sha256))).toBeDefined()
    expect(direct.hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: en.recoveryRefresh }))
    await waitFor(() => { expect(load).toHaveBeenCalledTimes(2) })
    expect(screen.getByText(directDelivery.path)).toBeDefined()
  })
})
