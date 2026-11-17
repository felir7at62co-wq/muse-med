/** The pinned builder template keeps its registration flow around staged directory replacement. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { directoryInstallerExits, directoryInstallSection, directoryInstallUtil, directoryUninstaller } from '../scripts/windows-directory-installer.mjs'

const require = createRequire(import.meta.url)
const section = readFileSync(join(dirname(require.resolve('app-builder-lib/package.json')),
  'templates/nsis/installSection.nsh'), 'utf8')

it('declares shared path variables before production directory functions and reuses the guarded declaration in the path validator', () => {
  const installer = readFileSync(new URL('../scripts/installer.nsh', import.meta.url), 'utf8')
  const path = readFileSync(new URL('../installer/path.nsh', import.meta.url), 'utf8')
  const declaration = installer.indexOf('!include "${INSTALLER_SOURCE_DIR}\\path-vars.nsh"')
  const functions = installer.indexOf('!include "${__FILEDIR__}\\installer-directories.nsh"')
  expect(declaration).toBeGreaterThanOrEqual(0)
  expect(functions).toBeGreaterThan(declaration)
  expect(path).toContain('!include "${__FILEDIR__}\\path-vars.nsh"')
})

it('keeps data cleanup out of the upstream template while retaining application removal and registration cleanup', () => {
  const source = readFileSync(join(dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis/uninstaller.nsh'), 'utf8')
  const adapted = directoryUninstaller(source)
  expect(adapted).not.toContain('--delete-app-data')
  expect(adapted).not.toContain('RMDir /r "$APPDATA')
  expect(adapted).toContain('!insertmacro customUnInstall')
  expect(adapted).toContain('DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"')
  expect(adapted).toContain('DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}"')
  expect(directoryUninstaller(source.replaceAll('\n', '\r\n'))).toBe(adapted)
  expect(adapted).toContain('RMDir /r "\\\\?\\$INSTDIR"')
  expect(() => directoryUninstaller(source.replace('  Var /GLOBAL isDeleteAppData\n', ''))).toThrow('template changed')
  expect(() => directoryUninstaller(source.replace('  DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"', ''))).toThrow('template changed')
})

it.each(['allowOnlyOneInstallerInstance.nsh', 'installUtil.nsh'])('cleans staged files before %s exits', (helper) => {
  const source = readFileSync(join(dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis/include', helper), 'utf8')
  const exits = source.match(/^\s*Quit\s*$/gm) ?? []
  expect(exits.length).toBeGreaterThan(0)
  const adapted = directoryInstallerExits(source)
  expect(adapted.match(/Call dshCleanupDirectories/g)).toHaveLength(exits.length)
  expect(adapted).toContain('!ifndef BUILD_UNINSTALLER')
})

it('removes only the superseded destructive uninstall function from the pinned helper', () => {
  const source = readFileSync(join(dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis/include/installUtil.nsh'), 'utf8').replaceAll('\r\n', '\n')
  const adapted = directoryInstallUtil(source)
  const start = source.indexOf('Function uninstallOldVersion\n')
  const end = source.indexOf('\nFunctionEnd\n', start) + '\nFunctionEnd\n'.length
  expect(start).toBeGreaterThanOrEqual(0)
  expect(adapted).toBe(directoryInstallerExits(source.slice(0, start) + source.slice(end)))
  expect(adapted).toContain('!macro uninstallOldVersion ROOT_KEY')
  expect(adapted).not.toContain('Function uninstallOldVersion\n')
  expect(directoryInstallUtil(source.replaceAll('\n', '\r\n'))).toBe(adapted)
  expect(() => directoryInstallUtil(source.replace('Function uninstallOldVersion\n', ''))).toThrow('template changed')
  expect(() => directoryInstallUtil(`${source}\nFunction uninstallOldVersion\n`)).toThrow('template changed')
  expect(() => directoryInstallUtil(source.slice(0, end - '\nFunctionEnd\n'.length) + source.slice(end))).toThrow('template changed')
  expect(() => directoryInstallUtil(source.replace('!macro uninstallOldVersion ROOT_KEY', '!macro changed ROOT_KEY'))).toThrow('template changed')
})

it('stages before stopping the application and promotes before registering the installation', () => {
  const result = directoryInstallSection(section)
  expect(result.indexOf('!insertmacro dshStageApplication')).toBeLessThan(result.indexOf('!insertmacro CHECK_APP_RUNNING'))
  expect(result.indexOf('Call dshPromoteDirectories')).toBeLessThan(result.indexOf('!insertmacro registryAddInstallInfo'))
  expect(result).toContain('!insertmacro addStartMenuLink $keepShortcuts')
  expect(result).toContain('!insertmacro addDesktopLink $keepShortcuts')
  expect(result).toContain('!insertmacro handleUninstallResult HKEY_CURRENT_USER')
  expect(result).not.toContain('!insertmacro installApplicationFiles')
  expect(result).not.toContain('File /oname=uninstallerIcon.ico')
  expect(result).toContain('IfRebootFlag dsh_skip_upstream_start\n  !insertmacro StartApp\ndsh_skip_upstream_start:')
})

it('normalizes the registered full path before selecting staged replacement instead of the old uninstaller', () => {
  const result = directoryInstallSection(section)
  const macro = result.slice(result.indexOf('!macro uninstallOldVersion ROOT_KEY'), result.indexOf('!macroend', result.indexOf('!macro uninstallOldVersion ROOT_KEY')))
  const compare = macro.indexOf('${If} $R4 == $INSTDIR')
  expect(macro.indexOf('kernel32::GetFullPathNameW')).toBeGreaterThan(macro.indexOf('${If} $R4 != ""'))
  expect(macro).toContain('!insertmacro InstallerTrimDirectorySeparators $2')
  expect(macro.indexOf('!insertmacro InstallerTrimDirectorySeparators $2')).toBeLessThan(compare)
  expect(macro).toContain('${AndIf} $1 < ${NSIS_MAX_STRLEN}')
  expect(macro).toContain('${If} $1 > 3\n        StrCpy $R4 $2')
  expect(macro.slice(compare)).toContain('${OrIf} $R4 == ""')
  expect(macro).not.toContain('Call uninstallOldVersion')
  expect(macro).toContain('StrCpy $R4 "<unknown-registered-path>"')
  expect(macro).toContain('${UNINSTALL_REGISTRY_KEY_2}')
  expect(macro).toContain('Call dshRecordBlockedDirectory')
  expect(macro.indexOf('Call dshCleanupDirectories')).toBeGreaterThan(macro.indexOf('Call dshRecordBlockedDirectory'))
  expect(macro).toContain('SetErrorLevel 1603')
  expect(macro).toContain('$(MuseUpgradeDifferentDirectory)')
  expect(directoryInstallSection(section.replaceAll('\n', '\r\n'))).toBe(result)
  expect(macro).toContain('Push $0')
  expect(macro).toContain('Push $1')
  expect(macro).toContain('Push $2')
  expect(macro).toContain('Pop $2')
  expect(macro).toContain('Pop $1')
  expect(macro).toContain('Pop $0')
  expect(result).toContain('!insertmacro CHECK_APP_RUNNING')
  expect(result).toContain('Call dshPromoteDirectories\nIfErrors 0 +3\n  SetErrorLevel 2\n  Quit')
})

it.each(['!include installer.nsh', '!insertmacro setLinkVars', '!insertmacro installApplicationFiles', '  !insertmacro StartApp'])(
  'rejects a missing or duplicate upstream insertion point: %s', (point) => {
    expect(() => directoryInstallSection(section.replace(point, ''))).toThrow('Desktop NSIS template changed')
    expect(() => directoryInstallSection(`${section}\n${point}`)).toThrow('Desktop NSIS template changed')
  },
)
