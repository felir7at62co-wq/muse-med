# 镜流 · 草稿索引登记（仅在「草稿箱里看不到」时才需要运行）
#
# 剪映的草稿列表读的是草稿根目录下的 root_draft_meta_info.json 索引；
# 有些版本不扫目录，只认索引里登记过的条目。本脚本往索引里补几条。
#
# ⚠️ 为什么必须先把剪映关掉：**索引的所有者是剪映进程，不是磁盘上这个文件**。
#    它启动时把索引读进内存，之后按内存里的清单整体写回。开着的时候往里面加
#    条目，要么被忽略、要么在它下次写回时被覆盖——白改。所以本脚本自己关进程，
#    写完再拉起来（冷启动同样会重扫草稿目录）。
#
# 安全约定：**先整文件备份**，且只做追加；不改动你已有的任何一条草稿。
# 反悔就双击「一键卸载.bat」，它会把备份还原回去。

param(
    # 不接管剪映进程：交给用户自己关（旧行为）。剪映没关干净时索引会被覆盖。
    [switch]$KeepJianying
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8

$Root = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content (Join-Path $Root "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json

# 关/开剪映的那几个函数与导入器共用一份实现，避免两边漂移。
. (Join-Path $PSScriptRoot "_jyproc.ps1")

# 「这次导入实际落在哪个文件夹」要从导入记录里查——撞名时它不叫 manifest 里的名字。
. (Join-Path $PSScriptRoot "_draftname.ps1")
# 读剪映的全局设置：草稿位置 / 素材下载位置（2026-10-23）。只读，绝不改写。
. (Join-Path $PSScriptRoot "_jysettings.ps1")

# 与导入器同一口径（2026-10-23）：草稿位置、素材目录都**跟随剪映设置**，
# 不再写死 %LOCALAPPDATA% 与「我的文档」。导入记录文件放在素材目录里，
# 两边必须算出同一个路径，否则这里找不到导入器刚写的那条记录。
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

$idx = Join-Path $draftRoot "root_draft_meta_info.json"
if (-not (Test-Path $idx)) {
    Write-Host "这个目录下没有 root_draft_meta_info.json —— 说明你的剪映不靠索引列草稿。"
    Write-Host "那草稿看不到就是别的原因（多半是草稿本身被拒），请把导入日志发回。"
    Read-Host "回车退出"; exit 0
}

# ---------- 先关剪映，再改索引 ----------
# 顺序不能反：先改再关的话，剪映退出时会把内存里的旧清单写回，把刚登记的条目抹掉。
$jyProcs = @(Get-JianyingProcs)
$jyWasRunning = $jyProcs.Count -gt 0
$jyExe = $null
if ($jyWasRunning) { $jyExe = Get-JianyingExe }

$jyClosed = $false
if ($jyWasRunning -and -not $KeepJianying) {
    Write-Host "检测到剪映正在运行 —— 索引会被它的内存清单覆盖，先帮它退出。"
    $jyClosed = Stop-Jianying
    if ($jyClosed) { Write-Host "剪映已退出。" }
    else { Write-Host "⚠ 剪映仍在运行，登记结果可能被覆盖。" }
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item $idx "$idx.bak.$stamp"
Write-Host "已备份索引: $idx.bak.$stamp"

$json = Get-Content $idx -Raw -Encoding UTF8 | ConvertFrom-Json

# 索引里装草稿条目的那个数组，各版本键名不一定相同——按"元素带 draft_id"来认，
# 而不是写死键名。写死的话换个版本就静默找不到，反而更糟。
$listProp = $null
foreach ($p in $json.PSObject.Properties) {
    if ($p.Value -is [Array] -and $p.Value.Count -gt 0 -and
        ($p.Value[0].PSObject.Properties.Name -contains "draft_id")) {
        $listProp = $p; break
    }
}
if (-not $listProp) {
    Write-Host "索引里没找到可用的草稿条目做模板（草稿箱可能是空的）。"
    Write-Host "请先在剪映里随便新建一个草稿再重跑本脚本。"
    # 已经替用户关掉的剪映要还回去，否则就留了个烂摊子
    if ($jyClosed -or (-not $jyWasRunning)) { [void](Start-Jianying $jyExe) }
    Read-Host "回车退出"; exit 1
}
Write-Host "索引字段: $($listProp.Name)，现有 $($listProp.Value.Count) 条"

# 克隆一条真实条目当模板：这样不需要知道完整 schema，缺字段的风险最低
$template = $listProp.Value[0]
$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() * 1000   # 剪映用微秒

$added = New-Object System.Collections.ArrayList
foreach ($item in $listProp.Value) { [void]$added.Add($item) }

foreach ($d in $manifest.drafts) {
    # ⚠️ 不能用 `$d.name` 直接拼路径（2026-10-20）：导入器在撞名时会把这份
    #    草稿存成「名字（2）」，manifest 里的名字是**包里的原名**，两者已经不同。
    #    照原名登记 = 索引指向一个不存在的目录，剪映里那张卡片点进去是坏的。
    #    先问导入记录：它记着这次导入**实际**落在哪个文件夹。
    # 导入记录跟着素材目录走。用户在剪映里改了素材位置之后，上一批导入的记录
    # 还留在旧目录里 —— 只翻当前目录会误判成"没导入过"，于是跳过登记。
    $folderName = $null
    foreach ($cand in (Get-MaterialDirCandidates $jySettings)) {
        $folderName = Find-ImportedFolder -MatDir $cand -DraftRoot $draftRoot -PackName $d.name
        if ($folderName) { break }
    }
    if (-not $folderName) { $folderName = Find-ImportedFolder -MatDir $matDir -DraftRoot $draftRoot -PackName $d.name }
    if (-not $folderName) {
        Write-Host "  $($d.name) 没在草稿目录里找到，跳过（先跑一次导入器）"
        continue
    }

    $exists = $listProp.Value | Where-Object { $_.draft_name -eq $folderName }
    if ($exists) { Write-Host "  $folderName 已在索引里，跳过"; continue }

    $e = $template | ConvertTo-Json -Depth 100 | ConvertFrom-Json   # 深拷贝
    $folder = Join-Path $draftRoot $folderName
    $meta = Get-Content (Join-Path $folder "draft_meta_info.json") -Raw -Encoding UTF8 | ConvertFrom-Json

    $set = @{
        draft_id          = $meta.draft_id
        draft_name        = $folderName
        draft_fold_path   = $folder.Replace("\", "/")
        draft_json_file   = "$($folder.Replace('\','/'))/draft_content.json"
        tm_draft_create   = $now
        tm_draft_modified = $now
        tm_duration       = $meta.tm_duration
    }
    if ($d.cover) { $set["draft_cover"] = "$($folder.Replace('\','/'))/$($d.cover)" }

    foreach ($k in $set.Keys) {
        if ($e.PSObject.Properties.Name -contains $k) { $e.$k = $set[$k] }
    }
    [void]$added.Add($e)
    Write-Host "  已登记 $folderName"
}

$json.($listProp.Name) = $added.ToArray()
[IO.File]::WriteAllText($idx, ($json | ConvertTo-Json -Depth 100 -Compress),
                        (New-Object Text.UTF8Encoding $false))

# 索引写完了才把剪映拉起来——冷启动时它会重读索引并重扫草稿目录。
if (-not $KeepJianying) {
    if ($jyClosed -or (-not $jyWasRunning)) { [void](Start-Jianying $jyExe) }
}

Write-Host ""
Write-Host "完成。剪映草稿箱里应该有刚登记的那几条了。"
if ($KeepJianying -and $jyWasRunning) {
    Write-Host "⚠ 你用了 -KeepJianying：请自己**完全退出剪映再重新打开**，否则登记不生效。"
}
Read-Host "回车退出"
