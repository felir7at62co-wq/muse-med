# 把这台机器恢复原样：删掉三个测试草稿、删掉素材目录、还原索引备份。
# 测试完随手跑一下，不留痕迹。

$ErrorActionPreference = "Continue"
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8

$Root = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content (Join-Path $Root "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json

. (Join-Path $PSScriptRoot "_jyproc.ps1")

# 导入记录：只有导入器知道它到底建了哪几个文件夹（撞名时会变成「名字（2）」）。
. (Join-Path $PSScriptRoot "_draftname.ps1")
# 读剪映的全局设置：草稿位置 / 素材下载位置（2026-10-23）。只读，绝不改写。
. (Join-Path $PSScriptRoot "_jysettings.ps1")

# 与导入器同一口径（2026-10-23）：草稿位置、素材目录都跟随剪映设置。
$jySettings = Read-JianyingSettings
$draftRoot = Get-JianyingDraftRoot $jySettings
if (-not $draftRoot) {
    Add-Type -AssemblyName System.Windows.Forms
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = "请选择剪映的草稿位置"
    if ($dlg.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 1 }
    $draftRoot = $dlg.SelectedPath
}
$matDir = (Resolve-MaterialDir $jySettings).dir

# 剪映开着的时候草稿目录里的文件是被占用的，删不干净还不出错——所以这里也接管
# 一次进程。与导入器同一套实现，行为一致。
$jyWasRunning = @(Get-JianyingProcs).Count -gt 0
$jyExe = $null
if ($jyWasRunning) { $jyExe = Get-JianyingExe; Write-Host "正在关闭剪映以便清理…" }
$jyClosed = $false
if ($jyWasRunning) { $jyClosed = Stop-Jianying }

# ⚠️ 不能按 manifest 里的名字删（2026-10-20）。导入器撞名时会存成「名字（2）」，
#    原名那份可能是**用户自己建的**。删掉它就是把用户的作品删了，而且不可逆。
#    只删导入记录里记着的（导入器自己建的），并且逐条确认目录真的存在。
# 记录可能在旧素材目录里（用户在剪映里改过素材位置，或从旧版升上来）。
# 只读当前目录的话会报"没有导入记录"，然后一个草稿都不删。
$records = @()
foreach ($cand in (Get-MaterialDirCandidates $jySettings)) {
    $records += @(Read-ImportRecords $cand)
}
if ($records.Count -eq 0) { $records = @(Read-ImportRecords $matDir) }
$removed = 0
if ($records.Count -eq 0) {
    Write-Host "没有导入记录，跳过草稿清理（可能是旧版导入器导入的）。"
    Write-Host "如果草稿箱里有镜流导入的草稿，请手动删除。"
} else {
    $seen = @{}
    foreach ($r in $records) {
        if ([string]::IsNullOrWhiteSpace($r.folder)) { continue }
        if ($seen.ContainsKey($r.folder)) { continue }   # 同一次导入可能重跑过
        $seen[$r.folder] = $true
        $p = Join-Path $draftRoot $r.folder
        # -LiteralPath：草稿名里可能有方括号，通配符解析会把「不存在」判成存在
        if (Test-Path -LiteralPath $p) {
            Remove-Item -LiteralPath $p -Recurse -Force
            Write-Host "已删除草稿 $($r.folder)"
            $removed++
        }
    }
    Write-Host "共删除 $removed 个由镜流导入的草稿。"
}

# 索引备份还原（取最新的一份）
$idx = Join-Path $draftRoot "root_draft_meta_info.json"
$bak = Get-ChildItem "$idx.bak.*" -ErrorAction SilentlyContinue |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($bak) {
    Copy-Item $bak.FullName $idx -Force
    Write-Host "已还原索引备份: $($bak.Name)"
} else {
    Write-Host "没有索引备份需要还原（说明没跑过注册脚本）"
}

# $matDir 在文件上方已经算好（导入记录要用），这里复用，别再算一遍。
if (Test-Path $matDir) { Remove-Item $matDir -Recurse -Force; Write-Host "已删除素材目录: $matDir" }

# 老版本把素材写死在「文档\镜流素材」（2026-10-23 前的行为）。用户升级后那几十 GB
# 还堆在 C 盘上，不在这儿顺手清掉就永远没人清。只在路径不同、且确实是镜流建的
# （有导入记录或导入日志）时才删 —— 不能仅凭目录名就删一个用户自己的目录。
$docsOld = [Environment]::GetFolderPath("MyDocuments")
if (-not [string]::IsNullOrEmpty($docsOld)) {
    $legacy = Join-Path $docsOld "镜流素材"
    if ((Test-Path $legacy) -and
        ($legacy.TrimEnd('\') -ne $matDir.TrimEnd('\'))) {
        if ((Test-Path (Join-Path $legacy "导入日志.txt")) -or
            (Test-Path (Join-Path $legacy "导入记录.json"))) {
            Remove-Item $legacy -Recurse -Force
            Write-Host "已删除旧位置的老素材目录: $legacy"
        } else {
            Write-Host "发现疑似旧素材目录，但没有镜流的导入记录，未删除: $legacy"
        }
    }
}

# 卸完了把剪映还回去：是我们关的，就该我们打开。
# 注意这一步必须在**删完素材目录之后**——素材目录里有 `导入器` 副本，
# 而正在运行的脚本本体可能就在那里；先删目录再启动没有影响（进程已加载），
# 反过来先启动了剪映则不影响删除。顺序上无冲突，但保持"先清理后交还"更好读。
if ($jyClosed) { [void](Start-Jianying $jyExe) }

Write-Host "清理完成。"
Read-Host "回车退出"
