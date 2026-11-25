// @vitest-environment jsdom
/** Browser select changes keep the last valid Workshop export options. */
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { afterEach, expect, it, vi } from 'vitest'
import { DraftExport } from '../src/client/DrawerScriptDraftFiles.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function clearSelection(select: HTMLElement): void {
  if (!(select instanceof HTMLSelectElement)) throw new Error('Expected a native select')
  select.selectedIndex = -1
  expect(select.value).toBe('')
  fireEvent.change(select)
}

it('submits the last valid contents and format after the browser reports cleared selections', async () => {
  const exportDraft = vi.fn<Parameters<typeof DraftExport>[0]['exportDraft']>()
    .mockRejectedValue(new Error('Workshop unavailable'))
  const view = render(<DraftExport draftId={31} episode={2} layer="chapter" t={makeTranslate(en)} exportDraft={exportDraft} close={vi.fn()} />)
  const dialog = within(view.getByRole('dialog', { name: en.exportScriptDraft }))
  const kind = dialog.getByRole('combobox', { name: en.draftExportKind })
  const format = dialog.getByRole('combobox', { name: en.draftExportFormat })
  fireEvent.change(kind, { target: { value: 'storyboards' } })
  fireEvent.change(format, { target: { value: 'txt' } })
  fireEvent.change(dialog.getByRole('combobox', { name: en.draftExportEpisodes }), { target: { value: 'episode' } })
  clearSelection(kind)
  clearSelection(format)
  expect(kind).toHaveProperty('value', 'storyboards')
  expect(format).toHaveProperty('value', 'txt')
  fireEvent.click(dialog.getByRole('button', { name: en.exportScriptDraft }))
  expect((await dialog.findByRole('alert')).textContent).toBe(en.draftExportFailed)
  expect(exportDraft).toHaveBeenCalledExactlyOnceWith({ draftId: 31, episode: 2, kind: 'storyboards', format: 'txt' })
})
