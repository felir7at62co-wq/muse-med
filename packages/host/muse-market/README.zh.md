---
description: "Muse 发布包与保留版本的本地市场安装。"
kind: "package-reference"
---

# @deepseek-ai/dsh-muse-market

[English](README.md) | 中文

## 概述

安装者可以下载或导入经过校验的 Bot 与 Skill 版本而不立即启用，随后为新会话启用准确版本，同时让已有会话保留其引用。创作者可以在明确上传私有草稿前，先在本地制作并检查发布包。独立云端 profile 保存受邀发布者、不可变版本与管理员审核记录。

## 目录

- [使用本包](#use-this-package)
- [发布与恢复](#publication-and-recovery)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

桌面端与云端市场 profile 通过工作区构建的 tarball 安装这个私有包。tarball 包含 Host 插件、云端 profile 入口、发布包格式工具和生成的 Remote 模块。

[桌面组合](../../../apps/desktop-host/config/desktop.cordis.patch.yml) 在 `agentPresets` 和 `skills` 旁挂载 Host 服务。其 Remote API 可供独立市场 UI 完成发现、本地安装管理及发布包制作；本包不添加桌面设置页或主区域市场页。`sources().website` 打开[市场网页](../../../apps/market-web/README.zh.md)。`baseUrl` 是 HTTPS 源站；仅回环测试接受 HTTP。`root` 默认使用 `dshHomePath('muse-market')`。压缩大小、展开大小、文件数、请求超时和允许的 Bot 模块都是经过校验的配置字段。下载后保持未启用，需明确启用。已启用的 Bot 出现在新会话的模式选择器中。

`./cloud-host` 插件使用独立的回环 `webServer` 和绝对路径的管理员策略文件。网关验证用户身份，以私有共享密钥转发受限数据流；市场 profile 拒绝未经认证的身份声明。配置及启动见[网关部署](../../../services/muse-accounts/README.zh.md#muse-market)。

生成的 Client Remote 通过 `museMarket.installPackage(id)` 下载，通过 `museMarket.removePackage(id)` 移除。Host 本地调用仍为 `ctx.museMarket.install(id)` 和 `ctx.museMarket.remove(id)`。远程调用别名避开 Client Remote 命名空间的内部生命周期方法，不改变安装状态或移除检查。

桌面发现页从 `baseUrl` 读取首批公开 Bot 和 Skill 目录。`installLegacy(id, sha256)` 匿名下载所选原包，对照当前目录校验 SHA-256，并创建未启用的本地安装。安装记录同时保存原目录标识、原包摘要和已校验的本地包。重复导入同一原包会保留启用状态。目录也提供原包下载链接。转换包供本地使用，Host 拒绝发布或导出转换包。

首批 Skill 保留调用名及其资源。三个 Office Skill 各自在技能目录内保留共享辅助脚本，技能说明中的相对路径随之更新。首批 Bot 须匹配审核过的原包摘要，角色设定通过当前桌面预设和已安装工具运行。Codex 和 Claude Code 委派仍依赖对应的本地 provider。市场导入不会执行旧 Bot 原包中的表达式或安装脚本。

<a id="publication-and-recovery"></a>
## 发布与恢复

两种内容均使用 ZIP 发布包，包含 `muse-package.json`、清单明确声明的完整 `skills/<name>/` 目录，以及记录字节数和 SHA-256 的文件清单。Bot 行只包含允许的已安装模块和声明式 JSON 配置。安装发布包不会下载 Node 模块、执行安装脚本或求值 YAML 表达式。Bot 包不能声明通用的宿主目录 Skill 扫描器或市场内部 Skill provider；后者由 Host 针对准确的已启用版本合成。未声明的 Skill 目录、敏感文件名、本机绝对路径、制作资源中的链接、路径越界、大小写冲突文件名及超限包都会被拒绝。智能体后续使用普通工具时仍可执行所选 Skill 的资源；preset 作用域不是代码沙箱。作者与审核者检查完整导出包及第三方使用条件。

Bot 声明 `@deepseek-ai/dsh-tool-skill` 时，其配置必须明确设置 `scopedCatalogOwner: true`，包括分组内的声明。否则云端与本地共用的清单校验器会拒绝该包：未声明目录所有权的子加载器会被 Host 加载器清除目录。此要求不设置 `catalogSourceLimits`，也不改写作者配置。

Bot 清单可以通过标识符绑定市场内置形象。`presetPortrait` 字段支持完整的形象库。原有的 `portrait` 字段继续受支持。Skill 清单不能绑定 Bot 形象。

制作仅读取所选 Skill 目录和一个所选 Bot 声明。不支持的本地配置会失败，不会静默遗漏。导出留在本地；上传草稿需要明确操作；提交与公开审核分别进行修订检查。发布者、作品名和版本号的组合不可覆盖，包括被退回的草稿。上传重试保留幂等键。桌面端制作 Bot 时会将自动匹配的形象写入导出包和上传的草稿。上传导入的 Bot 包时，如果原包未绑定形象，Host 会将自动匹配的形象绑定到上传副本。公开目录排除草稿、被退回及已下架版本。下载带版本的发布包需要登录。

本地文件按摘要保存。带版本号的安装账本保留启用状态和会话引用。每个 Bot 版本获得独立的 `market-<release-id>` preset ID，首次绑定时激活。独立 Skill 在本地账本中绑定到会话，并注册到其作用域。停用 Skill 影响新会话；已有会话保留原版本。被引用版本不可移除；被引用 Bot 不可停用。恢复需要原市场目录与缓存文件。市场账本不增加 Session 头字段，应与本地会话一同备份。云端 SQLite 使用单调递增的模式版本和发行目录外的独立数据目录。

导入与已安装云端发行具有相同 SHA-256 摘要的 ZIP 时，沿用该发行的标识和启用状态，仍可导出或明确上传为草稿。制作本地发布包时保留独立的草稿标识。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

`./format` 提供浏览器可用的元数据校验和受限 ZIP 元数据预览。预览不验证资源正文或文件摘要；云端上传与 Host 安装仍校验完整发布包。`package.ts` 负责完整压缩包解析；`local.ts` 负责不可变本地文件与账本；`index.ts` 适配 preset、作用域 Skill 和 Remote 操作；`server.ts` 管理云端发布状态。云端在读取上传正文前限制并发。不把上传的模块安装到 profile 中。

</details>

<a id="model-experience"></a>
## 模型体验

### Request context and condition

#### What the model sees

已启用的独立 Skill 在新会话创建时固定版本，只进入其作用域注册表；Bot Skill 来自其 preset 作用域内准确的 Bot 版本。所选 Bot 为尚未开始的会话提供人格和插件组合。随附的桌面 Host 及短剧/创作加载器每个步骤最多向模型展示三个允许模型调用的 `muse-market` 摘要；其他来源不受此限制。嵌套加载器各有独立配置，包括上传 Bot 自行声明的加载器。作用域注册表保留所有已固定的 Skill，面向用户的发现没有摘要曝光限制。这只限制摘要曝光，不限制调用权限。Skill 加载器可见时，在自由文本旁使用 `/name` token，会复用现有的[用户显式 Skill 调用](../../skill/tool-skill/README.zh.md#use-this-package)，为该条消息加载任何允许用户调用的已绑定 Skill，包括未展示摘要的 Skill；模型调用仍执行独立的调用检查。目录和已加载指令沿用现有持久化消息，不增加 Session 头。制作和发布需显式调用 Remote；账号 Cookie 与网关共享密钥不会通过 Remote 服务返回。

#### Token effect

清单包含名称和截断后的描述，不包含完整正文。桌面摘要选择先考虑显式名称，再考虑最新直接用户消息的词法匹配，不发起模型请求。加载 Skill 时，通过现有 `skill` 工具或用户显式调用返回其指令。摘要限制既不限制已加载正文，也不限制保留的指令历史。

#### KV Cache effect

Bot 人格和会话的 Skill 清单会影响请求前缀。固定版本让已有会话不受后续启用变更影响。摘要选择变化时，通过现有 Skill 消费方追加替换清单。工具加载和显式调用都会追加指令内容，不替换历史内容。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

以下限制适用于 Host 及其云端 profile。

- 云端目录每次检索最多返回 100 项。本地摘要排序采用确定性的词法选择，不是语义搜索。[客户端市场](../../client/ui-muse-account/README.zh.md)提供主区域页面。消息级选择标签尚未实现；当前显式调用复用 `/name`。
- 提供方目录候选不包含指令正文，正文查找只校验所选版本后读取所请求的 Skill。首次目录发现仍会校验所有已绑定版本，并读取其 Skill 文件以解析描述和调用开关；不读正文的元数据优先发现暂缓。
- Bot 制作仅接受云端和桌面策略共同允许的可移植声明；含本地条件的现有产品 Bot 需要作者适配。首版不把已安装的市场 Skill 作为制作来源或再次打包；制作仅选择普通本地来源。
- 本地草稿及其后来发布的云端版本保留不同的不可变身份；替换草稿 ID 会破坏已保留的 Session 引用。会话删除后仍保留引用，未携带市场账本复制的会话无法恢复独立 Skill 的绑定。
- 当前实现不包含收费、评分、合集、团队角色编辑、自动兼容迁移或自动运行审核案例。
- 上传下载采用整包重试。生产容量、Linux/macOS 资格验证、备份恢复和真实合作组发布仍属于发行验收工作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
