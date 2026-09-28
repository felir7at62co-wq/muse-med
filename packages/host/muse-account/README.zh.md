---
description: "在桌面版设置中登录 MUSE，让智能体检索并分页阅读账号获授权的剧本与 Wiki 来源。"
kind: "package-reference"
---

# @deepseek-ai/dsh-muse-account

[English](README.md) | 中文

## Summary

用户可以在桌面版设置中登录 MUSE、查看已保存的账号并退出，无需在模型会话中输入密码。智能体可以检索知识库，并按 ID 阅读获授权的剧本或 Wiki 页面。编辑模式可以在起草前阅读剧本开头。账号访问需要已配置的 MUSE 网关，以及服务端授予的来源阅读权限。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

在 Muse Desktop 中打开**设置 → MUSE 账号**。页面先显示本地保存的状态；点击**验证状态**可向网关确认。输入用户名和密码即可登录。注册选项初始未选中；如果希望登录失败后尝试创建该用户名，可主动勾选。请求成功后，页面会清空密码输入框。

### Minimal configuration

桌面 Host 从 [`desktop.cordis.patch.yml`](../../../apps/desktop-host/config/desktop.cordis.patch.yml) 装载此配置行：

```yaml
- name: '@deepseek-ai/dsh-muse-account'
  config:
    baseUrl: https://dev.muse.aigc-pipeline.cn
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseUrl` | 必填 | HTTPS 网关源地址；本机回环网关可使用 HTTP。 |
| `accountHome` | 当前 DSH 主目录 | 存放本产品账号会话文件的绝对目录。 |
| `requestTimeoutMs` | 15,000 | 账号和知识库授权请求的超时毫秒数，可设为 1,000 至 120,000。 |

[配置目录](../../../docs/config-catalog.zh.md)由插件 schema 生成。本包已包含在桌面 Host 配置中，不是独立应用启动入口。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现细节 — 点击展开</summary>

通过身份验证的 `museAccount` Remote 命名空间把设置页调用送至 Host 账号控制器。控制器向已配置的网关提交凭据、确认返回的身份，并把绑定网关源地址的 cookie 原子写入产品主目录。Remote 响应只包含固定错误类别和账号身份，不包含密码或 cookie。

Host 启动内置的本地 MCP 子进程并等待工具发现。知识库工具执行时，子进程读取已保存的 cookie，通过 `/api/kb/access` 换取短时 bearer，然后调用同源的只读 MCP 接口。它不持久化或返回 bearer。检索返回获授权的 ID，以及 `类型` 和 `标定` 文本；`read` 分页阅读获授权的来源或 Wiki 文档；`read_opening` 只接受获授权且标为 `标定: viral-script` 的 `SRC-...` 来源，并分页阅读其前 24,000 字。MCP 客户端使用通用文本卡片呈现这些工具；每次阅读返回 6,000 字页面和续读元数据，本地失败只返回固定错误码，不传递上游响应文本。

本包不提供 `./invariant`：账号状态和已注册 MCP 工具都能通过各自所属的服务或工具注册表观察，没有可能独立产生分歧的第二份状态。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [MCP 客户端](../../mcp/mcp-client/README.zh.md) — 带服务端名称的工具命名与生命周期。
- [桌面应用组合](../../../apps/desktop/README.zh.md) — 已交付的应用配置。
- [账号与知识库决策](../../../.agents/notes/implemented/feature/2026-09-28-muse-account-kb-access.zh.md) — 凭据与来源访问的取舍。

-----

<a id="model-experience"></a>
## Model Experience

### Request context and condition

#### What the model sees

内置 MCP 服务连接后，模型会收到 `mcp__muse-account__muse_account_status`、`mcp__muse-account__muse_kb_search`、`mcp__muse-account__muse_kb_read` 和 `mcp__muse-account__muse_kb_read_opening` 的工具 schema。状态调用返回本地保存或经网关确认的身份。检索返回摘要和 ID；每次阅读返回一个 6,000 字页面，以及来源和续读信息。密码、cookie 和 bearer 均不作为模型工具参数或结果字段。到达模型的工具调用参数和结果仍属于 Session 数据。

#### Token effect

服务装载期间，四个工具 schema 构成稳定的请求开销。调用将返回文本追加到对话；每个本地知识库结果最多 128 KiB，网关以每页 6,000 字返回。本包不增加系统提示词文本。

#### KV Cache effect

稳定的工具 schema 保留已有可复用的请求前缀。新的工具结果会延长对话；账号状态和知识库内容可在不同调用之间变化，但不会替换先前记录的 token。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

以下限制适用于内置桌面账号流程。

- **同一系统用户的文件访问** — 保存的 cookie 不在模型会话中，但以同一系统用户身份运行的智能体进程，仍可能通过文件工具读取会话文件。设置页和 Remote 路由不提供完整隔离；更强的隔离需要系统凭据库、独立账号或更严格的沙箱读取权限。
- **依赖网关** — 登录和知识库阅读需要已配置的网关。集成测试使用本地替身；此处尚未验证真实账号登录、来源授权及远程 MCP 往返。
- **智能体指令** — 编辑模式要求智能体在起草前阅读相关开头页面；Host 不强制执行写作前检查。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
