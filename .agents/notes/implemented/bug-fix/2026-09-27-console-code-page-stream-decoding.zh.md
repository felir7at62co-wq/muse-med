# Agent Note: 收集流字节的控制台代码页解码

Status: implemented

[English](2026-09-27-console-code-page-stream-decoding.md) | 中文

## 问题

复盘过的组员会话在模型可见的工具结果里记录到 3,828 个 U+FFFD 替换字符。11 条受影响结果中有 8 条属于[子进程编码记录](2026-09-27-pwsh-child-process-output-encoding.zh.md)覆盖的生产侧情形；另外 3 条——415 个字符——是 PowerShell 自身的解析错误文本，`所在位置 行:6` 到手时是 `����λ�� ��:6`。

任何环境都固定不了这条流。PowerShell 先解析整段 `-Command` 文本、再执行其中第一条语句，因此写出解析错误时，固定 `[Console]::OutputEncoding` 的 `ENCODING_PREAMBLE` 语句尚未执行，错误文本以控制台代码页字节到达。任何环境变量都触达不到其编码的生产者同样如此。

这些字节在执行器下一层就不再存在。`OutputCollector.readFrom` 与 `OutputCollector.finalize` 用 `Buffer.toString('utf8')` 解码一次读取（[output.ts](../../../../packages/subprocess/subprocess-local/src/output.ts)），而 Node 的非严格 UTF-8 解码器会为每段畸形字节序列写入一个 U+FFFD。`SubprocessOutputReader` 交给消费者的是文本，因此更晚的层——pwsh 执行器、bash 执行器、工具、模型——都无法恢复这些字节。解码侧修复因此只可能有一个落点，而它也是唯一持有完整读取、而非某个生产者那一份字节的层。

## 决策

[stream-decoding.ts](../../../../packages/subprocess/subprocess-local/src/stream-decoding.ts) 解码每一次收集到的读取，收集层的两条读取路径都调用它。

- 合法字节经 `isUtf8` 判定后用 `Buffer.toString('utf8')` 解码，因此只要字节本来就是合法 UTF-8，跑的就是原来那次解码，逐字符相同。
- 不是合法 UTF-8 的字节按 Windows ANSI 代码页解码，该代码页每进程读取一次：经 `extendWin32ProcessBindings` 调用 `GetACP`。这正是原生 Windows 程序写入被重定向标准流时所用的编码：报告主机上是 936，西文主机上是 1252。
- 只要补回窗口边缘被切开的一个字符后就能用合法 UTF-8 解释的字节，保留其替换字符。
- 没有控制台代码页的主机（POSIX）、本运行时没有对应解码器的代码页，以及本身就是 UTF-8 的代码页，都保留替换字符解码。

`consoleCodePageFallbacks` 统计回退解码次数并记录最近一次使用的代码页，使残留替换字符可以归因到主机，而不必靠猜。Win32 探测是惰性的：从不读取畸形流的进程不会绑定它。

命令构造未被触碰。argv、单元素 `-Command` 的投递方式、环境分层与 `ENCODING_PREAMBLE` 全部保持原样，因此 [Windows ACL 沙箱](../feature/2026-08-08-windows-acl-restricted-token-sandbox.zh.md)用来匹配 runner 失败与拒绝分类的 stderr 文本不变。

## 为什么窗口边缘不是代码页流

无论流怎样分块，保留尾部都在配置上限处保持字节精确；增量读取的起点与终点又都落在管道分块偏移上，因此合法 UTF-8 的流会带着边缘处的一个不完整字符到达本解码器。这样的切片不是合法 UTF-8，而按代码页读它会把切片里的每个字符都换掉，而不只是被切开的那个：一段首字符丢了前导字节的 64 KB 中文尾部，会变成 64 KB 乱码。

因此解码器会识别不完整序列可能贡献的字节——开头若干后续字节，以及结尾一个后续字节数不足的前导字节——并在丢弃这些字节后可用合法 UTF-8 解释该切片时保留替换字符解码。只有这些字节会被丢弃，因此前导字节恰好形似切口的代码页流（`错: file not found`，其 CP936 字节以一个前导字节和一个后续字节开头）仍会按代码页解码。

## 生产侧固定的局限

[生产侧固定](2026-09-27-pwsh-child-process-output-encoding.zh.md)与本次回退覆盖不同的一半，彼此都不能替代对方。

- `PYTHONIOENCODING` 只能触达会读取它的解释器，也就是 CPython 及其派生实现。其他跟随主机代码页的运行时写出的原生程序——.NET Framework 控制台程序、识别代码页的命令行工具——只能靠本次回退触达；而回退按主机代码页读它的字节，因此也无法同时服务在一次读取里混合两种编码的流。
- 该固定会被导出到每条命令的子进程环境里，因此依赖主机代码页的用户命令会看到与没有它时不同的编码：通过文本流读写 CP936 文件的 Python 代码，或断言 `sys.stdout.encoding` 的代码，行为会不同。调用方可以逐次覆盖该变量，且 `sys.stdout.buffer` 与文件 I/O 保持各自的默认值。
- 在本来就写 UTF-8 的主机（pwsh 7、POSIX）上该固定无实际作用但仍然存在；本次回退在那里同样无实际作用，因为合法读取永远不会咨询它。

## 测试

经由真实收集层与真实 `decodeStreamText` 实测，`pwsh` 在报告主机上解析为 `powershell.exe` 5.1（Windows、未安装 PowerShell 7、活动代码页 936）：

| 生产者 | 修改前 | 修改后 |
|---|---|---|
| 控制台代码页下的 PowerShell 5.1 stderr | 10 个 U+FFFD | `所在位置 行:6 字符: 1`，0 个 U+FFFD，在代码页 936 上回退解码一次 |
| PowerShell 5.1 解析错误（本机已本地化） | CP936 字节 | `语句块或类型定义中缺少右“}”。`，0 个 U+FFFD，在代码页 936 上回退解码一次 |
| PowerShell 5.1 解析错误（英文本地化） | 0 个 U+FFFD，逐字相等 | 0 个 U+FFFD，逐字相等，回退解码 0 次 |
| 带 `PYTHONIOENCODING=utf-8` 的 CPython 子进程 | 0 个 U+FFFD，逐字相等 | 0 个 U+FFFD，逐字相等 |
| 不带该固定的 CPython 子进程 | 按 UTF-8 读得 6 个 U+FFFD | 经回退得到 0 个 U+FFFD |

[stream-decoding.spec.ts](../../../../packages/subprocess/subprocess-local/tests/stream-decoding.spec.ts) 固定该规则：`所在位置 行:6 字符: 1` 的 CP936 字节解码为该文本且替换字符为 0；若干合法样本逐字符相等且回退计数不变；没有回退可用的切片保留替换字符解码；只含被切开字符的读取同样保留它。这些测试注入控制台代码页，因此在所有主机上都会运行；另有一个仅 Windows 的测试在无注入的情况下跑生产路径。两个测试驱动真实 `OutputCollector` 走 `readFrom` 与 `finalize`：字节精确的被切尾部，以及代码页为 936 的主机上的 CP936 流。

删掉解码接线后，只有断言 CP936 流的那个收集层测试失败，其他测试都不受影响，这正是这条配对记录的意义。pwsh-local 的套件原样通过（45 通过、1 跳过、1 个环境失败：符号链接夹具在本机无法创建链接）。`spawn.spec.ts` 自带的 OutputCollector 测试在本机脱离平台排除项运行后通过；它在该处的 3 个失败（`taskkill`、一次 EPERM 进程组探测）在移除解码接线后同样复现。沙箱套件保留其单个环境失败（某个测试在只有 `powershell.exe` 的主机上期待 `pwsh` 作为 argv[0]），拒绝匹配套件——`diagnostics.spec.ts`、`escalation.spec.ts`、`provider-chain.spec.ts`——36 个全部通过。

## 延期

- **被切开的字符仍会单独解码。** 只含某个字符中段的增量读取没有完整字符可保留，只能保留其替换字符直到下一次读取。跨读取解码一条流需要收集层扣下一个不完整尾部，而这会改变 `readFrom` 的返回值以及消费者续读所用的偏移量。
- **只重读 ANSI 代码页。** 控制台配置不同的主机所用 OEM 代码页流，以及控制台编码与 ANSI 默认值不同的主机代码页流，都保留 UTF-8 读法。
- **在其他编码下恰好合法的字节仍然不对。** 解码规则信任的是合法 UTF-8；某个 CP936 流的字节恰好构成合法 UTF-8 时（许多双字节 CP936 字符都是如此），它与文本无法区分，因此不会被修复。
- **只有文本会进入回退。** 收集流里的二进制载荷会按控制台代码页解码，而此前按 UTF-8 解码；两种读法都有损，也都不是载荷通道。

## 备选方案

**改写命令让 preamble 先于解析运行。** 已否决：`cmd /c chcp 65001` 外壳与 `Invoke-Expression` 投递都会改变文档化的单 argv 调用方式，以及沙箱拒绝分类所匹配的 stderr 文本，而这个工具自身的 README 与 [pwsh 工具与执行器决策](../../archived/feature/2026-08-01-pwsh-tool-and-executor.md)都记录了该调用方式。415 个字符不足以承担这个风险。

**在 pwsh 执行器里解码，而不是在收集层。** 已否决：执行器拿到的是文本而不是字节。`SubprocessOutputReader.readFrom` 返回 `text`，放在那里的任何解码都会在 `toString('utf8')` 已经替换掉畸形序列之后才运行。

**通过解码 spill 文件恢复字节。** 已否决：spill 文件只在流超过内存上限时存在，持有的是同一条已被解码的流，把它读回来等于给内存路径加上一次文件读取。

**遍历候选代码页并挑选最像的那个。** 已否决：字节本身无法给两种遗留读法排序，而主机已经声明了它的原生程序写的是哪一种。

## 影响

- 代码页主机上 PowerShell 自身的解析错误文本变得可读，因此任何环境变量都触达不到的那一类流现在能活着通过收集层；[生产侧记录](2026-09-27-pwsh-child-process-output-encoding.zh.md)登记为未处理的缺口由此关闭。
- 该记录写明它的改动既不碰 preamble 也不碰收集层。其中 preamble 那半仍然成立；这句话里收集层那半由本记录取代，因为本次改动改变了收集层对畸形读取的处理。
- subprocess 缝的每个消费者都继承该规则，而不只是 pwsh 工具：Windows 上的 `bash-local`、LSP stderr 尾部、PTC 运行时都从同一个收集层读取文本。在 POSIX 主机上以及在合法流上，解码出的文本不变。
- 解码路径现在依赖一个此前不存在于该文件的 Win32 绑定。它在第一次遇到畸形读取时才惰性绑定，绑定失败的主机保留替换字符解码，而不是让读取失败。
- 回退是被记录的而不是静默的：`consoleCodePageFallbacks` 会计数，因此后续的会话复盘能把主机代码页恢复与从未畸形的流区分开。
