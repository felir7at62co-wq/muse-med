---
description: "登录 MUSE，让智能体私有保存经复核的剧本，再检索和阅读账号获授权的来源。"
kind: "package-reference"
---

# @deepseek-ai/dsh-muse-account

[English](README.md) | 中文

## Summary

用户可以在桌面版设置中登录 MUSE，无需在模型会话中输入密码。智能体可将获授权视频或小说整理并复核后的剧本保存到本账号的私有知识库，再按 ID 检索和阅读。它也可阅读管理员授权的剧本和 Wiki 参考资料。这些操作需要已配置的 Muse 网关。

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

Muse Desktop 在空白首启时先提供 MUSE 登录，再检查模型配置；选择**稍后登录**仍可从侧栏和**设置 → MUSE 账号**进入。打开页面时会刷新模型目录；点击**验证状态**可向网关确认账号身份。输入用户名和密码即可登录。注册选项初始未选中；如果希望登录失败后尝试创建该用户名，可主动勾选。请求成功后，页面会清空密码输入框。同一登录会话会加载网页版模型目录，并用于模型调用、知识库和语音转写。新配置自动选择首个 Muse 模型；模型设置仍可添加自定义提供方和凭据，用户已明确选择的自定义默认模型会保留。退出登录只撤下 Muse 模型。官方 DeepSeek 路由通过 Muse 代理时显式配置思考协议和必需的 `reasoning_content` 字段，不依赖从代理 URL 猜测上游提供方。

### Minimal configuration

桌面 Host 从 [`desktop.cordis.patch.yml`](../../../apps/desktop-host/config/desktop.cordis.patch.yml) 装载此配置行：

```yaml
- name: '@deepseek-ai/dsh-muse-account'
  config:
    baseUrl: https://muse.aigc-pipeline.cn
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseUrl` | 必填 | HTTPS 网关源地址；本机回环网关可使用 HTTP。 |
| `excludedModelPrefixes` | `[]` | 账号供应模型需要排除的模型 ID 前缀，忽略大小写；不影响自定义提供方。 |
| `modelRefreshMs` | 60,000 | 模型目录刷新间隔毫秒数，可设为 10,000 至 3,600,000。 |
| `accountHome` | 当前 DSH 主目录 | 存放本产品账号会话文件的绝对目录。 |
| `requestTimeoutMs` | 15,000 | 账号和知识库授权请求的超时毫秒数，可设为 1,000 至 120,000。 |
| `asrRequestTimeoutMs` | 300,000 | 一次压缩音频上传与网关响应的超时毫秒数，可设为 10,000 至 1,800,000。 |

[配置目录](../../../docs/config-catalog.zh.md)由插件 schema 生成。本包已包含在桌面 Host 配置中，不是独立应用启动入口。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现细节 — 点击展开</summary>

通过身份验证的 `museAccount` Remote 命名空间把[设置界面](../../client/ui-muse-account/README.zh.md)调用送至 Host 账号控制器。控制器向已配置的网关提交凭据、确认返回的身份，并把绑定网关源地址的 cookie 原子写入产品主目录。Remote 响应只包含固定错误类别和账号身份，不包含密码或 cookie。

Host 启动内置的本地 MCP 子进程并等待工具发现。每次知识库调用时，子进程通过 `/api/kb/access` 将已保存的 cookie 换成短时 bearer，再调用同源 MCP 接口；它不持久化或返回 bearer。`muse_kb_ingest_script` 一次提交最多 12 集或章经复核的 Markdown 剧本，请求总量不超过 2 MiB，并逐项报告已写入、已存在或失败。检索返回本账号私有 `private/SRC-...` ID 和管理员授权的共享 ID；阅读工具按页读取两种来源，开头阅读最多 24,000 字符。每次阅读返回 6,000 字符页面与续读信息；本地失败只返回固定错误码，不传递上游响应文本。

仅 Host 使用的 `MuseAsrClient` 为 `audio_transcribe` 工具读取同一账号会话，并通过网关上传音频、查询按账号隔离的任务 ID。客户端校验并保留分句与字词的秒级时间戳，拒绝无效时间范围。桌面端没有 ASR 或 TOS 凭据设置。未登录、网关不可用或服务器未配置 ASR 都明确报错。服务器部署与任务限额见 [`services/muse-accounts`](../../../services/muse-accounts/README.zh.md)。

本包不发布运行时不变量伴随插件，因为账号状态和已注册 MCP 工具都能通过各自所属的服务或工具注册表观察，没有可能独立产生分歧的第二份状态。

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

内置 MCP 服务连接后，模型会收到 `mcp__muse-account__muse_account_status`、`mcp__muse-account__muse_kb_ingest_script`、`mcp__muse-account__muse_kb_search`、`mcp__muse-account__muse_kb_read` 和 `mcp__muse-account__muse_kb_read_opening` 的工具 schema。写入工具接收复核后的剧本文字和来源标识，逐段返回结果与私有 ID。检索返回摘要和 ID；每次阅读返回一个 6,000 字符页面及续读信息。密码、cookie 和 bearer 不出现在工具参数或结果中。模型可见的参数与结果仍属于 Session 数据。

#### Token effect

服务装载期间，五个工具 schema 构成稳定的请求开销。调用将返回文本追加到对话；每个本地知识库结果最多 128 KiB，网关以每页 6,000 字符返回。本包不增加系统提示词文本。

#### KV Cache effect

稳定的工具 schema 保留已有可复用的请求前缀。新的工具结果会延长对话；账号状态和知识库内容可在不同调用之间变化，但不会替换先前记录的 token。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

以下限制适用于内置桌面账号流程。

- **同一系统用户的文件访问** — 保存的 cookie 不在模型会话中，但以同一系统用户身份运行的智能体进程，仍可能通过文件工具读取会话文件。设置页和 Remote 路由不提供完整隔离；更强的隔离需要系统凭据库、独立账号或更严格的沙箱读取权限。
- **依赖网关** — 账号私有写入与知识库阅读需要已部署的网关、私有用户目录和明确的共享文档授权。只发布源码不会启用这些能力；此处尚未验证真实登录、授权及远程 MCP 往返。
- **智能体指令** — 编辑模式提示智能体在起草前阅读有用的剧本和案例材料；Host 不强制执行写作前检查。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
