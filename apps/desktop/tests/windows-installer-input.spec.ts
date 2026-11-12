/** Source preflight and private native-window regression; CI owns full installer input execution. */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
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

function automaticCaptureFailures(helper: string, scenario: string): string[] {
  const capture = helper.slice(helper.indexOf('public static bool TrySaveAutomaticProgress('), helper.indexOf('public static IntPtr TopLevel('))
  const automatic = scenario.slice(scenario.indexOf('# The /S argument models older Muse updaters;'), scenario.indexOf("$results.Add('automatic-update-shows-progress-and-relaunches-without-finish-click')"))
  const completion = automatic.indexOf('if ($process.ExitCode -ne 0 -or -not $observedProgress -or -not $observedComplete -or -not $capturedProgress)')
  const requirements: Record<string, boolean> = {
    noWaitOnTransientWindow: capture.includes('window == IntPtr.Zero || !IsWindow(window)')
      && capture.includes('GetProp(window, "HarnessInstaller.Ready") == IntPtr.Zero')
      && !/Reveal\(|SaveNative\(|Thread.Sleep|PrintWindow/u.test(capture),
    ownedWindow: capture.includes('GetWindowThreadProcessId(window, out owner)')
      && capture.includes('if (owner != process) throw'),
    realCapture: capture.includes('SaveVisibleDesktop(window, path);'),
    onlyClosedWindowRetry: capture.includes('catch (ArgumentException)')
      && capture.includes('if (!IsWindow(window) || !IsWindowVisible(window)) return false;\n            throw;'),
    retryUntilCaptured: automatic.includes('$capturedProgress = $false')
      && automatic.includes('if (-not $capturedProgress)')
      && automatic.includes('$capturedProgress = [InstallerCapture]::TrySaveAutomaticProgress($process.Id, $window,')
      && !automatic.includes('[InstallerCapture]::Save('),
    allEvidenceBeforeInjection: completion >= 0 && completion < automatic.indexOf('if ($FailAfterAutomaticRelaunch)'),
  }
  return Object.entries(requirements).filter(([, satisfied]) => !satisfied).map(([name]) => name)
}

describe('Windows installer input evidence source preflight', () => {
  it('retries transient progress capture without waiting while requiring actual screenshot and completion before the negative control', () => {
    expect(automaticCaptureFailures(ui, smoke)).toEqual([])
  })

  it.each([
    ['stale HWND wait', ui.replace('SaveVisibleDesktop(window, path);', 'Save(window, path); Reveal(window);'), smoke, 'noWaitOnTransientWindow'],
    ['foreign HWND', ui.replace('if (owner != process) throw', 'if (false) throw'), smoke, 'ownedWindow'],
    ['no screenshot', ui.replace('SaveVisibleDesktop(window, path);', ''), smoke, 'realCapture'],
    ['swallowed screenshot error', ui.replace('catch (ArgumentException)', 'catch (Exception)'), smoke, 'onlyClosedWindowRetry'],
    ['one capture attempt', ui, smoke.replace('if (-not $capturedProgress)', 'if (-not $observedProgress)'), 'retryUntilCaptured'],
    ['missing capture requirement', ui, smoke.replace(' -or -not $capturedProgress)', ')'), 'allEvidenceBeforeInjection'],
  ])('rejects %s automatic progress regression', (_name, helper, scenario, requirement) => {
    expect(automaticCaptureFailures(helper, scenario)).toContain(requirement)
  })

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
    ['wait timeout forgiven', ui, smoke.replaceAll('if ($waitError -or $waitReturned -ne $true)', 'if ($waitError)'), 'originalWait'],
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
    ['missing durable input receipt', ui, smoke.replaceAll('[IO.File]::AppendAllText', '[IO.File]::WriteAllText'), 'beforeEnter'],
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

it.runIf(process.platform === 'win32')('replays an expired progress HWND and then captures a ready owned window without hiding screenshot errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'muse-progress-capture-'))
  const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`
  const script = join(directory, 'progress-replay.ps1')
  await writeFile(script, `\uFEFF
$ErrorActionPreference = 'Stop'
. ${literal(fileURLToPath(new URL('./windows-installer-ui.ps1', import.meta.url)))}
[InstallerCapture]::Initialize()
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ProgressCaptureFixture {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowEx(uint exStyle, string kind, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool SetProp(IntPtr window, string name, IntPtr value);
    [DllImport("user32.dll")] public static extern bool DestroyWindow(IntPtr window);
    public static IntPtr Create() {
        IntPtr window = CreateWindowEx(0, "STATIC", "Private progress capture fixture", 0x90000000, 64, 64, 64, 64, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (window == IntPtr.Zero) throw new InvalidOperationException("Could not create private capture fixture");
        return window;
    }
}
'@
$path = ${literal(join(directory, 'progress.png'))}
$window = [ProgressCaptureFixture]::Create()
try {
    $unready = [InstallerCapture]::TrySaveAutomaticProgress($PID, $window, $path)
    [void][ProgressCaptureFixture]::DestroyWindow($window)
    $stale = $window
    $window = [IntPtr]::Zero
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $expired = [InstallerCapture]::TrySaveAutomaticProgress($PID, $stale, $path)
    $retryMs = $timer.ElapsedMilliseconds
    $oldFailure = $null
    try { [void][InstallerCapture]::Save($stale, $path) } catch { $oldFailure = $_.Exception.ToString() }
    if (-not $oldFailure -or -not $oldFailure.Contains('Native page did not finish creating controls')) { throw 'Legacy stale-HWND path did not reproduce' }
    $window = [ProgressCaptureFixture]::Create()
    if (-not [ProgressCaptureFixture]::SetProp($window, 'HarnessInstaller.Ready', [IntPtr]1)) { throw 'Could not mark private capture fixture ready' }
    $captured = [InstallerCapture]::TrySaveAutomaticProgress($PID, $window, $path)
    $foreignRejected = $false
    try { [void][InstallerCapture]::TrySaveAutomaticProgress(($PID + 1), $window, $path) } catch { $foreignRejected = $_.Exception.ToString().Contains('another process') }
    $writeRejected = $false
    try { [void][InstallerCapture]::TrySaveAutomaticProgress($PID, $window, ${literal(join(directory, 'missing-directory', 'progress.png'))}) } catch { $writeRejected = $true }
    [ordered]@{ unready=$unready; expired=$expired; retryMs=$retryMs; legacyTimeout=$true; captured=$captured; bytes=(Get-Item -LiteralPath $path).Length; foreignRejected=$foreignRejected; writeRejected=$writeRejected } | ConvertTo-Json -Compress
} finally {
    if ($window -ne [IntPtr]::Zero) { [void][ProgressCaptureFixture]::DestroyWindow($window) }
}
`, 'utf8')
  try {
    const { stdout } = await promisify(execFile)('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    ], { timeout: 25000, windowsHide: true })
    const evidence = JSON.parse(stdout.trim()) as Record<string, unknown>
    expect(evidence).toMatchObject({
      unready: false, expired: false, legacyTimeout: true, captured: true, foreignRejected: true, writeRejected: true,
    })
    expect(evidence.retryMs).toBeLessThan(1000)
    expect(evidence.bytes).toBeGreaterThan(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
