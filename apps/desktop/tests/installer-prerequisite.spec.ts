import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'

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
  for (const key of new Set(keys)) {
    for (const language of ['ENGLISH', 'SIMPCHINESE']) {
      expect(source).toContain(`LangString ${key} \${LANG_${language}}`)
    }
  }
  expect(source).toContain('!macro customHeader')
  const header = source.slice(source.indexOf('!macro customHeader'), source.indexOf('!macroend'))
  expect(header).toContain('!ifndef BUILD_UNINSTALLER')
  expect(header).toContain('Function MuseEnsureVCRuntime')
  expect(header).toContain('FunctionEnd')
  expect(source).toContain('SetErrorLevel 1603')
  expect(source).toContain('Abort "$5"')
  expect(source).not.toMatch(/https?:\/\/|NSISdl|inetc::|ExecWait|SKIP.*(?:REDIST|PREREQ)/iu)
  expect(source).toContain('RMDir /r "$PLUGINSDIR\\7z-out"')
  expect(source.indexOf('RMDir /r "$PLUGINSDIR\\7z-out"')).toBeLessThan(source.lastIndexOf('Call MuseEnsureVCRuntime'))
})
