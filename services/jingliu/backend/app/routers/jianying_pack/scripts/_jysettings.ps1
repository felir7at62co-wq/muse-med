# 读取剪映的全局设置（草稿位置 / 素材下载位置 / 预渲染缓存）。
#
# ## 为什么需要它（2026-10-23 用户反馈）
#
# 用户的剪映草稿位置设成了 E 盘，而导入器把素材写死下到「文档\镜流素材」（C 盘）。
# 一个 601 镜的项目素材几十 GB，堆在系统盘上会把 C 盘写满 —— 这比"找不到"严重。
#
# ## 为什么能读
#
# 剪映把全局设置存在
#   %LOCALAPPDATA%\JianyingPro\User Data\Config\globalSetting
# 是**明文**、INI 风格（`[General]` + `key=value`，UTF-8 无 BOM），值是 JSON 转义过的
# （`E:\\JianyingPro Drafts`）。2026-10-23 在剪映 11.5 实测确认（用户机上读出来的）。
#
# ## 只读，不写
#
# 这里**绝不改写剪映的配置文件**。用户的位置该由用户在剪映里设，我们照着用。
# 一旦我们开始写，就要承担"写坏配置让剪映起不来"的责任，而这个收益根本不值。
#
# ## 键名不写死
#
# 只确认了 `customMaterialPath` / `hasSetCustomMaterialPath` 两个键。
# 草稿位置的键名没能确认（读出来时被正则截断了），且不同版本可能叫法不同。
# 所以草稿位置用**判据**找：键名里含 draft、值是存在的目录 —— 比赌一个键名稳。
# 找不到就退回默认位置，再不行让用户选（调用方负责弹窗）。

# ---------------------------------------------------------------------------
# 文件系统探针：单独抽出来是为了**能测**
# ---------------------------------------------------------------------------
# 这段逻辑的正确性全靠"这台机器上 E: 盘存不存在、目录建没建"来判断，而这些在
# 开发机（Linux）上一个都不成立 —— 直接测就只能测到兜底分支，等于没测。
# 全部走下面两个薄函数后，测试里覆盖它们就能在 Linux 上跑真实的 Windows 路径。

function Test-DirPath([string]$p) {
    if ([string]::IsNullOrEmpty($p)) { return $false }
    return (Test-Path -LiteralPath $p -PathType Container)
}

function Test-FilePath([string]$p) {
    if ([string]::IsNullOrEmpty($p)) { return $false }
    return (Test-Path -LiteralPath $p -PathType Leaf)
}

function Join-WinPath([string]$a, [string]$b) {
    # 一律用反斜杠拼接，不用 Join-Path：Join-Path 会去解析盘符对应的 PSDrive，
    # 在非 Windows 主机上（CI / 开发机）直接抛 "Cannot find drive"，于是这段逻辑
    # 连测都测不了。路径是给用户 Windows 机器用的，就该按 Windows 的写法拼。
    $t = if ($a) { $a.TrimEnd('\', '/') } else { '' }
    if (-not $t) { return $b }
    return "$t\$b"
}

function Get-JianyingConfigDir {
    Join-WinPath $env:LOCALAPPDATA "JianyingPro\User Data\Config"
}

function Read-JianyingSettings {
    $p = Join-WinPath (Get-JianyingConfigDir) "globalSetting"
    if (-not (Test-FilePath $p)) { return @{} }
    try {
        # 先 Get-Item 拿到**物理路径**再读字节：[IO.File] 只认真实文件系统路径，
        # 不认 PowerShell 的 PSDrive 映射。生产上两者通常一致，但用户把
        # AppData 重定向到别的盘（或用了符号链接）时就不是了。
        $item = Get-Item -LiteralPath $p -Force -ErrorAction Stop
        $t = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($item.FullName))
    } catch {
        return @{}          # 读不到就当作没有设置，退回默认行为
    }
    $h = @{}
    foreach ($line in ($t -split "`r?`n")) {
        if ($line -match '^\s*[#;\[]') { continue }     # 节头 / 注释
        $i = $line.IndexOf('=')
        if ($i -le 0) { continue }
        $k = $line.Substring(0, $i).Trim()
        if ($k) { $h[$k] = $line.Substring($i + 1).Trim() }
    }
    return $h
}

function ConvertFrom-JyPath($v) {
    # 值是 JSON 转义的：E:\\JianyingPro Drafts → E:\JianyingPro Drafts
    # 也接受正斜杠写法。不是盘符开头的（相对路径 / 空）一律不认 ——
    # 剪映只认本机绝对路径，我们跟着它的口径。
    if (-not $v) { return $null }
    $s = ($v -replace '\\\\', '\').Trim().Trim('"')
    if ($s -match '^[A-Za-z]:(\\|/)') { return $s }
    return $null
}

function Get-JianyingDraftRoot($settings) {
    if ($null -eq $settings) { $settings = @{} }

    # 键名里有 draft 的候选可能不止一个，而且不一定都是「草稿根」：
    # 剪映自己也存预渲染缓存、缩略图缓存这类路径，名字里同样带 draft。
    # 把明显是缓存/备份/导入导出的排到后面，别把草稿写进缓存目录。
    $bad = '(?i)(cache|prerender|temp|tmp|backup|thumb|log|recent|last|zip)'
    $good = '(?i)(path|root|dir|folder|location)'
    $cands = @()
    foreach ($k in $settings.Keys) {
        if ($k -notmatch '(?i)draft') { continue }
        $p = ConvertFrom-JyPath $settings[$k]
        if (-not $p) { continue }
        if (-not (Test-DirPath $p)) { continue }   # 必须真实存在 → 天然滤掉残留值
        $score = 0
        if ($k -match $good) { $score += 2 }
        if ($k -match $bad) { $score -= 5 }
        $cands += [pscustomobject]@{ key = $k; path = $p; score = $score }
    }
    if ($cands.Count -gt 0) {
        # 同分时按时间戳/大小都不可靠，按键名稳定排序，保证多次运行结果一致
        return ($cands | Sort-Object -Property @{ Expression = 'score'; Descending = $true },
                                                 @{ Expression = 'key'; Descending = $false } |
                Select-Object -First 1).path
    }

    $def = Join-WinPath $env:LOCALAPPDATA "JianyingPro\User Data\Projects\com.lveditor.draft"
    if (Test-DirPath $def) { return $def }
    return $null
}

function Test-DriveExists($p) {
    # 只认「盘符存在」，不要求目录已经建出来：用户可能在剪映里设了一个还没用过的
    # 空目录，或者设完就删了文件夹。目录由调用方 New-Item -Force 建（能连父级一起建），
    # 盘符不在就只能放弃 —— 那是真的没这个盘。
    if (-not $p) { return $false }
    $q = Split-Path -Qualifier $p
    if (-not $q) { return $false }
    return (Test-DirPath "$q\")
}

function Get-JianyingMaterialDir($settings) {
    if ($null -eq $settings) { $settings = @{} }
    # hasSetCustomMaterialPath 是剪映自己的开关：false 时 customMaterialPath 里的值
    # 是**上次设过的残留**，不代表用户现在要用它。不看开关就会拿一个用户已经
    # 放弃的位置当准。
    if ("$($settings['hasSetCustomMaterialPath'])" -ne 'true') { return $null }
    $p = ConvertFrom-JyPath $settings['customMaterialPath']
    if (Test-DriveExists $p) { return $p }
    return $null
}

function Get-JianyingPrerenderDir($settings) {
    if ($null -eq $settings) { $settings = @{} }
    $p = ConvertFrom-JyPath $settings['prerenderCachePath']
    if (Test-DirPath $p) { return $p }
    return $null
}

#: 素材放哪个目录（含"镜流素材"这一层，不跟剪映自己的素材混在一起）。
#:
#: 优先级：
#:   ① 剪映设过「素材下载位置」→ 放它下面的「镜流素材」
#:   ② 草稿在哪个盘 → 那个盘的根下「镜流素材」（同盘最不容易写到系统盘）
#:   ③ 文档\镜流素材（老行为，保持兼容）
function Resolve-MaterialDir($settings) {
    $custom = Get-JianyingMaterialDir $settings
    if ($custom) { return @{ dir = (Join-WinPath $custom "镜流素材"); from = "剪映设置的素材下载位置" } }

    $draft = Get-JianyingDraftRoot $settings
    if ($draft) {
        $drive = (Split-Path -Qualifier $draft)      # E:
        if ($drive) { return @{ dir = (Join-WinPath "$drive\" "镜流素材"); from = "跟随草稿所在盘（$drive）" } }
    }

    $docs = [Environment]::GetFolderPath("MyDocuments")
    if ([string]::IsNullOrEmpty($docs) -and -not [string]::IsNullOrEmpty($env:USERPROFILE)) {
        $docs = Join-WinPath $env:USERPROFILE "Documents"
    }
    if ([string]::IsNullOrEmpty($docs)) { $docs = $HOME }
    return @{ dir = (Join-WinPath $docs "镜流素材"); from = "文档目录（剪映设置里没找到位置）" }
}

#: 素材目录的**候选**列表（按优先级，去重）。
#:
#: 用途只有一个：找「导入记录.json」。记录文件跟着素材目录走，所以用户一旦
#: 在剪映里改了素材位置（或者从旧版升上来、从「文档」换到了别的盘），
#: 上一批导入的记录就留在了旧目录里。注册/卸载只看当前目录的话，会得出
#: 「没有导入记录」——然后既不登记也不删除，用户以为功能坏了。
#: 这里把可能放过的位置都列出来，让调用方逐个去翻。
function Get-MaterialDirCandidates($settings) {
    $out = New-Object System.Collections.ArrayList
    $add = {
        param($p)
        if ([string]::IsNullOrEmpty($p)) { return }
        $t = $p.TrimEnd('\', '/')
        foreach ($e in $out) { if ($e.TrimEnd('\', '/') -eq $t) { return } }
        [void]$out.Add($p)
    }

    $custom = Get-JianyingMaterialDir $settings
    if ($custom) { & $add (Join-WinPath $custom "镜流素材") }
    $draft = Get-JianyingDraftRoot $settings
    if ($draft) {
        $drive = Split-Path -Qualifier $draft
        if ($drive) { & $add (Join-WinPath "$drive\" "镜流素材") }
    }
    $docs = [Environment]::GetFolderPath("MyDocuments")
    if ([string]::IsNullOrEmpty($docs) -and -not [string]::IsNullOrEmpty($env:USERPROFILE)) {
        $docs = Join-WinPath $env:USERPROFILE "Documents"
    }
    if (-not [string]::IsNullOrEmpty($docs)) { & $add (Join-WinPath $docs "镜流素材") }
    return $out.ToArray()
}
