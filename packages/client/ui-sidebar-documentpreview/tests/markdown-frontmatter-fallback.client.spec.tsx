// @vitest-environment jsdom
/** A field-list chunk that fails to load leaves the verbatim frontmatter and the Markdown body visible. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { MarkdownBody, type MarkdownBodyProps } from '../src/client/markdown/MarkdownBody.tsx'
import { en } from '../src/client/markdown/locales.ts'

const chunk = vi.hoisted(() => ({
  entered: Promise.withResolvers<undefined>(),
  release: Promise.withResolvers<undefined>(),
}))

vi.mock('../src/client/markdown/frontmatter-fields.tsx', async () => {
  chunk.entered.resolve(undefined)
  await chunk.release.promise
  throw new Error('chunk unavailable')
})

afterEach(async () => {
  try { cleanup() } finally {
    await act(async () => {
      chunk.release.resolve(undefined)
      await vi.dynamicImportSettled()
    })
  }
})

describe('MarkdownBody frontmatter chunk failure', () => {
  it('keeps the verbatim frontmatter and the body', async () => {
    const text = '---\nname: pdf\n---\n# Body'
    const view = render(<MarkdownBody {...{
      resourceAddress: 'dsh-resource://file/session/markdown/SKILL.md', wrap: false, t: makeTranslate(en),
      content: { kind: 'text', text, pages: [{ offset: 1, text, lines: 4 }], eof: true },
      useResource: () => ({ status: 'loading', value: undefined, failure: undefined }),
    } as MarkdownBodyProps} />)
    await chunk.entered.promise
    await vi.waitFor(() => { expect(view.container.querySelector('[data-document-frontmatter] pre')?.textContent).toBe('name: pdf') })
    await act(async () => {
      chunk.release.resolve(undefined)
      await vi.dynamicImportSettled()
    })
    expect(view.container.querySelector('[data-document-frontmatter] pre')?.textContent).toBe('name: pdf')
    expect(view.getByRole('heading', { name: 'Body' })).toBeDefined()
  })
})
