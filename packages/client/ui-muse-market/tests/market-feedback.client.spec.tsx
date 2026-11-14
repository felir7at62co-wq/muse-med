// @vitest-environment jsdom
/** Settled market feedback survives panel changes and stops at plugin disposal. */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { createMarketFeedback, MarketFeedbackOverlay } from '../src/client/market-feedback.tsx'

afterEach(() => { cleanup(); vi.useRealTimers() })

it('publishes each settled outcome, removes subscribers and suppresses late completions', () => {
  const feedback = createMarketFeedback(), changed = vi.fn()
  const source = feedback.hooks.outcome
  expect(source.getSnapshot()).toBeNull()
  const stop = source.subscribe(changed)
  feedback.report('done', false)
  expect(source.getSnapshot()).toEqual({ key: 'done', failed: false, sequence: 1 })
  feedback.report('failed', true)
  expect(source.getSnapshot()).toEqual({ key: 'failed', failed: true, sequence: 2 })
  feedback.dismiss()
  expect(source.getSnapshot()).toBeNull()
  expect(changed).toHaveBeenCalledTimes(3)
  stop()
  feedback.report('installedDone', false)
  expect(changed).toHaveBeenCalledTimes(3)
  source.subscribe(changed)
  feedback.dispose()
  expect(source.getSnapshot()).toBeNull()
  feedback.report('failed', true)
  feedback.dismiss()
  expect(source.getSnapshot()).toBeNull()
  expect(changed).toHaveBeenCalledTimes(3)
})

it('renders localized success and failure banners and dismisses them after their lifetime', () => {
  vi.useFakeTimers()
  const feedback = createMarketFeedback()
  const props: ComponentProps<typeof MarketFeedbackOverlay> = {
    ...({} as GlobalStandardProps),
    t: key => `localized:${key}`,
    dismiss: feedback.dismiss,
    useOutcome: selector => selector(feedback.hooks.outcome.getSnapshot()),
  }
  const page = render(<MarketFeedbackOverlay {...props} />)
  expect(screen.queryByRole('alert')).toBeNull()
  feedback.report('installedDone', false)
  page.rerender(<MarketFeedbackOverlay {...props} />)
  expect(screen.getByRole('alert').textContent).toBe('localized:installedDone')
  feedback.report('permissionDenied', true)
  page.rerender(<MarketFeedbackOverlay {...props} />)
  expect(screen.getByRole('alert').textContent).toBe('localized:permissionDenied')
  act(() => { vi.runAllTimers() })
  expect(feedback.hooks.outcome.getSnapshot()).toBeNull()
  page.rerender(<MarketFeedbackOverlay {...props} />)
  expect(screen.queryByRole('alert')).toBeNull()
  feedback.dispose()
})
