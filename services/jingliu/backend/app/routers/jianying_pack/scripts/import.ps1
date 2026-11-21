# 镜流 · 剪映草稿导入器
#
# 只做三件事：把素材下到本机、把草稿写进剪映的草稿目录、把占位路径回填成
# 本机绝对路径。不改剪映的任何既有文件（索引注册是另一个脚本，且会先备份）。
#
# ## 关于剪映进程（2026-10-09 改）
#
# 剪映**不会热感知新草稿**：开着的时候往草稿目录里写，草稿箱里不出现。
# 公开资料里唯一声称能绕开的做法（竞品 capcut-mate 的 robocopy 触发）逻辑上
# 站不住、也没有第三方实测，而 `JianyingPro.exe` **没有任何命令行参数**能
# 直接打开指定草稿——所以「让剪映重新扫一遍」这件事，目前只有两条确定的路：
#
#   a) 冷启动剪映（它启动时必扫草稿目录）
#   b) 让用户在首页手动切进切出一次
#
# 既然 c 不可靠、b 要用户动手，这里就正经做 a：
# **导入器自己把剪映关掉、写完草稿、再帮你打开**。用户不再需要「先完全退出
# 剪映」和「事后自己重启」，全程只需双击一次。
#
# 关的是窗口不是杀进程：先 CloseMainWindow 并给 30 秒体面退出，真卡死了才
# 强制结束。草稿内容是实时落盘的，所以正常路径下不会丢用户的编辑。
#
# 想自己掌控剪映进程就加 -KeepJianying，脚本会退回旧行为（只提示、不动手）。

param(
    # 不接管剪映进程：只做导入，剪映的开与关由用户自己负责（旧行为）。
    [switch]$KeepJianying
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8

$Root    = Split-Path -Parent $PSScriptRoot
$LogPath = Join-Path $Root "导入日志.txt"
$Log     = New-Object System.Collections.ArrayList

function Say($msg) {
    Write-Host $msg
    [void]$Log.Add("$(Get-Date -Format 'HH:mm:ss')  $msg")
}
function Flush-Log {
    try {
        [IO.File]::WriteAllText($LogPath, ($Log -join "`r`n"), (New-Object Text.UTF8Encoding $true))
    } catch { }   # 日志写不出去不该让导入失败
}

Say "=== 镜流 · 剪映草稿导入器 ==="
Say "Windows: $([Environment]::OSVersion.VersionString)  PowerShell: $($PSVersionTable.PSVersion)"

# ---------- 剪映版本（排查时唯一的线索，探不到也要如实记下） ----------
$jyVersion = "未探测到"
try {
    $keys = @(
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*")
    $hit = Get-ItemProperty $keys -ErrorAction SilentlyContinue |
           Where-Object { $_.DisplayName -match "剪映|Jianying|JianyingPro|CapCut" } |
           Select-Object -First 1
    if ($hit) { $jyVersion = "$($hit.DisplayName) $($hit.DisplayVersion)" }
} catch { }
Say "剪映版本: $jyVersion"

# ---------- 剪映进程管理 ----------
# 关/开剪映的那几个函数放在 _jyproc.ps1，register.ps1 也要用同一套。
# 点源引入而不是复制一份：两份实现漂移过一次就够难受的了。
. (Join-Path $PSScriptRoot "_jyproc.ps1")

# 草稿命名与导入记录：名字撞车时的（2）（3）策略、以及"我到底建了哪几个文件夹"。
# 卸载脚本必须靠这份记录才知道该删什么，见 _draftname.ps1 顶部注释。
. (Join-Path $PSScriptRoot "_draftname.ps1")
# 读剪映的全局设置：草稿位置 / 素材下载位置（2026-10-23）。只读，绝不改写。
. (Join-Path $PSScriptRoot "_jysettings.ps1")

$jyProcs = @(Get-JianyingProcs)
$jyWasRunning = $jyProcs.Count -gt 0
# 记下 exe 路径，收尾时要拿它把剪映重新拉起来。取不到（权限/位数差异）就退化成
# 提示用户手动打开——不影响导入本身。
$jyExe = $null
if ($jyWasRunning) {
    foreach ($p in $jyProcs) {
        try { if ($p.Path) { $jyExe = $p.Path; break } } catch { }
    }
}

if ($jyWasRunning) {
    if ($KeepJianying) {
        Say "剪映正在运行（未接管）。写草稿前请自行完全退出，否则草稿箱里不会出现。"
    } else {
        Say "检测到剪映正在运行 —— 素材下完后会临时关闭它，写进草稿再自动帮你打开。"
        Say "（剪映的编辑是实时保存的，正常不会丢内容。）"
    }
} else {
    Say "剪映当前未运行，导入结束后会帮你打开它。"
}

function Stop-Jianying {
    foreach ($p in @(Get-JianyingProcs)) {
        try { [void]$p.CloseMainWindow() } catch { }
    }
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        if (@(Get-JianyingProcs).Count -eq 0) { return $true }
        Start-Sleep -Milliseconds 500
    }
    Say "剪映没有响应关闭请求，改为强制结束。"
    foreach ($p in @(Get-JianyingProcs)) {
        try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { }
    }
    Start-Sleep -Seconds 2
    return (@(Get-JianyingProcs).Count -eq 0)
}

function Start-Jianying {
    if ([string]::IsNullOrEmpty($jyExe) -or -not (Test-Path $jyExe)) {
        Say "没能记下剪映的安装路径，请手动打开剪映查看草稿箱。"
        return
    }
    try {
        Start-Process -FilePath $jyExe | Out-Null
        Say "已重新打开剪映。"
    } catch {
        Say "自动打开剪映失败（$($_.Exception.Message)），请手动打开。"
    }
}

# ---------- 草稿目录（跟随剪映设置，2026-10-23）----------
# 用户把草稿位置改到别的盘后，写死 %LOCALAPPDATA% 就落在一个剪映根本不看的目录里。
# 现在先读剪映的 globalSetting（明文 INI），读到哪个存在的草稿目录就用哪个；
# 读不到才退回默认，再不行弹窗让用户选。详见 _jysettings.ps1。
$jySettings = Read-JianyingSettings
$draftRoot = Get-JianyingDraftRoot $jySettings
if (-not $draftRoot) {
    Say "没能在剪映设置里找到草稿目录，弹窗请你手动指定"
    Add-Type -AssemblyName System.Windows.Forms
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = "请选择剪映的草稿位置（剪映 → 设置 → 全局设置 → 草稿位置 里能看到）"
    if ($dlg.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { Say "已取消"; Flush-Log; exit 1 }
    $draftRoot = $dlg.SelectedPath
}
Say "草稿目录: $draftRoot"

# 素材目录（2026-10-23 修）：此前写死「文档\镜流素材」，即使用户在剪映里把素材
# 下载位置设到了别的盘，仍然往 C 盘灌几十 GB —— 一个 601 镜的项目能把系统盘写满。
# 现在按 _jysettings.Resolve-MaterialDir 的优先级走：剪映设的素材位置 →
# 草稿所在盘 → 文档（老行为）。**仍然不放进草稿根目录**：草稿根下的子文件夹
# 会被剪映当草稿扫，多一个非草稿目录可能让它报错或显示出一个空条目。
$mj = Resolve-MaterialDir $jySettings
$matDir = $mj.dir
if (-not ([string]::IsNullOrEmpty($mj.from))) { Say "素材位置来源: $($mj.from)" }
New-Item -ItemType Directory -Force -Path $matDir | Out-Null
# 磁盘余量：素材几十 GB，不够就先说清楚，别下到一半失败让用户以为网络问题。
try {
    $drv = New-Object IO.DriveInfo((Split-Path -Qualifier $matDir))
    $freeGB = [math]::Round($drv.AvailableFreeSpace / 1GB, 1)
    Say "素材目录: $matDir（$($drv.Name) 剩余 ${freeGB} GB）"
} catch {
    Say "素材目录: $matDir"
}

# 日志改放素材目录：一键导入模式下脚本本体跑在 %TEMP% 里，日志留在那儿会被
# 系统清理掉，用户排查时根本找不到。素材目录是稳定且用户已经知道的地方。
$LogPath = Join-Path $matDir "导入日志.txt"

# ---------- 下载素材（断点续传 + 大小校验） ----------
$manifest = Get-Content (Join-Path $Root "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json

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

    # 服务端不认 Range 时会回 200 并从头发——此时仍按追加写就会拼出一个损坏文件，
    # 而大小校验反而"通过"。所以按**状态码**决定写入模式，不按请求意图。
    $append = ($have -gt 0 -and $resp.StatusCode -eq [Net.HttpStatusCode]::PartialContent)
    $in = $resp.GetResponseStream()
    $mode = if ($append) { [IO.FileMode]::Append } else { [IO.FileMode]::Create }
    $out = New-Object IO.FileStream($dest, $mode, [IO.FileAccess]::Write)
    try {
        $buf = New-Object byte[] 262144
        while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) { $out.Write($buf, 0, $n) }
    } finally { $out.Close(); $in.Close(); $resp.Close() }

    $got = (Get-Item $dest).Length
    if ($got -ne $expected) { throw "大小不符：期望 $expected 实得 $got" }
    if ($append) { return "续传完成" }
    return "下载完成"
}

$total = ($manifest.materials | Measure-Object -Property size -Sum).Sum
Say "需要素材 $($manifest.materials.Count) 个，共 $([math]::Round($total/1MB,1)) MB"
$i = 0
foreach ($m in $manifest.materials) {
    $i++
    $dest = Join-Path $matDir $m.name
    Write-Host ("  [{0}/{1}] {2} ..." -f $i, $manifest.materials.Count, $m.name) -NoNewline
    try {
        $r = Get-FileResume $m.url $dest $m.size
        Write-Host " $r"
        [void]$Log.Add("  素材 $($m.name): $r")
    } catch {
        Write-Host " 失败"
        Say "  素材 $($m.name) 失败: $($_.Exception.Message)"
        Say "中止：素材没下全，装进去也是空草稿。检查网络后重跑即可（已下的不会重下）。"
        Flush-Log; exit 1
    }
}

# ---------- 关剪映 → 写草稿 → 重开剪映 ----------
# 素材下载可能耗时很久，所以把「关闭剪映」压到写草稿前的最后一刻：
# 用户被占用剪映的时间只有写 JSON 的几秒，而不是整个下载过程。
$jyClosed = $false
if ($jyWasRunning -and -not $KeepJianying) {
    Say "正在关闭剪映…"
    $jyClosed = Stop-Jianying
    if ($jyClosed) { Say "剪映已退出。" }
    else { Say "⚠ 剪映仍在运行，草稿箱可能不会立即刷新。" }
}

# 剪映只认本机绝对路径，且分隔符必须是正斜杠——这是这类方案最常见的翻车点
$matFwd  = $matDir.Replace("\", "/")
$rootFwd = $draftRoot.Replace("\", "/")

#: 这次导入实际建了哪几个草稿文件夹。卸载脚本靠它删，见 _draftname.ps1。
$created = New-Object System.Collections.ArrayList

foreach ($d in Get-ChildItem (Join-Path $Root "drafts") -Directory) {
    # ⚠️ 这里**不能**再"同名就删"。旧实现在目标已存在时直接
    #    Remove-Item -Recurse -Force，而草稿名固定是「项目名-第N集」——
    #    同一个项目导出第二次必然撞名，用户上一版剪到一半的草稿就这样没了，
    #    且全程没有任何提示（2026-10-20 用户反馈）。
    #    现在撞名改用「名字（2）」，旧的原样保留。实现在 _draftname.ps1，
    #    抽出去是为了能真跑测试（见 test_jianying_single_file.py）。
    $rec = Install-DraftFolder -Source $d.FullName -Wanted $d.Name `
                               -Root $draftRoot `
                               -Tokens @{ mat = $manifest.mat_token
                                          draft = $manifest.draft_token
                                          root = $manifest.root_token } `
                               -MatFwd $matFwd -RootFwd $rootFwd
    if ($rec.Renamed) {
        Say "草稿「$($d.Name)」已存在，这份存为「$($rec.Folder)」"
    }
    [void]$created.Add($rec)
    Say "已写入草稿: $($rec.Folder)"
}
(Get-Item $draftRoot).LastWriteTime = Get-Date

# 记下这次建了哪几个文件夹。「一键卸载」只删记录里的——
# 有了自动改名之后按名字删会误伤用户自己建的同名草稿。
Add-ImportRecords -MatDir $matDir -Entries $created.ToArray()

# ---------- 把导入器自身留一份在素材目录 ----------
# 单文件形态下，脚本本体是从 %TEMP% 里跑起来的：那个目录随时会被系统清理，
# 而「一键卸载.bat」「请先读我.txt」根本没有出现在用户手上过。所以在这里把
# 整套导入器（含 manifest 与 drafts）拷一份到稳定的位置——
# 素材目录是用户已经知道、且不会被系统回收的地方。
#
# 拷贝之后那个副本是**自包含可重跑**的：从那里双击「一键导入.bat」同样能工作
# （它按脚本自身位置推 $Root，不依赖 %TEMP%）。
$keepDir = Join-Path $matDir "导入器"
# 已经在目标位置（或它下面）运行时跳过，否则会把目录拷进自己里面，
# 越跑越深：镜流素材\导入器\导入器\导入器…
$rootPath = (Resolve-Path $Root).Path
$keepPath = $keepDir
if (-not $rootPath.StartsWith($keepPath, [StringComparison]::OrdinalIgnoreCase)) {
    New-Item -ItemType Directory -Force -Path $keepDir | Out-Null
    foreach ($item in Get-ChildItem $Root -Force) {
        # 日志是按次生成的，不带过去
        if ($item.Name -eq "导入日志.txt") { continue }
        $dst = Join-Path $keepDir $item.Name
        if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
        Copy-Item $item.FullName $dst -Recurse -Force
    }
    Say "导入器已留一份在: $keepDir（卸载、重跑都用它）"
}

# 写完了才把剪映拉起来：冷启动时它必然重扫草稿目录，新草稿就在列表里。
if (-not $KeepJianying) {
    if ($jyClosed) {
        Start-Jianying
    } elseif (-not $jyWasRunning) {
        Start-Jianying
    }
}

Say ""
Say "完成。剪映草稿箱里应该有："
# 用的是**实际落盘**的名字，不是 manifest 里的原名：撞名时后者已经不对了，
# 用户照着字面去找会找不到（"它说导入了 X，可我草稿箱里没有 X"）。
foreach ($c in $created) { Say "    $($c.folder)" }
if ($created.Count -gt 0 -and ($created | Where-Object { $_.folder -ne $_.pack })) {
    Say "（有同名草稿的，这一版存成了带（2）（3）的名字，旧的那份原样保留）"
}
Say ""
Say "草稿箱里一个都看不到 → 双击「草稿箱看不到时双击我.bat」"
Say "日志: $LogPath"
Flush-Log
