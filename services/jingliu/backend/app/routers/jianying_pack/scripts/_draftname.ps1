# 镜流 · 草稿命名（内部模块，由 import.ps1 / register.ps1 / uninstall.ps1 点源加载）
#
# ## 为什么需要它（2026-10-20）
#
# 导入器原来在目标目录已存在同名草稿时，**直接递归删除再写入**：
#
#     if (Test-Path $target) { Remove-Item $target -Recurse -Force }
#
# 而草稿名固定是「项目名-第N集」，同一个项目导出第二次必然撞名 ——
# 用户上一版剪到一半的草稿就这样没了，且**没有任何提示**。
#
# 现在改为：撞名时改用「名字（2）」「名字（3）」写一份新的，旧的原样保留。
# 用户要的是"再给我一版"，不是"覆盖我上一版"。
#
# ## 为什么不用随机后缀
#
# 剪映草稿箱是按名字列的。随机串（`-a3f9`）会让人分不清哪份是刚导的。
# `（2）` 是 Windows 资源管理器的既有惯例，用户一眼就懂。
#
# 全角括号而不是半角：中文片名配全角更整齐；而且半角 `(2)` 与全角 `（2）`
# 混着用会让草稿箱的排序看起来是乱的。

# Windows 不允许出现在文件名里的字符。
#
# 刻意**写死而不是用 [IO.Path]::GetInvalidFileNameChars()**：后者在 Linux 上
# 只返回 NUL 和斜杠，于是同一段判据在 CI（Linux）与用户机器（Windows）上行为
# 不同 —— 那正是"测试全绿、上线就炸"的经典来源。
$script:InvalidNameChars = [char[]]@('<', '>', ':', '"', '/', '\', '|', '?', '*')

function Get-SafeDraftName {
    <#
    .SYNOPSIS
    把任意标题变成可用的草稿文件夹名。空串给一个兜底名。
    #>
    param([string]$Name)

    if ([string]::IsNullOrWhiteSpace($Name)) { return "未命名草稿" }

    $sb = New-Object Text.StringBuilder
    foreach ($ch in $Name.ToCharArray()) {
        if ([int]$ch -lt 32 -or ($script:InvalidNameChars -contains $ch)) {
            [void]$sb.Append('_')
        } else {
            [void]$sb.Append($ch)
        }
    }
    # Windows 不允许文件夹名以点或空格结尾（Test-Path 会静默判成不存在）
    $out = $sb.ToString().Trim().TrimEnd('.')
    if ([string]::IsNullOrWhiteSpace($out)) { return "未命名草稿" }
    return $out
}

function Resolve-DraftTarget {
    <#
    .SYNOPSIS
    在本机草稿根目录里挑一个**还不存在**的草稿名。

    .DESCRIPTION
    返回 @{ Name = '名（2）'; Renamed = $true }。调用方据此决定是否要重写
    草稿里的 name 字段、以及是否要换一个新的 draft_id。
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Wanted,
        # 上限：被占满就退到时间戳，不无限试下去（全被占时会卡死在这里）
        [int]$MaxIndex = 99
    )

    $name = Get-SafeDraftName $Wanted
    $renamed = ($name -ne $Wanted)

    # 必须用 -LiteralPath：草稿名里可能有方括号，Test-Path 会把它们当通配符，
    # 于是「不存在」被判成「存在」，白白多起一个序号。
    if (-not (Test-Path -LiteralPath (Join-Path $Root $name))) {
        return @{ Name = $name; Renamed = $renamed }
    }

    for ($i = 2; $i -le $MaxIndex; $i++) {
        $cand = "$name（$i）"
        if (-not (Test-Path -LiteralPath (Join-Path $Root $cand))) {
            return @{ Name = $cand; Renamed = $true }
        }
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    return @{ Name = "$name（$stamp）"; Renamed = $true }
}

# ---------------------------------------------------------------------------
# 导入记录：哪几次导入真的落到了哪个文件夹
# ---------------------------------------------------------------------------
#
# ## 为什么必须记
#
# 「一键卸载」要删草稿。有了自动改名之后，**不能再按 manifest 的名字删**：
# 那会把用户自己建的同名草稿删掉。也不能按「名字（2）」这个模式去猜 ——
# 用户完全可能自己就有一个「名字（2）」。
#
# 所以：导入器把**自己刚建的**那几个文件夹记下来，卸载只删记录里的。
# 宁可少删（留一个目录让用户手动删），也不能删错。

$script:RecordFileName = "导入记录.json"
$script:RecordKeep = 200      # 只留最近 200 条，避免长期使用后无限增长

function Get-ImportRecordPath {
    param([Parameter(Mandatory = $true)][string]$MatDir)
    return (Join-Path $MatDir $script:RecordFileName)
}

function Read-ImportRecords {
    param([Parameter(Mandatory = $true)][string]$MatDir)

    $p = Get-ImportRecordPath $MatDir
    if (-not (Test-Path -LiteralPath $p)) { return @() }
    try {
        $raw = Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -eq $raw -or $null -eq $raw.drafts) { return @() }
        return @($raw.drafts)
    } catch {
        # 记录坏了不能让导入失败 —— 它只是卸载用的白名单，不是导入的依赖
        return @()
    }
}

function Add-ImportRecords {
    param(
        [Parameter(Mandatory = $true)][string]$MatDir,
        [object[]]$Entries
    )
    if ($null -eq $Entries -or $Entries.Count -eq 0) { return }

    $all = @(Read-ImportRecords $MatDir)
    $all += $Entries
    if ($all.Count -gt $script:RecordKeep) {
        $all = $all[($all.Count - $script:RecordKeep)..($all.Count - 1)]
    }
    $p = Get-ImportRecordPath $MatDir
    try {
        [IO.File]::WriteAllText($p, (ConvertTo-Json @{ drafts = $all } -Depth 10),
                                (New-Object Text.UTF8Encoding $false))
    } catch {
        # 写不出去只影响"卸载能否删干净"，不该让导入失败
    }
}

function Find-ImportedFolder {
    <#
    .SYNOPSIS
    按 manifest 里的草稿名，找**这台机器上实际落下来的**那个文件夹名。

    .DESCRIPTION
    优先用导入记录（唯一可信的来源：只有导入器知道自己建了哪个）；
    没有记录时退回原名（老版本导入器建的，或者用户从没导入过）。
    返回 $null 表示磁盘上找不到。
    #>
    param(
        [Parameter(Mandatory = $true)][string]$MatDir,
        [Parameter(Mandatory = $true)][string]$DraftRoot,
        [Parameter(Mandatory = $true)][string]$PackName
    )

    $hits = @(Read-ImportRecords $MatDir |
              Where-Object { $_.pack -eq $PackName -and
                             (Test-Path -LiteralPath (Join-Path $DraftRoot $_.folder)) })
    if ($hits.Count -gt 0) {
        # 同一次导入被重跑过就取最后一条
        return $hits[$hits.Count - 1].folder
    }
    $plain = Get-SafeDraftName $PackName
    if (Test-Path -LiteralPath (Join-Path $DraftRoot $plain)) { return $plain }
    return $null
}

function Install-DraftFolder {
    <#
    .SYNOPSIS
    把包里的一个草稿装进本机草稿根目录，撞名时改名为「名字（2）」。

    .DESCRIPTION
    这是**唯一**会往用户草稿目录里写东西的地方（导入器与将来的调用方都走它）。
    单独抽成函数是为了能被真跑测试：`test_jianying_single_file.py` 直接调它，
    用真实临时目录验证"旧草稿有没有被动过"——这是本文件存在的全部理由。

    返回 @{ Folder; Pack; DraftId; Renamed }。

    .PARAMETER Source
    包里那份草稿目录的绝对路径。

    .PARAMETER Wanted
    期望的草稿名（manifest 里记的那个，通常是「项目名-第N集」）。

    .PARAMETER Tokens
    路径占位符表：`@{ mat = ...; draft = ...; root = ... }`。
    `draft` 是**旧值**（`__SFDRAFT__`），本函数负责把它换成实际文件夹路径。
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Wanted,
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][hashtable]$Tokens,
        # 三个占位符替换用的实际值
        [Parameter(Mandatory = $true)][string]$MatFwd,
        [Parameter(Mandatory = $true)][string]$RootFwd
    )

    $pick = Resolve-DraftTarget -Root $Root -Wanted $Wanted
    $finalName = $pick.Name
    $target = Join-Path $Root $finalName

    # ⚠️ 这里**不能**先 Remove-Item 再 copy（旧实现就是这么干的）。
    #    $target 此刻必定不存在（Resolve-DraftTarget 保证），所以直接 copy 即可。
    Copy-Item -LiteralPath $Source -Destination $target -Recurse

    $draftFwd = "$RootFwd/$finalName"

    # 改名之后草稿**内部**还写着旧名字与旧 draft_id。剪映按 draft_id 认草稿、
    # 按 name 显示，两者都不改的话：草稿箱里会出现两份同名、id 相同的条目，
    # 点进去可能打开的是旧的那份。所以新建的这份必须换一个全新的 id。
    if ($pick.Renamed) {
        $metaPath = Join-Path $target "draft_meta_info.json"
        if (Test-Path -LiteralPath $metaPath) {
            try {
                $meta = Get-Content -LiteralPath $metaPath -Raw -Encoding UTF8 | ConvertFrom-Json
                $meta.draft_name = $finalName
                $meta.draft_id = [Guid]::NewGuid().ToString().ToUpper()
                [IO.File]::WriteAllText(
                    $metaPath, (ConvertTo-Json $meta -Depth 100),
                    (New-Object Text.UTF8Encoding $false))
            } catch {
                Write-Host "⚠ 改草稿元信息失败（$($_.Exception.Message)）：草稿仍会导入，但可能与旧的同名冲突。"
            }
        }
    }

    # content 里的 name 也要跟着改：草稿箱读的是它（meta 里那份是给索引用的）。
    foreach ($jf in Get-ChildItem -LiteralPath $target -Filter "*.json") {
        $txt = [IO.File]::ReadAllText($jf.FullName, [Text.Encoding]::UTF8)
        if ($pick.Renamed -and $jf.Name -like "draft_content*") {
            try {
                $obj = $txt | ConvertFrom-Json
                if ($null -ne $obj.name) { $obj.name = $finalName }
                if ($null -ne $obj.id) { $obj.id = [Guid]::NewGuid().ToString().ToUpper() }
                $txt = ConvertTo-Json $obj -Depth 100 -Compress
            } catch {
                Write-Host "⚠ 改草稿内容名失败（$($_.Exception.Message)）：名字可能仍是旧的。"
            }
        }
        $txt = $txt.Replace($Tokens.mat, $MatFwd)
        $txt = $txt.Replace($Tokens.draft, $draftFwd)
        $txt = $txt.Replace($Tokens.root, $RootFwd)
        # 不带 BOM：BOM 会让某些 JSON 解析器直接判为非法
        [IO.File]::WriteAllText($jf.FullName, $txt, (New-Object Text.UTF8Encoding $false))
    }
    (Get-Item -LiteralPath $target).LastWriteTime = Get-Date

    $newId = $null
    try {
        $newId = (Get-Content -LiteralPath (Join-Path $target "draft_meta_info.json") `
                  -Raw -Encoding UTF8 | ConvertFrom-Json).draft_id
    } catch { }

    # 属性名**必须与导入记录的结构一致**（folder/pack/draft_id/at）：
    # 这个对象会被原样 ConvertTo-Json 进「导入记录.json」，而卸载脚本按
    # `$_.folder` / `$_.pack` 去读。用 Folder/DraftId 这种大小写虽然 PowerShell
    # 能对上，但落到磁盘上的键名就与既有记录不一致了，排查时很误导。
    return [pscustomobject]@{
        folder   = $finalName
        pack     = $Wanted
        draft_id = $newId
        renamed  = $pick.Renamed
        at       = (Get-Date).ToString("s")
    }
}
