$ErrorActionPreference = 'Stop'
$package = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$scripts = Join-Path $package 'skills/xiaohongshu-reference/scripts'
$tokens = $null
$errors = $null
$installer = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $scripts 'install_xiaohongshu_mcp.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Installer syntax failed' }
$default = ($installer.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'InstallDir' }).DefaultValue.Extent.Text
$starter = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $scripts 'start_xiaohongshu_mcp.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Starter syntax failed' }
$assignments = $starter.EndBlock.Statements | Where-Object {
    $_ -is [System.Management.Automation.Language.AssignmentStatementAst] -and $_.Left.Extent.Text -in '$dshHome', '$runtime'
}
if (@($assignments).Count -ne 2) { throw 'Expected two runtime path assignments' }
$previousHome = $env:DSH_HOME
$previousRuntime = $env:XIAOHONGSHU_RUNTIME
try {
    foreach ($mode in 'home', 'override', 'default-home') {
        $env:DSH_HOME = if ($mode -eq 'default-home') { '' } else { Join-Path $package 'tests/fictional-home' }
        $env:XIAOHONGSHU_RUNTIME = if ($mode -eq 'override') { Join-Path $package 'tests/fictional-runtime' } else { '' }
        $expected = if ($mode -eq 'override') { $env:XIAOHONGSHU_RUNTIME } elseif ($mode -eq 'home') { Join-Path $env:DSH_HOME 'xiaohongshu-runtime' } else { Join-Path (Join-Path $HOME '.dsh') 'xiaohongshu-runtime' }
        # Evaluate only parsed path expressions, never installer or starter commands.
        $installed = Invoke-Expression $default
        foreach ($assignment in $assignments) { Invoke-Expression $assignment.Extent.Text }
        if ($installed -ne $expected -or $runtime -ne $expected) { throw "Runtime path differs for $mode" }
    }
    'PASS: three runtime path modes; no installer, network or MCP process executed'
}
finally {
    $env:DSH_HOME = $previousHome
    $env:XIAOHONGSHU_RUNTIME = $previousRuntime
}
