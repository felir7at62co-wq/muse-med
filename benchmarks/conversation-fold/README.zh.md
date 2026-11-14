---
description: "用于紧凑 Chat 历史、实时工具参数和 Assistant 文本的必需 Node 基准，以及流式校准和可执行回归负控。"
---

# Conversation fold 基准

[English](README.md) | 中文

## 概述

这些基准在普通 Node 中测量生产 Conversation 组装与 Chat builder。覆盖内容包括紧凑历史回复、准备中的工具参数，以及实时 256 KiB Assistant 文本块。独立 worker 的操作计时不包含夹具准备和显式垃圾回收。网络传输、浏览器渲染与模型节奏不在测量范围内。

## 目录

- [运行](#run)
- [测量](#measurements)
- [托管环境流式校准](#hosted-streaming-calibration)
- [回归控制](#regression-controls)
- [开发备注](#dev-note)

<a id="run"></a>
## 运行

`pnpm run test:bench` 先构建生产库和私有 worker，再运行串行性能清单。已有这些产物后，可用 `pnpm exec vitest run --config vitest.bench.config.ts benchmarks/conversation-fold --no-file-parallelism --maxWorkers=1` 选择本目录。worker 拒绝 TypeScript loader，也拒绝解析到构建后 `lib` 入口之外的 workspace 导入。

<a id="measurements"></a>
## 测量

历史用例折叠 200 条回复，其中包含 500,000 个紧凑存储的文本与推理 delta。其 40 ms 绝对限制与 3.125 倍缩放限制保持独立。准备工具用例发布完整的 write 或 Bash 预览。实时 Assistant 用例追加 4,096 或 16,384 个片段，只 flush Chat 一次，并读取输出的每个字符；保留堆包含 GC 后仍可达的 Assembler 和已发布结果，沿用 20 MiB 限制。

<a id="hosted-streaming-calibration"></a>
## 托管环境流式校准

流式 wall 限制使用固定的托管环境预期值与共享的 1.25 倍波动余量，不再重复应用共享的 2 倍参考机器系数。其他时间、内存与比例限制保留原有计算方式。这次校准改变验收限制，不改变产品组装，也不代表实现提速。

| 片段数 | 托管环境预期值 | Wall 限制 |
|---|---|---|
| 4,096 | 32 ms | 40 ms |
| 16,384 | 91 ms | 114 ms |

[基准文件](conversation-fold.bench.client.ts)中保存的各组五个样本来自 Node 24.22.2 Linux x64 任务。运行 43370634776 使用 EPYC 9V45；运行 43385079062 和 43401713553 使用 EPYC 7763，具有四个可用 CPU。相关 fold 实现未变化。托管环境预期值对两次 7763 运行中的最大中位数向上取整，保留较慢运行，而非选择最接近通过的结果。

| 工作负载 | 43370634776 中位数 | 43385079062 中位数 | 43401713553 中位数 |
|---|---|---|---|
| 4,096 普通文本 | 16.994 ms | 29.981 ms | 27.628 ms |
| 4,096 前半空白推理 | 18.558 ms | 31.806 ms | 29.371 ms |
| 16,384 普通文本 | 54.476 ms | 87.865 ms | 80.162 ms |
| 16,384 前半空白推理 | 55.000 ms | 90.825 ms | 80.645 ms |

先前的 12/32 ms 参考余量来自 macOS arm64 Node 26.8.2，并非托管环境校准。[性能政策](../../.agents/notes/implemented/testing/2026-09-04-session-open-performance-gate.zh.md)要求 Node 或 runner 变化后，以相同工作负载重新采样并审查预算。统一静态限制对较快 runner 上的小幅回归敏感度较低；CPU 型号匹配和环境覆盖不选择验收结果。

<a id="regression-controls"></a>
## 回归控制

保存样本的控制与实时测量使用同一个验收断言：历史 30/80 ms 限制拒绝已记录的失败，托管环境限制接受保存的中位数，并拒绝各托管限制加 1 ms 或相对最慢保存中位数退步 50% 的情况。

可执行累计 trim 负控将刚编译的私有 worker 复制到独立临时目录。它恰好替换一条文本和一条推理可见性表达式，恢复先前对累计文本块执行 trim 的计算；表达式缺失或重复都会拒绝变换。生产源码与导出保持原样。每个普通文本片段数量分别交替运行五个独立原始进程与五个负控进程。两者都必须保持完整文本校验和及堆限制；原始中位数必须符合托管限制，回归中位数必须被该限制拒绝。日志保留两个 worker 的哈希、全部样本和替换数量。清理会等待子进程结束后再删除临时 worker。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>校准验证状态</summary>

[托管任务 132181746420](https://github.com/felir7at62co-wq/muse-med/actions/runs/43511240887/job/132181746420)通过了两项可执行累计 trim 负控。每种工作负载交替运行五个原始进程和五个负控进程，保留相同的完整文本校验和，并且恰好改动两处编译后的可见性表达式。

| 片段数 | 原始中位数 | 回归中位数 | Wall 限制 |
|---|---|---|---|
| 4,096 | 22.968 ms | 290.453 ms | 40 ms |
| 16,384 | 69.909 ms | 1,141.370 ms | 114 ms |

这些结果验证了替代 30/80 ms 的 40/114 ms 校准限制：每个原始实现均通过，每个恢复累计 trim 计算的负控均失败。它们证明校准已在托管环境通过验证，不代表产品提速，也不能替代对后续版本和 runner 变化的检查。

</details>
