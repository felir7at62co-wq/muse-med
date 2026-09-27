# Agent Note: PowerShell 子进程输出编码

Status: implemented

[English](2026-09-27-pwsh-child-process-output-encoding.md) | 中文

## 问题

一份复盘过的组员会话里，模型可见的工具结果共出现 3,828 个 U+FFFD 替换字符：这些生产者输出的所有中文行对模型都不可读，其中单行最高 1,495 个。11 条受影响的工具结果里有 6 条是 CPython 输出（3,243 个字符）；3 条是 PowerShell 自身的解析错误文本，`所在位置 行:6` 到手时是 `����λ�� ��:6`。

解码侧以单次读取为单位：`OutputCollector` 把一次读取的字节——对前景命令来说就是收集到的整段 stdout——变成一个文本（[output.ts](../../../../packages/subprocess/subprocess-local/src/output.ts)）。因此一次读取就是编码的单位，而一次读取并不等于一个生产者：字段里同一条工具结果既含 PowerShell 自己输出的 `(未设置)`，又含 CPython 输出的乱码 `����: False`，说明两个生产者的字节会进到同一条结果里，任何单一规则都无法同时恢复两者。

缺口在生产侧。为 Windows PowerShell 5.1 兜底添加的 UTF-8 preamble 固定的是 `[Console]::OutputEncoding` 与 `$OutputEncoding`（[index.ts](../../../../packages/shell/pwsh-local/src/index.ts)），而它们只管辖 PowerShell 自己的写入方：原生子进程自己决定被重定向 stdout/stderr 的编码，在 CP936 主机上 CPython 取自 `locale.getpreferredencoding()`。字段里的 11 条结果中恰好有 6 条属于这一类；固定生产者同时也恢复了单一编码的读取：当每个生产者都写 UTF-8，一次读取里就只剩一种编码。

## 决策

[pwsh-local 的入口](../../../../packages/shell/pwsh-local/src/index.ts) 里的 `ENV_OVERRIDES` 增加 `PYTHONIOENCODING=utf-8`，使每条命令的子进程环境都让 CPython 按 UTF-8 写它的三个文本流，也就是一次收集到的读取解码成文本时所用的编码。该环境属于 pwsh 执行器而不是 subprocess 服务，因为缺陷是在 pwsh 工具上观察到的；subprocess 层的 `childEnv` 服务所有平台上的所有消费者（LSP stderr 尾部、PTC 运行时、git），而这些消费者都没有报告该问题。

本次改动既不碰 preamble 也不碰收集层，文档化的环境分层同样未变：先是终端覆盖值，然后是调用方的 `env`，最后是 `dshEnv`，因此调用方显式给的 `PYTHONIOENCODING` 仍然优先于这个默认值。

## 为什么按生产者声明编码

- `[Console]::OutputEncoding` 与 `chcp 65001` 都到不了被重定向的子进程。在报告主机形态上实测（Windows、未安装 PowerShell 7、活动代码页 936、Windows PowerShell 5.1 兜底）：CPython 子进程报告 `sys.stdout.encoding`/`sys.stderr.encoding` 为 `gbk gbk`，无论有无 preamble、也无论在 `chcp 65001` 之后；其字节在所有组合下都保持 CP936。这两个设置管辖的是控制台与 PowerShell 自己的写入方，而不是另一个进程的 stdio。
- PowerShell 与原生子进程共用同一次收集到的读取。在同一条命令里（`Write-Output "ps 中文测试 ✓"; python emit.py`），收集到的 stdout 同时含有 PowerShell 的 UTF-8 字节与 CPython 的 CP936 字节，因此用单一规则去解这次读取必然救不回两半：按代码页读会毁掉 PowerShell 那半，按 UTF-8 读会毁掉 CPython 那半。这次读取也不能按生产者切分——收集层只把自己保留的块拼起来，不保留生产者分界。
- `PYTHONIOENCODING` 只覆盖 stdin、stdout 与 stderr。`PYTHONUTF8=1`（PEP 540 UTF-8 模式）还会改变模型运行的每条 Python 命令的 `open()` 默认编码与文件系统编码，那是在改用户脚本的行为，而不是在修复不可读的输出。

## 测试

经由真实执行器与真实收集层实测，`pwsh` 在 CP936 报告主机上解析为 `powershell.exe` 5.1：

| 生产者 | 修改前 | 修改后 |
|---|---|---|
| PowerShell `Write-Output "中文测试 ✓"` | 0 个 U+FFFD，逐字相等 | 0 个 U+FFFD，逐字相等 |
| 中文路径下的 `Get-ChildItem` | 0 个 U+FFFD，逐字相等 | 0 个 U+FFFD，逐字相等 |
| CPython 子进程 stdout + stderr | 6 + 6 个 U+FFFD | 0 + 0 个 U+FFFD，逐字相等 |
| 同一条命令里的 PowerShell 与 CPython | 一次读取，两种编码 | 0 个 U+FFFD，两半都逐字相等 |

[executor.spec.ts](../../../../packages/shell/pwsh-local/tests/executor.spec.ts) 双向固定该行为。一个纯测试断言覆盖值进入 spawn spec 且调用方条目仍然优先；一个真实进程测试让 CPython 子进程经执行器运行，断言该子进程为两个文本流报告 `utf-8` 且文本逐字相等，再强制 `PYTHONIOENCODING=cp936` 并断言子进程报告 `cp936`。子进程解析出的编码正是本包自己负责的机制，因此该断言不依赖 subprocess 层自己的解码规则；删掉该覆盖值会让它在任何装有 CPython 的主机上失败，而不只是在代码页主机上。

## 延期

PowerShell 先解析整段 `-Command` 文本、再执行其中第一条语句，因此语法错误的命令在 preamble 运行之前就被上报，本次调用里没有任何固定生效。在附加控制台的 Windows PowerShell 5.1 主机上复现：解析错误的 stderr 以 CP936 字节到达（`所在位置 行:1`），无论有无 preamble，且与字段里的 `����λ�� ��:6` 逐字节相同。运行时错误不受影响，因为产生它的语句已经执行。覆盖解析错误需要 `cmd /c chcp 65001` 外壳，或把命令文本推迟到初次解析之后（`Invoke-Expression`）；两种做法都会改变文档化的单 argv 调用方式，以及[Windows ACL 沙箱](../feature/2026-08-08-windows-acl-restricted-token-sandbox.zh.md)用来匹配 runner 失败与拒绝分类的 stderr 文本。[pwsh-local 的 README](../../../../packages/shell/pwsh-local/README.zh.md) 记录本次固定不覆盖那段文本，其编码取决于 subprocess 层的解码规则。

## 备选方案

**把编码交给解码侧回退。** 不作为唯一修法：一次读取就是解码单位，而上面的字段工具结果把两个生产者的字节放进了同一次读取，任何单一的按读取规则都解不出来。生产侧的固定才让这次读取统一为 UTF-8；而任何环境都固定不了的流（上面的解析错误）仍只能靠回退处理。

**在 preamble 里设置 `chcp 65001`。** 已否决：实测不会改变被重定向子进程的编码，而且它会改动沙箱路径与宿主共用的控制台。

**用 `PYTHONUTF8=1` 取代 `PYTHONIOENCODING`。** 已否决：PEP 540 还会改变 `open()` 默认值与文件系统编码，可能破坏读写代码页文件的 Python 命令，而缺陷只限于被收集的流。

**重构命令传递方式以同时覆盖解析错误。** 本次已否决：`cmd.exe` 外壳或 `Invoke-Expression` 传递会改变行列号上报、[pwsh 工具与执行器决策](../../archived/feature/2026-08-01-pwsh-tool-and-executor.md)记录的单 argv 调用方式，以及沙箱分类匹配的 stderr —— 为字段 3,828 个字符中的 415 个承担这么大的影响面，而且在没有附加控制台的主机上无法验证。

**在工具层替换或转码代码页字节。** 已否决：工具层拿到的是文本而不是字节，只能对混合内容猜测，而生产侧的固定已经从源头消除了这种混合。

## 影响

- 代码页主机上来自 `pwsh` 工具的 CPython 输出是 UTF-8，因此把它与 PowerShell 自身输出混在一条命令里时又只剩一种编码；调用方若覆盖该变量，就会把这个生产者交还给主机代码页。
- 执行器现在在渲染器固定之外多带一个运行时专用固定。其他跟随主机代码页的运行时（例如 .NET Framework 控制台程序）子进程仍需各自的固定方式，调用方可通过 `env` 或命令内部提供；README 面向模型与维护者记录了这一限制。
- 在宿主本就写 UTF-8 的环境里（pwsh 7、POSIX 主机）该覆盖值是惰性的，因此非中文输出与二进制输出都不变：该变量只选择 CPython 文本流的编码，`sys.stdout.buffer` 与二进制载荷不受影响。
