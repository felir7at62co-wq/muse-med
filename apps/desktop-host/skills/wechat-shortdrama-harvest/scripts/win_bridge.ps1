# win_bridge.ps1 — 微信小程序窗口的 UIA 桥（零外部依赖，用系统自带 System.Windows.Automation）
#
# 用法（由 Python 调用，结果写 JSON 到 -Out）：
#   powershell -File win_bridge.ps1 -Action dump  -Out tree.json [-Filter WeChatAppEx]
#   powershell -File win_bridge.ps1 -Action focus -Out r.json
#   powershell -File win_bridge.ps1 -Action click -Out r.json -X 1900 -Y 300
#   powershell -File win_bridge.ps1 -Action key   -Out r.json -Key NEXT
#   powershell -File win_bridge.ps1 -Action scroll -Out r.json -X 1900 -Y 400 -Delta -500
#
# 说明：Chromium 会惰性构建无障碍树 —— 首次 UIA 查询会促使它生成，
#       所以第一次 dump 可能元素较少，再 dump 一次通常就全了。

param(
    [Parameter(Mandatory=$true)][string]$Action,
    [Parameter(Mandatory=$true)][string]$Out,
    [string]$Filter = "WeChatAppEx",
    [string]$WindowName = "",     # 按窗口标题子串过滤（多个小程序窗口时用）
    [int]$X = -1,
    [int]$Y = -1,
    [int]$Delta = 0,
    [string]$Key = "",
    [int]$MaxDepth = 16
)

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Native {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, IntPtr e);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, IntPtr e);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern IntPtr GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
    public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
    public const uint WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202;
    public static void Click(int x, int y) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(60);
        mouse_event(LEFTDOWN, 0, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(40);
        mouse_event(LEFTUP, 0, 0, 0, IntPtr.Zero);
    }
    public static void Scroll(int delta) { mouse_event(0x0800, 0, 0, delta, IntPtr.Zero); }
    public static void Key(byte vk) {
        keybd_event(vk, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(30);
        keybd_event(vk, 0, 2, IntPtr.Zero);
    }
    // 后台点击：把鼠标消息直接 Post 给指定窗口，**不移动光标、不抢焦点、窗口被盖住也行**
    public static string PostClick(IntPtr h, int sx, int sy, bool moveFirst) {
        POINT p; p.X = sx; p.Y = sy;
        if (!ScreenToClient(h, ref p)) { return "ScreenToClient failed"; }
        IntPtr lp = (IntPtr)((p.Y << 16) | (p.X & 0xFFFF));
        if (moveFirst) {
            PostMessage(h, WM_MOUSEMOVE, IntPtr.Zero, lp);
            System.Threading.Thread.Sleep(30);
        }
        PostMessage(h, WM_LBUTTONDOWN, (IntPtr)1, lp);
        System.Threading.Thread.Sleep(40);
        PostMessage(h, WM_LBUTTONUP, IntPtr.Zero, lp);
        return "client=" + p.X + "," + p.Y;
    }
    public static string Where() {
        RECT r; IntPtr h = GetForegroundWindow();
        GetWindowRect(h, out r);
        POINT p; GetCursorPos(out p);
        return "cursor=" + p.X + "," + p.Y + " fg=" + r.L + "," + r.T + "," + r.R + "," + r.B;
    }
}
"@

function Get-Rect($el) {
    $r = $el.Current.BoundingRectangle
    if ([double]::IsNaN($r.X) -or [double]::IsInfinity($r.X)) { return $null }
    if ([double]::IsNaN($r.Width) -or [double]::IsInfinity($r.Width)) { return $null }
    if ($r.Width -le 0 -or $r.Height -le 0) { return $null }
    return $r
}

function Get-Pat($el) {
    $names = @()
    $pats = @([System.Windows.Automation.InvokePattern]::Pattern,
              [System.Windows.Automation.SelectionItemPattern]::Pattern,
              [System.Windows.Automation.ScrollPattern]::Pattern,
              [System.Windows.Automation.ValuePattern]::Pattern,
              [System.Windows.Automation.TogglePattern]::Pattern)
    foreach ($p in $pats) {
        $o = $null
        try { if ($el.TryGetCurrentPattern($p, [ref]$o)) { $names += ($p.ProgrammaticName -replace 'PatternIdentifiers.Pattern','') } } catch {}
    }
    return ($names -join ",")
}

$script:WINLIST = New-Object System.Collections.ArrayList

function Collect-Wins {
    $script:WINLIST.Clear()
    $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
    foreach ($w in $AE::RootElement.FindAll($TS::Children, $cond)) {
        $procId = $w.Current.ProcessId
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($p -eq $null) { continue }
        if ($p.ProcessName -notmatch $Filter) { continue }
        $nm = $w.Current.Name
        if ($WindowName -ne '' -and $nm -notlike ("*" + $WindowName + "*")) { continue }
        $entry = @{ el = $w; proc = $p.ProcessName; pid = $procId; name = $nm }
        [void]$script:WINLIST.Add($entry)
    }
}

function Find-Win {
    Collect-Wins
    if ($script:WINLIST.Count -eq 0) { return $null }
    return $script:WINLIST[0]
}

function Walk($el, $depth, $maxDepth, $bucket) {
    if ($depth -gt $maxDepth) { return }
    $kids = $null
    try { $kids = $el.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition) } catch { return }
    foreach ($k in $kids) {
        $r = Get-Rect $k
        $t = $k.Current.ControlType.ProgrammaticName -replace 'ControlType.',''
        $n = $k.Current.Name
        $aid = $k.Current.AutomationId
        $interactive = $t -match 'Button|ListItem|Edit|Hyperlink|Tab|MenuItem|CheckBox|ComboBox|Slider|Image'
        if ($r -ne $null) {
            $o = [ordered]@{
                type = $t; name = $n; id = $aid
                x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height
                cx = [int]($r.X + $r.Width / 2); cy = [int]($r.Y + $r.Height / 2)
                depth = $depth
            }
            $pt = Get-Pat $k
            if ($pt -ne '') { $o["patterns"] = $pt }
            [void]$bucket.Add([pscustomobject]$o)
        }
        Walk $k ($depth + 1) $maxDepth $bucket
    }
}

$result = [ordered]@{ ok = $false; action = $Action }

switch ($Action) {
    "dump" {
        $fw = Find-Win
        if ($fw -eq $null) { $result.error = "no window matching process '$Filter'"; break }
        $w = $fw.el
        $result.window = $w.Current.Name
        $result.process = $fw.proc
        $result.pid = $fw.pid
        $wr = Get-Rect $w
        if ($wr -ne $null) { $result.rect = @([int]$wr.X, [int]$wr.Y, [int]$wr.Width, [int]$wr.Height) }
        # 第一次查询促使 Chromium 构建无障碍树，隔一会儿再抓一次
        $warm = New-Object System.Collections.ArrayList
        Walk $w 0 $MaxDepth $warm
        Start-Sleep -Milliseconds 400
        $bucket = New-Object System.Collections.ArrayList
        Walk $w 0 $MaxDepth $bucket
        $result.elementCount = $bucket.Count
        $result.elements = $bucket
        $result.ok = $true
    }
    "focus" {
        $fw = Find-Win
        if ($fw -eq $null) { $result.error = "no window"; break }
        $h = $fw.el.Current.NativeWindowHandle
        [void][Native]::ShowWindow($h, 9)          # SW_RESTORE
        [void][Native]::SetForegroundWindow($h)
        Start-Sleep -Milliseconds 300
        $result.foreground = ([Native]::GetForegroundWindow() -eq $h)
        $result.ok = $true
    }
    "click" {
        if ($X -lt 0 -or $Y -lt 0) { $result.error = "-X/-Y required"; break }
        [Native]::Click($X, $Y)
        Start-Sleep -Milliseconds 250
        $result.clicked = @($X, $Y)
        $result.ok = $true
    }
    "postclick" {
        # 后台点击：不动光标 / 不抢焦点 / 窗口被盖住也行
        $fw = Find-Win
        if ($fw -eq $null) { $result.error = "no window"; break }
        if ($X -lt 0 -or $Y -lt 0) { $result.error = "-X/-Y required"; break }
        $h = [IntPtr]$fw.el.Current.NativeWindowHandle
        $before = [Native]::Where()
        $r = [Native]::PostClick($h, $X, $Y, $true)
        Start-Sleep -Milliseconds 300
        $result.hwnd = $h.ToInt64()
        $result.mapping = $r
        $result.before = $before
        $result.after = [Native]::Where()
        $result.ok = $true
    }
    "dblclick" {
        [Native]::Click($X, $Y); Start-Sleep -Milliseconds 90; [Native]::Click($X, $Y)
        $result.ok = $true
    }
    "scroll" {
        [Native]::SetCursorPos($X, $Y)
        Start-Sleep -Milliseconds 80
        [Native]::Scroll($Delta)
        Start-Sleep -Milliseconds 350
        $result.ok = $true
    }
    "key" {
        $map = @{ NEXT = 0x27; PREV = 0x25; UP = 0x26; DOWN = 0x28; SPACE = 0x20; ENTER = 0x0D; ESC = 0x1B }
        if (-not $map.ContainsKey($Key)) { $result.error = "unknown key '$Key'"; break }
        [Native]::Key([byte]$map[$Key])
        Start-Sleep -Milliseconds 250
        $result.ok = $true
    }
    default { $result.error = "unknown action '$Action'" }
}

$json = $result | ConvertTo-Json -Depth 8 -Compress
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding $false))
