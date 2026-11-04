// @vitest-environment jsdom
/**
 * The Jubian token page's presentation behavior: the status line in each
 * credential state, the Save and Clear paths, and every failure it can show.
 *
 * Props are fed directly (the documented component tier): `t` is built from the
 * package's own `en` dictionary so every assertion reads the copy a user sees,
 * and the injected face is a stub standing in for the Host.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JubianTokenSection } from '../src/client/JubianTokenSection.tsx'
import type {
  JubianTokenOutcome,
  JubianTokenSectionProps,
  JubianTokenStatus,
} from '../src/client/JubianTokenSection.tsx'
import { en, type JubianLocaleKey } from '../src/client/locales.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
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
