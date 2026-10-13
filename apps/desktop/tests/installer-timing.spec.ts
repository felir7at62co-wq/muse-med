import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'

it('passes the opt-in journal directory from the same NSIS register and preserves caller registers', async () => {
  const source = await readFile(new URL('../scripts/installer.nsh', import.meta.url), 'utf8')
  const macro = source.match(/^!macro InstallerRecordTiming EventCode\r?\n([\s\S]*?)^!macroend/mu)?.[1]
  expect(macro).toBeDefined()
  expect(macro).toContain('ReadEnvStr $R8 "DSH_DESKTOP_UPDATE_JOURNAL_DIR"')
  expect(macro).toContain('${If} $R8 != ""')
  expect(macro).toContain('InstallerRecordTiming(w R8, w "${VERSION}", i ${EventCode}) i.R9 ?c')
  expect(macro).not.toContain('InstallerRecordTiming(w r8,')
  expect(macro).toMatch(/^  Push \$R8\r?\n  Push \$R9/mu)
  expect(macro).toMatch(/  Pop \$R9\r?\n  Pop \$R8\r?\n$/u)
  expect(macro).not.toMatch(/SetErrorLevel|Abort|Quit/u)
  for (const code of [0, 1, 2, 3, 4, 5]) expect(source).toContain(`!insertmacro InstallerRecordTiming ${code}`)
})
