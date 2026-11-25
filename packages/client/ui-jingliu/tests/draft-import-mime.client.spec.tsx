// @vitest-environment jsdom
/** Workshop imports preserve the bytes of the browser-selected manuscript. */
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScriptDraft } from '@deepseek-ai/dsh-workbench-connection/types'
import { afterEach, expect, it, vi } from 'vitest'
import { NewDraft } from '../src/client/DrawerScriptDraftFiles.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

it('imports the original file bytes when its MIME parameter contains a comma', async () => {
  const draft: ScriptDraft = {
    id: 19, title: 'act one', status: 'created', episodeCount: 1, updatedAt: null, revision: 'draft-1',
    canFinalize: false, context: { outline: null, storyBible: null }, episodes: [{ episode: 1, title: 'Opening' }],
  }
  const create = vi.fn<Parameters<typeof NewDraft>[0]['create']>().mockResolvedValue(draft)
  const opened = vi.fn()
  const view = render(<NewDraft mode="file" t={makeTranslate(en)} create={create} opened={opened} close={vi.fn()} />)
  const dialog = within(view.getByRole('dialog', { name: en.importDraft }))
  const submit = dialog.getByRole('button', { name: en.importDraft })
  const source = new File([Uint8Array.of(0x2c, 0xc3, 0xa9, 0x0a)], 'act one.md', { type: 'text/markdown;name="act,one.md"' })
  fireEvent.change(dialog.getByLabelText(en.draftSource), { target: { files: [source] } })
  await waitFor(() => { expect(submit).toHaveProperty('disabled', false) })
  fireEvent.click(submit)
  await waitFor(() => { expect(opened).toHaveBeenCalledExactlyOnceWith(draft) })
  const requestId = create.mock.calls[0]?.[0].requestId
  expect(requestId).toBeTypeOf('string')
  expect(create).toHaveBeenCalledExactlyOnceWith({
    title: 'act one', requestId, file: { filename: 'act one.md', base64: 'LMOpCg==' },
  })
})

it('rejects a completed reader event that supplies no file data', async () => {
  const captured = Promise.withResolvers<FileReader>()
  const read = vi.spyOn(FileReader.prototype, 'readAsDataURL')
    .mockImplementationOnce(function (this: FileReader) { captured.resolve(this) })
  const create = vi.fn<Parameters<typeof NewDraft>[0]['create']>()
  const opened = vi.fn()
  try {
    const view = render(<NewDraft mode="file" t={makeTranslate(en)} create={create} opened={opened} close={vi.fn()} />)
    const dialog = within(view.getByRole('dialog', { name: en.importDraft }))
    const source = new File(['Last shuttle.'], 'shuttle.md', { type: 'text/markdown' })
    fireEvent.change(dialog.getByLabelText(en.draftSource), { target: { files: [source] } })
    expect(read).toHaveBeenCalledExactlyOnceWith(source)
    const reader = await captured.promise
    expect(dialog.getByRole('status').textContent).toBe(en.loading)
    expect(reader.result).toBeNull()
    await act(async () => { reader.dispatchEvent(new ProgressEvent('load')) })
    expect(dialog.getByRole('alert').textContent).toBe(en.draftCreateFailed)
    expect(dialog.queryByRole('status')).toBeNull()
    expect(dialog.getByRole('button', { name: en.importDraft })).toHaveProperty('disabled', true)
    expect(create).not.toHaveBeenCalled()
    expect(opened).not.toHaveBeenCalled()
  } finally {
    read.mockRestore()
  }
})
