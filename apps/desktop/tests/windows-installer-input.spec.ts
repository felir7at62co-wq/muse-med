/** Source preflight for native input evidence; Windows CI owns message and focus execution. */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const [ui, smoke] = await Promise.all([
  readFile(new URL('./windows-installer-ui.ps1', import.meta.url), 'utf8'),
  readFile(new URL('./windows-installer-smoke.ps1', import.meta.url), 'utf8'),
])

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
    expect(smoke).toMatch(/Set-RegisteredPathForUpdate \(\$installPath \+ '\\\\'\)\s+\$process = Start-Process/u)
    expect(smoke).toContain('$registration.InstallLocation -cne $installPath')
    expect(smoke).toContain("throw 'Automatic update did not canonicalize historical InstallLocation'")
    expect(smoke).not.toContain('$registration.InstallLocation.TrimEnd')
    expect(smoke.indexOf("throw 'Automatic update did not canonicalize historical InstallLocation'"))
      .toBeLessThan(smoke.indexOf('if ($FailAfterAutomaticRelaunch)'))
  })
})
