/** Source preflight for native input evidence; Windows CI owns message and focus execution. */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const [ui, smoke, strings] = await Promise.all([
  readFile(new URL('./windows-installer-ui.ps1', import.meta.url), 'utf8'),
  readFile(new URL('./windows-installer-smoke.ps1', import.meta.url), 'utf8'),
  readFile(new URL('../installer/strings.nsh', import.meta.url), 'utf8'),
])

function buttonReadinessFailures(helper: string, scenario: string): string[] {
  const wait = scenario.slice(scenario.indexOf('function Wait-Control('), scenario.indexOf('function Start-Setup('))
  const click = scenario.slice(scenario.indexOf('function Click-Control('), scenario.indexOf('function Dismiss('))
  const finder = helper.slice(helper.indexOf('public static IntPtr FindButton('), helper.indexOf('static IntPtr FindTextCore('))
  const buttonWaits = [...scenario.matchAll(/Wait-Control \$\w+ \$copy\.INSTALLER_(?:INSTALL|BROWSE|FINISH|LAUNCH)\b([^\n]*)/gu)]
  const requirements: Record<string, boolean> = {
    exactButtonRoute: wait.includes('[switch]$Button') && wait.includes('if ($Button) { [InstallerCapture]::FindButton($Process.Id, $Text) }'),
    buttonClicks: click.includes('Wait-Control $Process $Text -Button'),
    buttonWaits: buttonWaits.length > 0 && buttonWaits.every(match => match[1]?.includes('-Button')),
    buttonPredicate: finder.includes('kind.ToString() == "Button" && text.ToString() == expected'),
    disabledCheckboxLookup: !finder.includes('IsWindowEnabled'),
    dialogTextRoute: wait.includes('elseif ($Dialog) { [InstallerCapture]::FindDialogText($Process.Id, $Text) }')
      && scenario.includes('Wait-Control $Process $Text -Dialog'),
    rebootStatusText: scenario.includes('Wait-Control $Process $copy.INSTALLER_REBOOT_REQUIRED)')
      && !scenario.includes('Wait-Control $Process $copy.INSTALLER_REBOOT_REQUIRED -Button'),
  }
  return Object.entries(requirements).filter(([, satisfied]) => !satisfied).map(([name]) => name)
}

function exitObservationFailures(helper: string, scenario: string): string[] {
  const start = scenario.slice(scenario.indexOf('function Start-TestProcess('), scenario.indexOf('function Wait-Control('))
  const finish = scenario.slice(scenario.indexOf('function Finish-Setup('), scenario.indexOf('function Run-Silent('))
  const recorded = finish.indexOf('[IO.File]::AppendAllText')
  const waitFailure = finish.indexOf('if ($waitError -or $waitReturned -ne $true)')
  const managedFailure = finish.indexOf('if ($observation.ManagedHasExited -ne $true')
  const nativeFailure = finish.indexOf('if ($observation.NativeWaitResult -ne 0')
  const requirements: Record<string, boolean> = {
    retainedOwnedHandle: helper.includes('IntPtr handle = process.Handle;') && !/CloseHandle|OpenProcess\(/u.test(helper)
      && start.includes('$processHandles.Add($process.Id, [InstallerCapture]::RetainProcessHandle($process))')
      && start.indexOf('$processes.Add($process)') > start.indexOf('RetainProcessHandle($process)'),
    acquisitionFailureCleanup: start.includes('$acquisitionFailure = $_') && start.includes('[void]$processes.Remove($process)')
      && start.includes('try { Stop-TestProcess $process } catch { $cleanupFailures.Add($_) }')
      && start.includes('throw $acquisitionFailure'),
    oneLaunchOwner: (scenario.match(/\bStart-Process\b/gu) ?? []).length === 1 && start.includes('Start-Process @parameters')
      && scenario.includes('[void]$processHandles.Remove($Process.Id)\n        $Process.Dispose()'),
    originalWait: finish.includes('$waitReturned = $Process.WaitForExit(10000)') && waitFailure >= 0,
    nonblockingNative: helper.includes('WaitForSingleObject(handle, 0)')
      && helper.includes('else if (result.NativeWaitResult == 0) {\n            uint code;\n            if (GetExitCodeProcess(handle, out code))'),
    nativeErrors: helper.includes('result.NativeWaitResult == UInt32.MaxValue')
      && (helper.match(/result.NativeWin32Error = Marshal.GetLastWin32Error\(\);/gu) ?? []).length === 2,
    managedFailurePreserved: managedFailure > waitFailure && nativeFailure > managedFailure
      && finish.includes('$observation.ManagedHasExitedError -or') && finish.includes('$observation.ManagedExitCodeError -or')
      && finish.includes('$null -eq $observation.ManagedExitCode -or $observation.ManagedExitCode -ne 0'),
    nativeZeroRequired: nativeFailure >= 0 && finish.includes('$null -ne $observation.NativeWin32Error -or')
      && finish.includes('$null -eq $observation.NativeExitCode -or $observation.NativeExitCode -ne 0'),
    receiptBeforeFailure: recorded >= 0 && recorded < waitFailure && finish.includes("'finish-exit.jsonl'")
      && finish.includes('[Text.UTF8Encoding]::new($false)')
      && ['theme = $Theme', 'launch = $Launch', 'processId = $Process.Id', 'processHandle = $handle.ToInt64()',
        'windowHandle = $window.ToInt64()', 'waitReturned = $waitReturned', 'waitElapsedMs = $waitTimer.ElapsedMilliseconds',
        'managedHasExited = $observation.ManagedHasExited', 'managedExitCode = $observation.ManagedExitCode',
        'nativeWaitResult = $observation.NativeWaitResult', 'nativeExitCode = $observation.NativeExitCode',
        'nativeWin32Error = $observation.NativeWin32Error', 'visibleTextDump = $visibleDump'].every(field => finish.includes(field)),
  }
  return Object.entries(requirements).filter(([, satisfied]) => !satisfied).map(([name]) => name)
}

function inputEvidenceFailures(helper: string, scenario: string): string[] {
  const action = scenario.slice(scenario.indexOf('function Set-PathInput('), scenario.indexOf('function Finish-Setup('))
  const recorded = action.indexOf('[IO.File]::AppendAllText')
  const submitted = action.indexOf('[InstallerCapture]::PostMessage')
  const requirements: Record<string, boolean> = {
    unicodeWrite: /EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode[^\n]*\n\s*static extern IntPtr WriteTextMessage/u
      .test(helper)
      && helper.includes('WriteTextMessage(edit, 0xC, UIntPtr.Zero, expected, 0x22, 5000, out result)'),
    unicodeRead: /EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode[^\n]*\n\s*static extern IntPtr ReadTextMessage/u
      .test(helper)
      && helper.includes('ReadTextMessage(edit, 0xD, new UIntPtr((uint)text.Capacity), text, 0x22, 5000, out result)'),
    writeResult: helper.includes('out result) == IntPtr.Zero || result == UIntPtr.Zero)'),
    readbackEquality: helper.includes('if (actual != expected) throw new InvalidOperationException'),
    ownedEdit: helper.includes('edit == IntPtr.Zero || !IsWindow(edit) || !IsWindowVisible(edit)')
      && helper.includes('owner != process || kind.ToString() != "Edit"'),
    focus: helper.includes('GetGUIThreadInfo(thread, ref info)') && helper.includes('if (info.Focus != edit) throw'),
    beforeEnter: action.includes('if ($actual -cne $Path)') && action.includes('focusHandle = $focus.ToInt64()')
      && action.includes('editHandle = $Edit.ToInt64()') && action.includes('windowHandle = $Window.ToInt64()')
      && action.includes('actual = $actual') && action.includes('expected = $Path')
      && action.includes("'input-actions.jsonl'") && action.includes('[Text.UTF8Encoding]::new($false)')
      && recorded >= 0 && submitted >= 0 && recorded < submitted,
    enterResult: action.includes('$PressEnter -and -not [InstallerCapture]::PostMessage'),
    strictInvalid: /Set-PathInput \$process \$window \$edit \$invalidPath -PressEnter\s+Dismiss \$process \$copy.INSTALLER_PATH_INVALID/u
      .test(scenario),
    actualDiagnostics: helper.includes('text.Append(ReadEditText(process, child))'),
  }
  return Object.entries(requirements).filter(([, satisfied]) => !satisfied).map(([name]) => name)
}

describe('Windows installer input evidence source preflight', () => {
  it('retains the Process-owned handle at launch and records strict managed/native exit evidence before failure', () => {
    expect(exitObservationFailures(ui, smoke)).toEqual([])
  })

  it.each([
    ['missing handle', ui.replace('IntPtr handle = process.Handle;', 'IntPtr handle = IntPtr.Zero;'), smoke, 'retainedOwnedHandle'],
    ['borrowed handle closed', ui + '\nCloseHandle(handle);', smoke, 'retainedOwnedHandle'],
    ['failed handle acquisition leaked', ui, smoke.replace('try { Stop-TestProcess $process } catch', 'try { } catch'), 'acquisitionFailureCleanup'],
    ['native second wait', ui.replace('WaitForSingleObject(handle, 0)', 'WaitForSingleObject(handle, 10000)'), smoke, 'nonblockingNative'],
    ['unsignaled exit read', ui.replace('else if (result.NativeWaitResult == 0)', 'else if (true)'), smoke, 'nonblockingNative'],
    ['missing Win32 error', ui.replaceAll('result.NativeWin32Error = Marshal.GetLastWin32Error();', 'result.NativeWin32Error = 0;'), smoke, 'nativeErrors'],
    ['wait timeout forgiven', ui, smoke.replace('if ($waitError -or $waitReturned -ne $true)', 'if ($waitError)'), 'originalWait'],
    ['managed null accepted', ui, smoke.replace('$null -eq $observation.ManagedExitCode -or', ''), 'managedFailurePreserved'],
    ['native nonzero accepted', ui, smoke.replace('$observation.NativeExitCode -ne 0', '$observation.NativeExitCode -lt 0'), 'nativeZeroRequired'],
    ['no durable exit receipt', ui, smoke.replace("'finish-exit.jsonl'", "'unused.jsonl'"), 'receiptBeforeFailure'],
  ])('rejects %s exit observation regression', (_name, helper, scenario, requirement) => {
    expect(exitObservationFailures(helper, scenario)).toContain(requirement)
  })

  it('uses exact Button lookup for waits and clicks while retaining disabled checkbox and dialog lookup', () => {
    expect(buttonReadinessFailures(ui, smoke)).toEqual([])
  })

  it('rejects the former default text route and omitted button waits', () => {
    const containsRoute = smoke.replace('[InstallerCapture]::FindButton($Process.Id, $Text)',
      '[InstallerCapture]::FindText($Process.Id, $Text)')
    expect(buttonReadinessFailures(ui, containsRoute)).toContain('exactButtonRoute')
    expect(buttonReadinessFailures(ui, smoke.replaceAll(' -Button', ''))).toEqual(['buttonClicks', 'buttonWaits'])
    const disabledFiltered = ui.replace('&& text.ToString() == expected)', '&& text.ToString() == expected && IsWindowEnabled(child))')
    expect(buttonReadinessFailures(disabledFiltered, smoke)).toContain('disabledCheckboxLookup')
  })

  it('covers the actual Chinese Browse caption contained in Choose location without accepting substring readiness', () => {
    const choose = /^LangString INSTALLER_CHOOSE_PATH \$\{LANG_SIMPCHINESE\} "(.*)"$/mu.exec(strings)?.[1]
    const browse = /^LangString INSTALLER_BROWSE \$\{LANG_SIMPCHINESE\} "(.*)"$/mu.exec(strings)?.[1]
    if (choose === undefined || browse === undefined) throw new Error('Chinese installer captions are missing')
    expect(choose).toBe('选择安装位置')
    expect(browse).toBe('选择')
    expect(choose.includes(browse)).toBe(true)
    expect(choose === browse).toBe(false)
    expect(buttonReadinessFailures(ui, smoke)).toEqual([])
  })

  it('requires owned Unicode readback and focus evidence before Enter', () => {
    expect(inputEvidenceFailures(ui, smoke)).toEqual([])
    expect(smoke).not.toMatch(/SendMessage\(\$edit, 0xC/u)
    expect(smoke).toContain('$editAfterBrowse -ne $edit')
    expect(smoke).toContain("throw 'Path input accepted another process identity'")
    expect(smoke).toContain("[InstallerCapture]::SetEditText(0, $edit, 'foreign-owner-negative-control')")
  })

  it.each([
    ['cached caption', ui.replace('ReadTextMessage(edit, 0xD,', 'GetWindowText(edit,'), smoke, 'unicodeRead'],
    ['unchecked write', ui.replace(' || result == UIntPtr.Zero)', ')'), smoke, 'writeResult'],
    ['missing equality', ui.replace('if (actual != expected) throw', 'if (false) throw'), smoke, 'readbackEquality'],
    ['foreign owner', ui.replace('owner != process || kind.ToString() != "Edit"', 'kind.ToString() != "Edit"'), smoke, 'ownedEdit'],
    ['unverified focus', ui.replace('if (info.Focus != edit) throw', 'if (false) throw'), smoke, 'focus'],
    ['missing actual input', ui, smoke.replace('actual = $actual', 'caption = $actual'), 'beforeEnter'],
    ['missing durable input receipt', ui, smoke.replace('[IO.File]::AppendAllText', '[IO.File]::WriteAllText'), 'beforeEnter'],
    ['unchecked Enter', ui, smoke.replace('$PressEnter -and -not [InstallerCapture]::PostMessage', '$PressEnter -and [InstallerCapture]::PostMessage'), 'enterResult'],
    ['weakened path rejection', ui, smoke.replace('Dismiss $process $copy.INSTALLER_PATH_INVALID', 'Dismiss $process $copy.INSTALLER_PATH_OWNERSHIP'), 'strictInvalid'],
  ])('rejects %s source regression', (_name, helper, scenario, requirement) => {
    expect(inputEvidenceFailures(helper, scenario)).toContain(requirement)
  })

  it('covers canonical drive roots and Windows directory aliases using the runner environment', () => {
    expect(smoke).toContain('WINDIR = $env:WINDIR')
    expect(smoke).toContain("$windowsPath = $protectedDirectories.WINDIR.TrimEnd('\\')")
    expect(smoke).toContain("(Join-Path $windowsPath 'Harness Installer Test')")
    expect(smoke).toContain("([IO.Path]::GetPathRoot($installPath) + '\\')")
    expect(smoke).toContain("($windowsPath + '\\')")
    expect(smoke).toContain("($windowsPath + '\\\\Harness Installer Test')")
    expect(smoke).not.toContain('C:\\Windows\\Harness Installer Test')
  })

  it('requires protected directory values and rejects exact, trailing and repeated separator aliases', () => {
    expect(smoke).toContain("'ProgramFiles(x86)' = ${env:ProgramFiles(x86)}")
    expect(smoke).toContain('ProgramFiles = $env:ProgramFiles')
    expect(smoke).toContain('USERPROFILE = $env:USERPROFILE')
    expect(smoke).toContain('LOCALAPPDATA = $env:LOCALAPPDATA')
    expect(smoke).toContain('[string]::IsNullOrWhiteSpace($protectedDirectory.Value)')
    expect(smoke).toContain('throw "Native invalid-path fixture requires environment variable $($protectedDirectory.Key)"')
    expect(smoke).toContain("@('ProgramFiles(x86)', 'ProgramFiles', 'USERPROFILE', 'LOCALAPPDATA')")
    expect(smoke).toContain("$invalidPaths += @($protectedPath, ($protectedPath + '\\'))")
    expect(smoke).toContain("($protectedDirectories.ProgramFiles.TrimEnd('\\') + '\\\\Harness Installer Test')")
    expect(smoke).toContain('foreach ($invalidPath in $invalidPaths)')
  })

  it('captures visible failure windows before cleanup while preserving the initial error', () => {
    const failure = smoke.slice(smoke.indexOf('} catch {\n    $primaryFailure = $_'), smoke.indexOf('} finally {\n    foreach ($process'))
    expect(failure).toContain('[InstallerCapture]::VisibleWindows($process.Id)')
    expect(failure).toContain('[InstallerCapture]::SaveVisibleDesktop($failureWindow,')
    expect(failure).not.toContain('SaveNative')
    expect(failure).toContain('"failure-window-$($failureWindow.ToInt64()).png"')
    expect(failure).toMatch(/catch \{\s+Write-Output "Installer failure screenshot could not be saved: \$_"\s+\}\s+throw/u)
    const capture = ui.slice(ui.indexOf('public static string SaveVisibleDesktop('), ui.indexOf('public static IntPtr TopLevel('))
    expect(capture).toContain('graphics.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(width, height))')
    expect(capture).not.toMatch(/PrintWindow|SendMessage|Thread.Sleep/u)
  })

  it('writes historical registered separators before real upgrades and requires canonical registration afterward', () => {
    expect(smoke).toContain('Set-ItemProperty -LiteralPath $key -Name InstallLocation -Value $Path')
    expect(smoke).toContain('if ((Get-ItemProperty -LiteralPath $key).InstallLocation -cne $Path)')
    expect(smoke).toMatch(/Set-RegisteredPathForUpdate \(\$installPath \+ '\\'\)\s+\$process = Start-Setup dark ''/u)
    expect(smoke).toMatch(/Set-RegisteredPathForUpdate \(\$installPath \+ '\\\\'\)\s+\$process = Start-TestProcess/u)
    expect(smoke).toContain('$registration.InstallLocation -cne $installPath')
    expect(smoke).toContain("throw 'Automatic update did not canonicalize historical InstallLocation'")
    expect(smoke).not.toContain('$registration.InstallLocation.TrimEnd')
    expect(smoke.indexOf("throw 'Automatic update did not canonicalize historical InstallLocation'"))
      .toBeLessThan(smoke.indexOf('if ($FailAfterAutomaticRelaunch)'))
  })
})
