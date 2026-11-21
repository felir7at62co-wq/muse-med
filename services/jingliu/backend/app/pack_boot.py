"""自包含 `.bat` 的引导段 —— **唯一实现**，剪映导入器与资产导出器共用。

## 这是什么东西

交付给用户的文件本身**就是**那个程序：整包打成一个 zip、base64 贴在 `.bat`
的载荷区，`.bat` 的引导段用 PowerShell 读自己、切出载荷、解到临时目录，
再点源执行里面那份真正的脚本。用户双击即可，不需要解压。

## 为什么必须共用一份

引导段里每一行都是踩出来的（`New-Object` 不吃 C# 式括号、`ZipFile::OpenRead`
在 pwsh 7 上会选中 String 重载、分隔符必须拆开拼写……）。两个交付通道各抄
一份的话，迟早只修好其中一个，而坏掉的那个**没有任何报错**，只是双击之后
命令行闪一下就没了。

## 保留的硬约束（改之前先读）

1. **引导段必须全 ASCII**。它要过 cmd 代码页、PowerShell `-Command` 解析、
   浏览器下载三道关；含中文时 `chcp 65001` 生效前后的解释方式可能不一致，
   表现是"在 A 机器好好的、在 B 机器乱码"，极难远程排查。
   中文提示一律放在它释放出来的 `.ps1` 里——那一侧有 BOM，编码确定。

2. **载荷分隔符里带 `-`**。`-` 不在 base64 字母表内，所以标记不可能出现在
   载荷内部，`IndexOf` 不会找错位置。

3. **引导段里拼写这个字面量时必须拆开**：`'---SFP'+'AYLOAD---'`。
   整段连续写的话，`IndexOf` 命中的会是这一行里的字面量而不是文件末尾的
   真分隔符，substring 出来的是"— 引导段剩下的部分 + 载荷"，解码当场失败。

4. **`goto :eof` 收尾**：载荷就贴在同一个文件里，cmd 会一行行往下读，
   它让 cmd 到此为止，几千行 base64 永远不会被当成命令执行。
"""
from __future__ import annotations

#: 载荷分隔符。`-` 不在 base64 字母表里，见模块头第 2 条。
PAYLOAD_MARK = "---SFPAYLOAD---"


def bat_boot(entry_rel: str, *, tmp_prefix: str = "sf-pack-") -> str:
    """构造引导段（不含载荷，也不含末尾的分隔符之后的 base64）。

    :param entry_rel: 包内要执行的脚本相对路径，正斜杠写法，
                      如 `"scripts/import.ps1"` / `"scripts/export_assets.ps1"`。
                      **只用单引号包住**：PowerShell 的单引号不做转义，
                      写成双反斜杠会原样传成 `scripts\\\\import.ps1` 而找不到文件。
    :param tmp_prefix: 临时目录名前缀，只影响 `%TEMP%` 里那个文件夹叫什么，
                      纯排障线索，不参与逻辑。

    ⚠️ 返回的字符串末尾**不带**分隔符：调用方拼 `PAYLOAD_MARK + "\r\n"` 再贴
    base64（见 `emit_single_file`）。分开是为了让"引导段里不许出现连续分隔符"
    这条约束在测试里能被直接断言。
    """
    if "\\" in entry_rel:
        raise ValueError("entry_rel 必须用正斜杠：PowerShell 的单引号不转义反斜杠")
    if PAYLOAD_MARK in entry_rel:
        raise ValueError("entry_rel 里不能出现载荷分隔符")
    if not entry_rel.isascii():
        raise ValueError("entry_rel 必须是纯 ASCII（它会被拼进 .bat 引导段）")
    if not tmp_prefix.isascii() or not tmp_prefix.replace("-", "").isalnum():
        raise ValueError("tmp_prefix 只能是 ASCII 字母数字与连字符")

    return (
        "@echo off\r\n"
        "rem ShotFlow / Jingliu - self-contained pack launcher\r\n"
        "rem Double-click this file. Nothing to unzip.\r\n"
        "chcp 65001 >nul\r\n"
        "setlocal\r\n"
        'set "SF_SELF=%~f0"\r\n'
        "powershell -NoProfile -ExecutionPolicy Bypass -Command \""
        "$ErrorActionPreference='Stop';"
        "$t=[IO.File]::ReadAllText($env:SF_SELF);"
        # 分隔符拆开拼写：见模块头第 3 条
        "$m='---SFP'+'AYLOAD---';"
        "$i=$t.IndexOf($m);"
        "if($i -lt 0){Write-Host 'payload not found';exit 1};"
        "$b=($t.Substring($i+$m.Length)) -replace '\\s','';"
        "$d=[Convert]::FromBase64String($b);"
        # Add-Type 只在 Windows PowerShell 5.1 下需要（那里这两个类型在独立程序集里）。
        # PS 7 已内置，-AssemblyName 会找不到而抛错——所以吞掉异常，两个宿主都能跑。
        "try{Add-Type -AssemblyName System.IO.Compression}catch{};"
        "try{Add-Type -AssemblyName System.IO.Compression.FileSystem}catch{};"
        # ::new 而不是 New-Object：后者不吃 C# 式括号语法，会把 "IO.MemoryStream"
        # 当类型名、"(,$d)" 当字符串参数，$z 变成字符串。
        "$z=[IO.MemoryStream]::new($d, $false);"
        # ⚠️ 不能用 [IO.Compression.ZipFile]::OpenRead($z)：它有两个重载
        # (String) 与 (Stream)，实测 pwsh 7 就算 $z 确实是 MemoryStream 也会选中
        # String 重载，把它当**文件名**去开，报 Could not find file '…MemoryStream'。
        # ZipArchive 的构造函数只有 Stream 重载，无歧义。
        "$a=[IO.Compression.ZipArchive]::new($z, [IO.Compression.ZipArchiveMode]::Read);"
        # 临时目录用 [IO.Path]::GetTempPath() 而不是 $env:TEMP：后者是 Windows
        # 专有变量，非 Windows 上为 null，会让 Join-Path 直接抛参数绑定错误。
        "$o=Join-Path ([IO.Path]::GetTempPath()) ('" + tmp_prefix
        + "'+[Guid]::NewGuid().ToString('N'));"
        "[void][IO.Directory]::CreateDirectory($o);"
        # 逐个条目展开，且只用 BCL 类型（IO.File / entry.Open），不走
        # ZipFileExtensions 的静态方法——那一层在 PS 5.1 上还要靠程序集解析。
        "foreach($e in $a.Entries){"
        "$p=Join-Path $o $e.FullName;"
        "if($e.FullName.EndsWith('/')){[void][IO.Directory]::CreateDirectory($p);continue};"
        "[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($p));"
        "$s=$e.Open();$f=[IO.File]::Create($p);$s.CopyTo($f);$f.Dispose();$s.Dispose()};"
        "$a.Dispose();$z.Dispose();"
        ". (Join-Path $o '" + entry_rel + "')\"\r\n"
        "endlocal\r\n"
        "pause\r\n"
        "goto :eof\r\n"
    )
