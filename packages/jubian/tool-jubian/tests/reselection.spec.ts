import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { assertSelectionReady, clearReselection, markReselection } from '../src/reselection.ts'

let root: string
let ledger: JubianLedger
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jubian-reselection-'))
  ledger = new JubianLedger({ root })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('edited material selection', () => {
  it('propagates an unreadable requirement file instead of allowing generation', async () => {
    await mkdir(join(root, 'selection', '1-2.required.json'), { recursive: true })
    await expect(assertSelectionReady(ledger, 1, 2, '@[乙](role)')).rejects.toMatchObject({ code: 'EISDIR' })
  })
  it('refuses a marker requirement without a readable prompt', async () => {
    await expect(markReselection(ledger, 1, 2, null)).rejects.toThrow('Missing prompt')
  })
  it.each([null, false, {}, { version: 2 }, { version: 1 }, { version: 1, script_id: 2 },
    { version: 1, script_id: 1 }, { version: 1, script_id: 1, storyboard_id: 3 },
    { version: 1, script_id: 1, storyboard_id: 2 },
    { version: 1, script_id: 1, storyboard_id: 2, markers_sha256: 123 }])
  ('keeps generation blocked when persisted selection identity is unreadable %j', async (value) => {
    await mkdir(join(root, 'selection'))
    await writeFile(join(root, 'selection', '1-2.required.json'), JSON.stringify(value))
    await expect(assertSelectionReady(ledger, 1, 2, '@[乙](role)')).rejects.toThrow('Unreadable selection requirement')
  })
  it('allows a card without a recorded marker change', async () => {
    await expect(assertSelectionReady(ledger, 1, 2, '@[甲](role)')).resolves.toBeUndefined()
  })
  it('keeps the requirement after action text changes and only clears matching markers', async () => {
    await markReselection(ledger, 1, 2, '@[乙](role)走进门')
    await clearReselection(ledger, 1, 2, '@[甲](role)')
    await expect(assertSelectionReady(ledger, 1, 2, '@[乙](role)转身')).rejects.toThrow('select_assets')
    await clearReselection(ledger, 1, 2, '@[乙](role)转身')
    await expect(assertSelectionReady(ledger, 1, 2, '@[乙](role)')).resolves.toBeUndefined()
  })
  it.each(['{', JSON.stringify({ version: 1, script_id: 1, storyboard_id: 2, markers_sha256: 'broken' })])(
    'refuses an unreadable requirement instead of allowing generation', async (raw) => {
      await mkdir(join(root, 'selection'))
      await writeFile(join(root, 'selection', '1-2.required.json'), raw)
      await expect(assertSelectionReady(ledger, 1, 2, '@[乙](role)')).rejects.toThrow()
    })
})
