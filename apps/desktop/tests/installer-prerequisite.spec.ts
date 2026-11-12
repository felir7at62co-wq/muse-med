import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { readInstallerLocales, renderInstallerStrings } from '../scripts/installer-locales.mjs'

it('defines one non-nested header hook containing both prerequisite and installer UI setup', async () => {
  const source = await readFile(new URL('../scripts/installer.nsh', import.meta.url), 'utf8')
  let current: string | undefined
  const headers: string[] = []
  for (const line of source.split(/\r?\n/u)) {
    const start = /^!macro\s+(\w+)/u.exec(line)
    if (start) {
      expect(current, `Nested NSIS macro: ${line}`).toBeUndefined()
      current = start[1]
      if (current === 'customHeader') headers.push(current)
    } else if (/^!macroend\s*$/u.test(line)) {
      expect(current, 'NSIS macro end without an opener').toBeDefined()
      current = undefined
    }
  }
  expect(current).toBeUndefined()
  expect(headers).toEqual(['customHeader'])
  const header = source.slice(source.indexOf('!macro customHeader'), source.indexOf('!macroend'))
  for (const marker of ['LangString MuseVCMissing', 'Function MuseEnsureVCRuntime',
    '!include "${INSTALLER_SOURCE_DIR}\\theme.nsh"', '!include "${INSTALLER_SOURCE_DIR}\\pages.nsh"',
    '!include "${INSTALLER_SOURCE_DIR}\\lifecycle.nsh"']) expect(header).toContain(marker)
})

it('checks the x64 runtime before any offline elevated installation and fails closed', async () => {
  const source = await readFile(new URL('../scripts/installer.nsh', import.meta.url), 'utf8')
  expect(source).toContain('InstallDir "$LOCALAPPDATA\\Programs\\${APP_FILENAME}"')
  expect(source).not.toMatch(/AllowRootDirInstall\s+true/iu)
  expect(source).toContain('SetRegView 64')
  expect(source).toContain('SetRegView lastused')
  expect(source).toContain('SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64')
  for (const field of ['Installed', 'Major', 'Minor', 'Bld', 'Rbld']) expect(source).toContain(`"${field}"`)
  expect(source).toContain('${VersionCompare} "$0.$1.$2.$3" "14.51.36247.0" $5')
  expect(source).toContain('StrCmp $5 "2" muse_vc_install muse_vc_done')
  expect(source).toContain('/SD IDNO IDYES muse_vc_authorized')
  expect(source).toContain('"$INSTDIR\\resources\\runtime\\media\\prerequisites\\vc_redist.x64.exe" "runas" "/install /quiet /norestart"')
  expect(source).toContain('StrCmp $0 "ok" 0 muse_vc_launch_failed')
  expect(source).toContain('StrCmp $1 "0" muse_vc_launch_failed')
  expect(source).toContain('${StdUtils.WaitForProcEx} $2 $1')
  expect(source).toContain('StrCmp $2 "0" muse_vc_done')
  expect(source).toContain('StrCmp $2 "3010" muse_vc_reboot')
  expect(source).toMatch(/muse_vc_reboot:\s+SetRebootFlag true\s+MessageBox .*"\$\(MuseVCReboot\)"/u)
  const keys = [...source.matchAll(/\$\((MuseVC\w+)\)/gu)].map(match => match[1])
  expect(new Set(keys).size).toBe(7)
  const fallbackStart = source.indexOf('!macro MuseVCDefaultStrings LANGUAGE')
  const fallback = source.slice(fallbackStart, source.indexOf('!macroend', fallbackStart))
  for (const key of new Set(keys)) {
    expect(fallback).toContain(`LangString ${key} \${LANGUAGE}`)
    expect(source).toContain(`LangString ${key} \${LANG_SIMPCHINESE}`)
  }
  for (const locale of readInstallerLocales().filter(locale => locale.nsisLanguage !== 'SIMPCHINESE')) {
    expect(source).toContain(`!ifdef LANG_${locale.nsisLanguage}\n  !insertmacro MuseVCDefaultStrings \${LANG_${locale.nsisLanguage}}\n  !endif`)
  }
  expect(source).toContain('!macro customHeader')
  expect(source.match(/^!macro customHeader$/gm)).toHaveLength(1)
  const headerStart = source.indexOf('!macro customHeader')
  const header = source.slice(headerStart, source.indexOf('!macroend', headerStart))
  expect(header).toContain('!ifndef BUILD_UNINSTALLER')
  expect(header).toContain('Function MuseEnsureVCRuntime')
  expect(header).toContain('FunctionEnd')
  expect(source).toContain('SetErrorLevel 1603')
  expect(source).toContain('Abort "$5"')
  expect(source).not.toMatch(/https?:\/\/|NSISdl|inetc::|ExecWait|SKIP.*(?:REDIST|PREREQ)/iu)
  expect(source).toContain('!insertmacro dshFinishDirectories')
  expect(source.indexOf('!insertmacro dshFinishDirectories')).toBeLessThan(source.lastIndexOf('Call MuseEnsureVCRuntime'))
})

it('retains reboot-required guidance and refuses both finish-page launch paths', async () => {
  const [pages, lifecycle, strings] = await Promise.all([
    readFile(new URL('../installer/pages.nsh', import.meta.url), 'utf8'),
    readFile(new URL('../installer/lifecycle.nsh', import.meta.url), 'utf8'),
    readFile(new URL('../installer/strings.nsh', import.meta.url), 'utf8'),
  ])
  expect(lifecycle.indexOf('IfRebootFlag installer_finish_manual'))
    .toBeLessThan(lifecycle.indexOf('Call InstallerStartApplication'))
  expect(pages).toMatch(/installer_launch_requires_reboot:\s+\$\{NSD_Uncheck\} \$InstallerLaunch\s+EnableWindow \$InstallerLaunch 0/u)
  expect(pages).toMatch(/Function InstallerStartApplication\s+IfRebootFlag installer_start_requires_reboot/u)
  expect(pages).toMatch(
    /installer_start_requires_reboot:\s+ShowWindow \$HWNDPARENT 5\s+MessageBox .*"\$\(INSTALLER_REBOOT_REQUIRED\)"\s+SetErrors/u,
  )
  for (const language of ['ENGLISH', 'SIMPCHINESE']) {
    expect(strings).toContain(`LangString INSTALLER_REBOOT_REQUIRED \${LANG_${language}}`)
  }
})

it('renders every installer page and lifecycle message from all shipped locale sources', async () => {
  const sources = await Promise.all(['pages.nsh', 'lifecycle.nsh'].map(name =>
    readFile(new URL(`../installer/${name}`, import.meta.url), 'utf8')))
  const used = new Set(sources.flatMap(source => [...source.matchAll(/\$\((INSTALLER_[A-Z_]+)\)/gu)].map((match) => {
    const key = match[1]
    if (key === undefined) throw new Error('Missing captured installer message key')
    return key
  })))
  expect(used.has('INSTALLER_REBOOT_REQUIRED')).toBe(true)
  for (const locale of readInstallerLocales()) {
    const rendered = renderInstallerStrings([locale])
    for (const key of used) {
      expect(locale.strings[key], `${locale.id}: ${key}`).toBeTruthy()
      expect(rendered).toContain(`LangString ${key} \${LANG_${locale.nsisLanguage}} `)
    }
  }
})

it('returns the failed launch flag after displaying its message so the finish callback can retain the page', async () => {
  const pages = await readFile(new URL('../installer/pages.nsh', import.meta.url), 'utf8')
  expect(pages).toMatch(
    /\$\{If\} \$\{Errors\}\s+ShowWindow \$HWNDPARENT 5\s+MessageBox .*"\$\(INSTALLER_LAUNCH_FAILED\)"\s+(?:;[^\n]*\s+)?SetErrors/u,
  )
  expect(pages).toMatch(/Call InstallerStartApplication\s+\$\{If\} \$\{Errors\}\s+Abort/u)
})
