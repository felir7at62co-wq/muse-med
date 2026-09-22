---
description: "把短剧流水线的付费生成前资产对账做成一个模型可见的工具：比对剧变项目里已选用的资产与清单、写出宿主付费钩子读的证据、并逐条记录处置，供运行剧变短剧流水线的使用者与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-drama-assets

[English](README.md) | 中文

## Summary

当短剧会话必须在为一张新资产付费之前知道剧变项目里已经有什么时，用这个包。工具 `drama_assets` 同时读两边——剧变远端已选用的资产与项目自己的 `assets_manifest.json`——并写出宿主付费钩子读的证据：`_probe/asset-reconcile.json`。`reconcile` 做这次比对；`dispose` 记录某人对它发现的某条资产的决定。清单只记录这条流水线生成过什么，不等于项目里有什么——只看清单的模型会把已经存在的资产生成第二遍。

## Table of Contents

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把插件作为短剧预设的一行挂载；它需要工具注册表与凭据库：

```yaml
- id: tool-drama-assets
  name: '@deepseek-ai/dsh-tool-drama-assets'
  config:
    timeoutMs: 30000        # per-read abort budget
    workspaceSecrets: true  # let .agents/secrets/pipeline.env stand in for a missing store value
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseUrl` | 客户端自己的默认源 | 两次远端读取的源覆盖。 |
| `timeoutMs` | `30000` | 单次读取的中止预算，毫秒，1–60000。 |
| `workspaceSecrets` | `true` | 凭据库没有值时，是否允许最近的 `.agents/secrets/pipeline.env` 提供 token。 |

token 本身就是凭据引用 `JUBIANAI_ADMIN_TOKEN`，每次读取都经 `ctx.credentials` 解析，绝不写进结果、日志或预览。

### 两个方法

| 方法 | 读取 | 写入 | 用途 |
|---|---|---|---|
| `reconcile` | 剧变项目的资产与材质，以及清单 | `<project_dir>/_probe/asset-reconcile.json` | 在任何付费生成之前，知道哪些已选用资产清单里没有 |
| `dispose` | 证据文件 | 同一个证据文件 | 记录对某条未登记资产的一个决定——`registered` 或 `ignored` |

| 参数 | 何时必填 | 含义 |
|---|---|---|
| `method` | 始终 | `reconcile` 或 `dispose` |
| `project_dir` | 始终 | 含 `assets_manifest.json` 的项目根目录，绝对路径 |
| `asset_id` | `dispose` | 这个决定针对的未登记资产 |
| `status` | `dispose` | `registered` 或 `ignored` |
| `note` | `ignored` | 为什么这个资产不需要；判 `ignored` 时必须非空 |

`reconcile` 只发两个请求，都是提供方自己的列表接口，不计费。`dispose` 一个都不发。两个方法写的文件只有证据文件一个，经临时文件加改名写入。

### 判定口径

| 证据字段 | 含义 |
|---|---|
| `source` | 两次远端读取各返回多少行、有多少资产存活（`delFlag == "0"`）、多少已选用（`isUsed == 1` 且 `hsAssetStatus == "Active"`） |
| `manifest` | 清单声明了什么：`items`、`lead_readonly_records`，以及去重后的资产 ID |
| `matched` | 远端已选用且清单里也有的资产数 |
| `unregistered` | 远端已选用但清单里没有的资产，带材质的 id、名字、类别、URL 与创建时间 |
| `dangling` | 清单里有、但远端项目没有的资产 ID |
| `disposition` | 每条未登记资产一个 `{status, note}`，跨次运行保留 |
| `blocking` | 还没有 `registered` 或 `ignored` 决定的未登记资产 ID |
| `ignored_without_note` | 判为 ignored 但 note 为空的资产 ID |
| `ready` | `blocking` 与 `ignored_without_note` 是否都为空 |
| `policy` | 钩子读到的付费策略：KU_AI 每张 0.12 元、最多 3 次、最坏 0.36 元 |

两条规则闭环。某人登记进清单的资产会在下次 `reconcile` 被认出来，处置自动变成 `registered`，并保留它原来的 note。某条资产已被选用、材质仍是 `Active`，但资产行的 `delFlag` 不是 `"0"`，那它就不是资产：只有存活的行参与比对。

工具结果不是证据文件。文件按流水线自己的写法——提供方没给的字段是 JSON `null`——而工具结果把同一件事写成空串或 `0`，因为工具 schema 没有可空标量。`0` 不是提供方会发出的类别号，所以 `asset_type: 0` 读作「没有类别号」。

`ready` 只看处置，与流水线自己的 Python 工具算法一致。宿主钩子还要求 `ran_at` 新鲜，而 `dispose` 不写它：一个项目如果只有一条裸 `dispose` 结果，工具会报 `ready: true`，钩子仍会以「证据不可用」拒绝它。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现内部——点击展开</summary>

本节说明一次调用是怎么判定的、代码在哪里；可观察行为在[使用本包](#use-this-package)里已经写全。

### 设计取舍

这个包建立在三条承诺上：

- **证据文件是契约，不是输出。** 生产工作间里的 `_tools/asset_reconcile_report.py` 与宿主侧的 `reconcileFirst` 钩子都读它。字段名、类型与语义由这两个读者定死，所以本包是移植它们而不是自己设计；这里写错 schema，就是那个专门用来拦住静默失败的检查自己静默失败。
- **远端只读，本地只写一个文件。** 两次剧变调用都是提供方的列表接口。没有写方法、没有计费方法，也没有第二个文件：一个还没对账的项目不该变成一个清单被写了一半的项目。
- **比对自己负责顺序。** `unregistered` 按资产 ID 升序写出，与流水线自己的报告一致，所以同一项目的两次运行产出可比的文件。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、凭据解析、参数 schema 与描述，以及结果的两种写法 |
| [`src/remote.ts`](src/remote.ts) | 两次远端读取：翻页、读者校验过的行，以及读者没有映射的提供方字段 |
| [`src/manifest.ts`](src/manifest.ts) | `assets_manifest.json` 的读取与已声明资产 ID |
| [`src/reconcile.ts`](src/reconcile.ts) | 比对、处置继承、判定、证据写入，以及 `dispose` |
| [`src/types.ts`](src/types.ts) | 只有类型：证据文档、远端行与清单 |
| — | 不发布运行时 invariant 伴生模块：本包在调用之间不持有状态、不暴露快照，每个答案都是它读到的文件与两次远端列表的函数。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

包级契约不够用时读这些页。

- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-drama-assets) —— 模型实际收到的 `drama_assets` schema 与描述原文。
- [工具子系统参考](../../../docs/subsystems/tools.zh.md) —— 参数 DSL、规范化输出值与每次调用进入的流水线。
- [drama 组地图](../README.zh.md) —— 短剧流水线的同级包。

-----

<a id="model-experience"></a>
## 模型体验

### `drama_assets` 工具 schema

#### 模型看到什么

请求的工具列表里多一个名为 `drama_assets` 的工具：本包的 `description`、五个参数，以及结果的 JSON schema，三者在生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-drama-assets)里都有原文。描述里写明两个方法、三条比对口径（`delFlag == "0"`、`isUsed == 1` 且 `hsAssetStatus == "Active"`、`unregistered` / `dangling` / `matched`）、`ready` 才是宿主钩子读的那一条、24 小时有效期、这个工具存在的起因，以及它绝不做的两件事。结果 schema 声明 `method`、`ready`、`ready_reason`、`evidence`、`asset_id`、`script_id`、`ran_at`、`source`、`manifest`、`matched`、`unregistered`、`dangling`、`disposition`、`blocking`、`ignored_without_note`、`policy`、`cross_project_note` 与 `next`；渲染出来的内容就是同一份值的美化 JSON。某个方法不报的字段是「不带」，不是「填默认值」，schema 也不强制它们。

#### Token 影响

有条件、且随项目规模有界：schema 与描述是固定的，结果随 unregistered 与 dangling 列表增长——各一行，每行带提供方自己的名字、类别、URL 与创建时间。没有待处置项的项目返回最短的有用答案。

#### KV Cache 影响

只追加。工具注册带着稳定的名字、描述与 schema，所以已挂载的行保持请求前缀可复用；只有改动本包的描述或 schema 才会让它失效。一次调用的结果作为那次调用自己的工具结果追加，不改写更早的消息。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了这个包是什么、不是什么。它们是当前约束，不是待办清单。

- **比对只用一个页大小** —— 两次读取都按提供方文档规定的上限 1000 行请求，并按声明的总数继续翻页，所以比这更大的项目每 1000 行多一个请求。翻页本身没有上限。
- **token 可能来自工作间文件** —— `workspaceSecrets` 打开时，凭据库没有值的场合由最近的 `.agents/secrets/pipeline.env` 顶上。那个文件是流水线自己的密钥存放处，不归本包管理。
- **`dispose` 不重新比对** —— 它改的是它找到的那份证据里的处置。上次 `reconcile` 之后才在远端被选用的资产不在那份证据里，所以对它的处置会被记下来，但要等下次 `reconcile` 才会被列出来。
- **`dispose` 可以写出没有比对的证据** —— 在一个没有任何证据的项目上，`dispose` 会新建一份只含 disposition、`blocking`、`ignored_without_note` 与 `ready` 的文件。宿主钩子仍然会拒绝它，因为它要求只有 `reconcile` 才会写的、新鲜的 `ran_at`。
- **清单是唯一的本地一侧** —— 记在别处的资产（`matches/*.json`、流水线状态文件）不算已登记。登记一条资产意味着 `assets_manifest.json` 里有一行带整数 `jubian_asset_id` 的记录。
- **字符串形式的 `jubian_asset_id` 算已声明** —— 清单读者只留整数 ID，所以 ID 写成字符串 `"83840"` 的行不算已声明；它也不算悬空，因为悬空判定用同样的读法读同一个字段，于是这一行对两张清单都不可见。
- **`cross_project_note` 只被继承，从不被写入** —— 该字段从上一份证据原样保留并返回；跨项目检索本身属于 `jubian-asset-library` 技能。
- **写入不是跨进程事务** —— 临时文件加改名让一次写入是原子的，但同一个项目上两个并发的 `dispose` 仍可能交错各自的读-改-写。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>维护者工作上下文——点击展开</summary>

这份 Dev Note 是维护者的工作上下文：还没定的问题与方向。它明确不是权威——已发布的行为、限制与已接受的取舍在上面的章节、包代码与链接文档里。

这次比对是流水线 `_tools/asset_reconcile.py` 的移植，而且是逐字段移植。那个脚本留在生产工作间里，仍是证据文件字节布局的参照；本包是不需要在用户机器上装 Python 的那条路。`ready_reason` 是 Python 工具会写、本包不写的唯一字段：它是推导出来的，宿主钩子自己算一份，`reconcile` 改成在工具结果里返回同一句话。

token 解析照 `packages/jubian/tool-jubian/src/index.ts` 来，包括工作间密钥回退，而不是再引入第三个解析器。`readAssetList` 与 `readMaterialList` 仍然是「一页是什么」的权威，但本包从它们接受的行里读出 `delFlag`、`createTime` 与两种名字拼写——映射不带这些字段，而证据 schema 需要它们。
</details>
