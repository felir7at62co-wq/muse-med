// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarkdownText } from '../src/markdown/MarkdownText.tsx'
import { MarkdownDelegateProvider, type MarkdownDelegateResourceLinkInfo } from '../src/markdown/MarkdownDelegate.tsx'
import { markdownLabels } from './labels.client.ts'

afterEach(cleanup)

it('offers only safe settled application-resource links to their presentation delegate', () => {
  const address = 'dsh-resource://session-video/session/example?source=1&version=2'
  const input = `[Project resource](${address}) [Website](https://example.test/) [Unsafe](javascript:alert)`
  const renderResourceLink = vi.fn((link: MarkdownDelegateResourceLinkInfo, fallback: ReactNode) =>
    <span data-resource-host={link.host}>{fallback}</span>)
  const { rerender } = render(<MarkdownDelegateProvider renderResourceLink={renderResourceLink}>
    <MarkdownText text={input} streaming labels={markdownLabels} />
  </MarkdownDelegateProvider>)
  expect(renderResourceLink).not.toHaveBeenCalled()
  expect(screen.getByRole('link', { name: 'Project resource' }).getAttribute('href')).toBe(address)
  rerender(<MarkdownDelegateProvider renderResourceLink={renderResourceLink}>
    <MarkdownText text={input} labels={markdownLabels} />
  </MarkdownDelegateProvider>)
  expect(renderResourceLink).toHaveBeenCalledOnce()
  expect(renderResourceLink.mock.calls[0]?.[0]).toEqual({ address, host: 'session-video' })
  expect(screen.getByRole('link', { name: 'Project resource' }).parentElement?.getAttribute('data-resource-host')).toBe('session-video')
  expect(screen.getByRole('link', { name: 'Website' }).getAttribute('href')).toBe('https://example.test/')
  expect(screen.queryByRole('link', { name: 'Unsafe' })).toBeNull()
})
