/** Private installer fixtures retain production checks and add deterministic reboot coverage. */
import { join } from 'node:path'

/** Copy production checks while resolving their includes at their original locations.
 * @param {string} source - Production NSIS source.
 * @param {string} appRoot - Absolute desktop application directory.
 * @returns {string} Private fixture source with an opt-in reboot result.
 */
export function createInstallerTestSource(source, appRoot) {
  const sourceDirectory = '!define INSTALLER_SOURCE_DIR "${__FILEDIR__}\\..\\installer"'
  const directoriesInclude = '!include "${__FILEDIR__}\\installer-directories.nsh"'
  const pagesInclude = '!include "${INSTALLER_SOURCE_DIR}\\pages.nsh"'
  const prerequisiteCall = '  Call MuseEnsureVCRuntime'
  for (const marker of [sourceDirectory, directoriesInclude, pagesInclude, prerequisiteCall]) {
    if (source.split(marker).length !== 2) throw new Error(`Installer fixture requires one production marker: ${marker}`)
  }
  return source
    .replace(sourceDirectory, `!define INSTALLER_SOURCE_DIR "${join(appRoot, 'installer')}"`)
    .replace(directoriesInclude, `!include "${join(appRoot, 'scripts', 'installer-directories.nsh')}"`)
    .replace(pagesInclude, '!include "${INSTALLER_TEST_PAGES_FILE}"')
    .replace(prerequisiteCall, `${prerequisiteCall}
  Push $0
  Push $1
  \${GetParameters} $0
  ClearErrors
  \${GetOptions} $0 "/TEST_REBOOT_REQUIRED=" $1
  \${IfNot} \${Errors}
    \${If} $1 == "1"
      SetRebootFlag true
    \${EndIf}
  \${EndIf}
  ClearErrors
  Pop $1
  Pop $0`)
}

/** Instrument a private copy of the actual Finish callbacks and resolve includes at their original locations.
 * @param {string} source - Production page callbacks.
 * @returns {string} Unchanged launch/error operations with per-process, credential-free stage receipts.
 */
export function createInstallerTestPagesSource(source) {
  const replacements = [
    ['!include "${__FILEDIR__}\\path.nsh"', '!include "${INSTALLER_SOURCE_DIR}\\path.nsh"'],
    ['!include "${__FILEDIR__}\\drawing.nsh"', '!include "${INSTALLER_SOURCE_DIR}\\drawing.nsh"'],
    ['    SendMessage $HWNDPARENT ${WM_NOTIFY_OUTER_NEXT} 1 0',
      '    SendMessage $HWNDPARENT ${WM_NOTIFY_OUTER_NEXT} 1 0\n    !insertmacro InstallerFixtureTrace "outer-next-return" "" ""'],
    ['Function InstallerFinishLeave\n',
      'Function InstallerFinishLeave\n    !insertmacro InstallerFixtureTrace "finish-leave-entry" "" ""\n'],
    ['        Call InstallerStartApplication\n',
      '        Call InstallerStartApplication\n        !insertmacro InstallerFixtureTrace "finish-launch-return" "" ""\n'],
    ['        ${If} ${Errors}\n            Abort\n        ${EndIf}\n',
      '        ${If} ${Errors}\n            !insertmacro InstallerFixtureTrace "finish-leave-abort" "" ""\n            Abort\n        ${EndIf}\n'],
    ['    ${EndIf}\nFunctionEnd\n\nFunction InstallerStartApplication',
      '    ${EndIf}\n    !insertmacro InstallerFixtureTrace "finish-leave-return" "" ""\nFunctionEnd\n\nFunction InstallerStartApplication'],
    ['Function InstallerStartApplication\n',
      'Function InstallerStartApplication\n    !insertmacro InstallerFixtureTrace "application-launch-entry" "" ""\n'],
    ['        ${StdUtils.ExecShellAsUser} $1 "$INSTDIR\\${APP_EXECUTABLE_FILENAME}" "open" "$0"',
      '        !insertmacro InstallerFixtureTrace "before-launch" "elevated-shell" ""\n        ${StdUtils.ExecShellAsUser} $1 "$INSTDIR\\${APP_EXECUTABLE_FILENAME}" "open" "$0"\n        !insertmacro InstallerFixtureTrace "after-launch" "elevated-shell" "$1"'],
    ['        Exec \'"$INSTDIR\\${APP_EXECUTABLE_FILENAME}" $0\'', [
      '        !insertmacro InstallerFixtureTrace "before-launch" "direct-exec" ""',
      '        Exec \'"$INSTDIR\\${APP_EXECUTABLE_FILENAME}" $0\'',
      '        !insertmacro InstallerFixtureTrace "after-launch" "direct-exec" ""',
    ].join('\n')],
  ]
  for (const [marker, replacement] of replacements) {
    if (source.split(marker).length !== 2) throw new Error(`Installer page fixture requires one production marker: ${marker}`)
    source = source.replace(marker, replacement)
  }
  if (source.includes('${__FILEDIR__}')) throw new Error('Installer page fixture has an unresolved source-relative path')
  return `; Private test receipts preserve the NSIS error flag, stack and caller registers.
Var InstallerFixtureTraceStarted
!macro InstallerFixtureTrace Event Mode Result
    Push $0
    Push $1
    Push $2
    Push $3
    StrCpy $3 0
    IfErrors 0 +2
        StrCpy $3 1
    StrCpy $2 "\${Result}"
    System::Call 'kernel32::GetCurrentProcessId() i.r0'
    \${If} $InstallerFixtureTraceStarted == 1
        FileOpen $1 "\${INSTALLER_TEST_TRACE_DIR}\\finish-$0.jsonl" a
    \${Else}
        StrCpy $InstallerFixtureTraceStarted 1
        FileOpen $1 "\${INSTALLER_TEST_TRACE_DIR}\\finish-$0.jsonl" w
    \${EndIf}
    \${IfNot} \${Errors}
        FileSeek $1 0 END
        FileWrite $1 '{"event":"\${Event}","mode":"\${Mode}","result":"$2","errors":$3}$\\r$\\n'
        FileClose $1
    \${EndIf}
    \${If} $3 == 1
        SetErrors
    \${Else}
        ClearErrors
    \${EndIf}
    Pop $3
    Pop $2
    Pop $1
    Pop $0
!macroend

` + source
}

/** Confirm the real Registry64 receipt before running the native UI scenarios.
 * @param {unknown} receipt - Parsed prerequisite preparation receipt.
 */
export function assertVisualCppPrerequisiteReceipt(receipt) {
  if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) {
    throw new Error('Installer fixture requires its Visual C++ registry receipt')
  }
  const after = Reflect.get(receipt, 'after')
  const exitCode = Reflect.get(receipt, 'installExitCode')
  if (Reflect.get(receipt, 'version') !== 1 || Reflect.get(receipt, 'registryView') !== 'Registry64'
    || Reflect.get(receipt, 'registryPath') !== 'SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64'
    || Reflect.get(receipt, 'requiredVersion') !== '14.51.36247.0'
    || Reflect.get(receipt, 'passed') !== true || Reflect.get(receipt, 'rebootRequired') !== false
    || (exitCode !== null && exitCode !== 0) || typeof after !== 'object' || after === null
    || Reflect.get(after, 'installed') !== 1) {
    throw new Error('Installer fixture did not confirm an installed x64 runtime without a required restart')
  }
  const version = Reflect.get(after, 'version')
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error('Installer fixture requires the four-part Visual C++ registry version')
  }
  const parts = version.split('.').map(Number)
  const required = [14, 51, 36247, 0]
  if (parts.some(value => !Number.isSafeInteger(value))) throw new Error('Installer fixture has an invalid Visual C++ version')
  for (let index = 0; index < required.length; index++) {
    if (parts[index] < required[index]) throw new Error('Installer fixture Visual C++ runtime is older than 14.51.36247.0')
    if (parts[index] > required[index]) return
  }
}

/** Require the intended post-relaunch failure and independently observed cleanup.
 * @param {unknown} error - Child process failure from the negative UI scenario.
 * @param {unknown} receipt - Parsed cleanup receipt written by that scenario.
 */
export function assertInstallerNegativeControl(error, receipt) {
  if (!(error instanceof Error) || Reflect.get(error, 'code') !== 1
    || Reflect.get(error, 'signal') != null || Reflect.get(error, 'killed') === true) {
    throw new Error('Installer negative control must exit 1 without interruption')
  }
  if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) {
    throw new Error('Installer negative control requires its cleanup receipt')
  }
  const value = (key) => Reflect.get(receipt, key)
  const negativePid = value('negativeControlProcessId')
  const discovered = value('discoveredAppProcessIds')
  const remaining = value('remainingAppProcessIds')
  const cleanupFailures = value('cleanupFailures')
  if (value('primaryFailure') !== 'Injected automatic update failure after relaunch'
    || value('negativeControlRequested') !== true || value('negativeControlReached') !== true
    || !Number.isSafeInteger(negativePid) || negativePid <= 0
    || !Array.isArray(discovered) || !discovered.every(pid => Number.isSafeInteger(pid) && pid > 0)
    || !discovered.includes(negativePid) || !Array.isArray(remaining) || remaining.length !== 0
    || !Array.isArray(cleanupFailures) || cleanupFailures.length !== 0
    || value('applicationRemoved') !== true || value('uninstallerRemoved') !== true
    || value('installDirectoryExists') !== false || value('uninstallRegistryExists') !== false
    || value('uninstallExitCode') !== 0) {
    throw new Error('Installer negative control did not prove relaunch and complete cleanup')
  }
}
