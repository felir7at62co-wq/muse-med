// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MuseAccountLauncher } from '../src/client/MuseAccountLauncher.tsx'
import { FeedbackConfig } from '../src/feedback-config.ts'
import type { ComponentProps } from 'react'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('requires a feedback destination', () => {
  expect(() => FeedbackConfig({})).toThrow()
})

it.each([
  'https://muse.example/feedback', 'https://muse.example:8443/feedback?tab=mine#items',
  'https://muse.example/', 'https://muse.example/#feedback', 'https://muse.example/?tab=mine#items',
  'http://localhost/feedback', 'http://localhost:19488/feedback',
  'http://127.0.0.1:19488/feedback', 'http://[::1]:19488/feedback',
])('accepts an HTTPS or exact loopback HTTP feedback page (%s)', (feedbackUrl) => {
  expect(FeedbackConfig({ feedbackUrl })).toEqual({ feedbackUrl })
})

it.each([
  '', 'javascript:alert(1)', 'http://muse.example/feedback', 'ftp://localhost/feedback',
  'http://localhost.evil/feedback', 'http://sub.localhost/feedback', 'http://localhost./feedback',
  'http://127.0.0.2/feedback', 'http://127.1/feedback', 'http://2130706433/feedback',
  'http://user:password@localhost/feedback', 'https://user:password@muse.example/feedback',
  'http://localhost', 'http://localhost/', 'https://muse.example',
  'http://localhost/?next=/feedback',
  'http://localhost:65536/feedback', 'https://muse.example:invalid/feedback',
  'https://muse.example\\feedback', 'https://muse.example/ feedback',
])('rejects an invalid feedback page (%s)', (feedbackUrl) => {
  expect(() => FeedbackConfig({ feedbackUrl })).toThrow()
})

it.each([
  { wide: true, available: true }, { wide: true, available: false },
  { wide: false, available: true }, { wide: false, available: false },
])('keeps only account navigation with wide=$wide and section navigation=$available', ({ wide, available }) => {
  const openSettings = vi.fn(), openSection = vi.fn()
  const props = {
    ...({} as GlobalStandardProps),
    wide, settingsOpen: false, openSettings, openOnboarding: vi.fn(), ...(available ? { openSection } : {}),
    feedbackUrl: 'https://muse.example/feedback', t: (key: string) => key,
  } as ComponentProps<typeof MuseAccountLauncher>
  render(<MuseAccountLauncher {...props} />)
  expect(screen.getAllByRole('button')).toHaveLength(1)
  expect(screen.queryByRole('button', { name: 'feedback' })).toBeNull()
  expect(screen.getByRole('button', { name: 'nav' }).getAttribute('data-collapsed')).toBe(String(!wide))
  fireEvent.click(screen.getByRole('button', { name: 'nav' }))
  if (available) {
    expect(openSection).toHaveBeenCalledExactlyOnceWith('muse-account')
    expect(openSettings).not.toHaveBeenCalled()
  } else expect(openSettings).toHaveBeenCalledOnce()
})
