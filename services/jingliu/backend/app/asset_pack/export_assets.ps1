# 镜流 · 资产下载器
#
# 做三件事：问用户下到哪个盘、按清单建好文件夹并命名、逐个下载并校验大小。
# 不碰任何既有文件（只在用户选的目录下新建一个文件夹）。
#
# ## 为什么命名在服务端算好
#
# 图在库里叫 `img_dcfc924f5c3e.png`，那对用户毫无意义。名字只能由后端算，
# 见 `app/asset_export.build_manifest`。脚本只负责**照着摆**——
# 两边各写一套命名规则的话迟早漂移，而漂移的表现是"文件夹名对不上"，
# 没人会想到是脚本的问题。
#
# ## 断点续传：按状态码决定，不按请求意图
#
# 服务端不认 Range 时会回 200 并从头发。此时仍按追加写就会拼出一个损坏文件，
# 而大小校验反而"通过"（因为大小恰好多了一倍……或刚好凑巧）。所以写入模式
# 必须由**响应的状态码**决定。这套逻辑与剪映导入器同源，别各写一份。
#
# ## 参数
#
#   -OutDir <dir>   不弹选择框，直接下到这个目录（自动化测试用）
#   -Quiet          少打印（只留 "n/N 名字"）

param(
    [string]$OutDir,
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8

$Root     = Split-Path -Parent $PSScriptRoot
$Manifest = Get-Content (Join-Path $Root "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$Log      = New-Object System.Collections.ArrayList

function Say($msg) {
    if (-not $Quiet) { Write-Host $msg }
    [void]$Log.Add("$(Get-Date -Format 'HH:mm:ss')  $msg")
}
function Flush-Log($dir) {
    try {
        $p = Join-Path $dir "下载日志.txt"
        [IO.File]::WriteAllText($p, ($Log -join "`r`n"), (New-Object Text.UTF8Encoding $true))
    } catch { }   # 日志写不出去不该让下载失败
}

Say "=== 镜流 · 资产下载 ==="
Say "PowerShell: $($PSVersionTable.PSVersion)"

# ---------- 1. 选目录 ----------
# 默认落在「下载」目录下：那是用户本来就熟悉的位置，不会灌进某个盘的根目录。
if (-not $OutDir) {
    $suggest = Join-Path ([Environment]::GetFolderPath("MyDocuments")) $Manifest.folder
    Say ""
    Say "将下载 $($Manifest.items.Count) 个文件，约 $([math]::Round($Manifest.total_bytes/1MB,1)) MB。"
    Say "选一个文件夹，会在它下面新建「$($Manifest.folder)」。"
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
        $dlg.Description = "选择下载到哪里（会在里面新建「$($Manifest.folder)」）"
        $dlg.ShowNewFolderButton = $true
        if ($dlg.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
            Say "已取消。"
            exit 0
        }
        $base = $dlg.SelectedPath
    } catch {
        # 没有图形界面（远程/精简系统）时退回「文档」
        Say "（没有图形选择框，下到：$suggest）"
        $base = Split-Path -Parent $suggest
    }
} else {
    $base = $OutDir
}

$dest = Join-Path $base $Manifest.folder
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Say "下载到: $dest"

# 盘余量：清单里已经有总大小，不够就先说清楚，别下到一半失败让用户以为网络问题。
try {
    $drv = New-Object IO.DriveInfo((Split-Path -Qualifier $dest))
    $freeGB = [math]::Round($drv.AvailableFreeSpace / 1GB, 1)
    $needGB = [math]::Round($Manifest.total_bytes / 1GB, 2)
    Say "磁盘 $($drv.Name) 剩余 ${freeGB} GB，需要约 ${needGB} GB"
    if ($drv.AvailableFreeSpace -lt $Manifest.total_bytes) {
        Say ""
        Say "⚠ 磁盘空间不够，已停止。请换一个盘，或清理后再试。"
        Flush-Log $base
        exit 1
    }
} catch {
    Say "（盘余量读不到，跳过检查）"
}

# ---------- 2. 下载 ----------
function Get-FileResume($url, $dest, $expected) {
    $have = 0
    if (Test-Path $dest) { $have = (Get-Item $dest).Length }
    if ($have -eq $expected) { return "已存在" }
    if ($have -gt $expected) { Remove-Item $dest -Force; $have = 0 }

    $req = [Net.HttpWebRequest]::Create($url)
    $req.Timeout = 60000
    $req.ReadWriteTimeout = 120000
    if ($have -gt 0) { $req.AddRange([int]$have) }
    $resp = $req.GetResponse()

    # ⚠️ 按**状态码**决定写入模式，不按请求意图：服务端不认 Range 会回 200
    #    并从头发，此时追加写会拼出损坏文件而大小校验可能照样"通过"。
    $append = ($have -gt 0 -and $resp.StatusCode -eq [Net.HttpStatusCode]::PartialContent)
    $in = $resp.GetResponseStream()
    $mode = if ($append) { [IO.FileMode]::Append } else { [IO.FileMode]::Create }
    $out = New-Object IO.FileStream($dest, $mode, [IO.FileAccess]::Write)
    try {
        $buf = New-Object byte[] 262144
        while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) { $out.Write($buf, 0, $n) }
    } finally { $out.Close(); $in.Close(); $resp.Close() }

    $got = (Get-Item $dest).Length
    if ($expected -gt 0 -and $got -ne $expected) {
        throw "大小不符：期望 $expected 实得 $got"
    }
    if ($append) { return "续传完成" }
    return "下载完成"
}

$n = $Manifest.items.Count
$i = 0
$ok = 0
$fail = 0
foreach ($m in $Manifest.items) {
    $i++
    # 清单里的 path 用正斜杠，Windows 上 Join-Path 拼完再统一换回来
    $rel  = $m.path.Replace("/", [IO.Path]::DirectorySeparatorChar)
    $full = Join-Path $dest $rel
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($full))
    if (-not $Quiet) {
        Write-Host ("  [{0}/{1}] {2} ..." -f $i, $n, $m.path) -NoNewline
    }
    try {
        $r = Get-FileResume $m.url $full ([int64]$m.size)
        if (-not $Quiet) { Write-Host " $r" }
        $ok++
    } catch {
        if (-not $Quiet) { Write-Host " 失败" }
        Say "  ✗ $($m.path): $($_.Exception.Message)"
        # 单个失败不中止：用户至少能拿到绝大部分。最后统一汇总，并给出重跑提示
        # （重跑会跳过已完成的，只补缺的）。
        $fail++
        [void]$Log.Add("  失败 $($m.path)  url=$($m.url)")
    }
}

# ---------- 3. 清单（缺图的那些）也留一份 ----------
# 「本来就没有图」与「下载失败」是两件事，不能混成一句"有 N 个没下下来"。
if ($Manifest.missing -and $Manifest.missing.Count -gt 0) {
    $lines = @("".PadRight(1), "以下 $($Manifest.missing.Count) 项本来就没有图（不是下载失败）：", "")
    foreach ($x in $Manifest.missing) { $lines += "    $($x.kind)  $($x.name)  —— $($x.why)" }
    $lines += @("", "这些需要先在镜流的资产页补图，再重新导出。")
    [IO.File]::WriteAllLines((Join-Path $dest "缺图清单.txt"), $lines,
                             (New-Object Text.UTF8Encoding $true))
}

Say ""
Say "完成：成功 $ok 个" + $(if ($fail) { "，失败 $fail 个" } else { "" })
if ($fail) {
    Say "失败的那些可以直接双击再跑一次：已下好的会跳过，只补缺的。"
}
Say "位置: $dest"
Flush-Log $dest

if ($fail) { exit 1 }
