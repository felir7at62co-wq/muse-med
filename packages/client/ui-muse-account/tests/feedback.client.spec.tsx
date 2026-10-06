// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MuseAccountLauncher } from '../src/client/MuseAccountLauncher.tsx'
import { FeedbackConfig } from '../src/feedback-config.ts'
import type { ComponentProps } from 'react'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it.each([true, false])('opens the configured Muse feedback page with wide=%s', (wide) => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  const feedbackUrl = 'https://muse.example/feedback'
  const props = { wide, settingsOpen: false, openSettings: vi.fn(), openOnboarding: vi.fn(),
    feedbackUrl, t: (key: string) => key } as ComponentProps<typeof MuseAccountLauncher>
  render(<MuseAccountLauncher {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'feedback' }))
  expect(open).toHaveBeenCalledExactlyOnceWith(feedbackUrl, '_blank', 'noopener,noreferrer')
})

it('rejects missing and non-HTTPS feedback destinations', () => {
  expect(() => FeedbackConfig({})).toThrow()
  expect(() => FeedbackConfig({ feedbackUrl: 'javascript:alert(1)' })).toThrow()
  expect(() => FeedbackConfig({ feedbackUrl: 'http://muse.example/feedback' })).toThrow()
  expect(FeedbackConfig({ feedbackUrl: 'https://muse.example/feedback' })).toEqual({ feedbackUrl: 'https://muse.example/feedback' })
})

it.each([true, false])('opens account settings with section navigation available=%s', (available) => {
  const openSettings = vi.fn(), openSection = vi.fn()
  const props = {
    ...({} as GlobalStandardProps),
    wide: true, settingsOpen: false, openSettings, openOnboarding: vi.fn(), ...(available ? { openSection } : {}),
    feedbackUrl: 'https://muse.example/feedback', t: (key: string) => key,
  } as ComponentProps<typeof MuseAccountLauncher>
  render(<MuseAccountLauncher {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'nav' }))
  if (available) {
    expect(openSection).toHaveBeenCalledExactlyOnceWith('muse-account')
    expect(openSettings).not.toHaveBeenCalled()
  } else expect(openSettings).toHaveBeenCalledOnce()
})
