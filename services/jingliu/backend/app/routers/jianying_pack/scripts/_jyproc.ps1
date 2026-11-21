# 镜流 · 剪映进程管理（内部模块，由 import.ps1 / register.ps1 点源加载）
#
# 为什么需要：剪映**不会热感知新草稿**，写进草稿目录的草稿在它运行时不出现在
# 草稿箱里。而 `JianyingPro.exe` 没有任何命令行参数能直接打开指定草稿（社区
# 与工具链都没有），所以「让剪映重新扫一遍」这件事只有两条确定的路：
#
#   a) 冷启动剪映——它启动时必扫草稿目录
#   b) 让用户在首页手动切进切出一次
#
# 既然 a 确定有效、b 要用户动手，就由脚本替用户做 a。
#
# 关的是窗口不是杀进程：先 CloseMainWindow 并给 30 秒体面退出，真卡死了才
# 强制结束。剪映的草稿内容是实时落盘的，正常路径下不会丢用户的编辑——但
# 这也是为什么**不能**一上来就 Stop-Process -Force。

# 进程名各版本不同（国内版 JianyingPro、国际版 CapCut），两个都认。
function Get-JianyingProcs {
    foreach ($n in @("JianyingPro", "CapCut")) {
        Get-Process -Name $n -ErrorAction SilentlyContinue
    }
}

#: 在本机剪映进程还活着的时候调用一次，记下 exe 路径。
#: 收尾时要拿它把剪映重新拉起来；取不到（权限/位数差异）就退化成提示用户手动
#: 打开——不影响导入本身。
function Get-JianyingExe {
    foreach ($p in @(Get-JianyingProcs)) {
        try { if ($p.Path) { return $p.Path } } catch { }
    }
    return $null
}

function Stop-Jianying {
    param([switch]$Quiet)

    foreach ($p in @(Get-JianyingProcs)) {
        try { [void]$p.CloseMainWindow() } catch { }
    }
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        if (@(Get-JianyingProcs).Count -eq 0) { return $true }
        Start-Sleep -Milliseconds 500
    }
    if (-not $Quiet) { Write-Host "剪映没有响应关闭请求，改为强制结束。" }
    foreach ($p in @(Get-JianyingProcs)) {
        try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { }
    }
    Start-Sleep -Seconds 2
    return (@(Get-JianyingProcs).Count -eq 0)
}

function Start-Jianying {
    param([string]$Exe)

    if ([string]::IsNullOrEmpty($Exe) -or -not (Test-Path $Exe)) {
        Write-Host "没能记下剪映的安装路径，请手动打开剪映查看草稿箱。"
        return $false
    }
    try {
        Start-Process -FilePath $Exe | Out-Null
        Write-Host "已重新打开剪映。"
        return $true
    } catch {
        Write-Host "自动打开剪映失败（$($_.Exception.Message)），请手动打开。"
        return $false
    }
}
