---
kind: package-reference
description: "管理本地 Skill 版本与可选云端发布，不改变账号设置。"
---

# Skill 市场界面

[English](README.md) | 中文

## 概述

浏览发行包、管理完整的本地 Skill 包、制作单个来源 Skill，并显式选择新聊天的默认版本。云端草稿与审核使用配置的账号网关。本插件独立于账号设置，卸载后仍保留登录、反馈和首次使用引导。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在具名 `dsh` profile 中将本包与本地发行包及激活服务一起挂载。Desktop 已提供这些行及可选云端客户端。侧栏导航打开全局面板；设置入口链接到同一面板。所有操作均使用生成的本地、激活与云端 Remote。界面提供中文、英语、日语、西班牙语、法语、德语、俄语和葡萄牙语文案。

选择 ZIP 后立即将其导入为停用状态的本地版本。制作单个来源时保留完整资源与元数据。安装云端版本先核验所选摘要，再导入。通过单独确认，使用此前观察到的归档 SHA 选择默认值；冲突时重新读取当前默认值，并要求重新选择。默认值用于新聊天及首次任务前的空聊天。已执行聊天保留已记录版本；旧有已执行聊天不会补入市场绑定。移除被引用版本时会明确拒绝，并保留其列表项。

没有云端连接或未登录时，仍可本地导入、导出、制作和管理默认值。云端搜索有数量上限，不代表完整目录。刷新会验证当前账号能力；断线或账号变化会撤销私有操作权限。旧搜索及私有响应无法覆盖较新的视图或账号代次。请求失败时，已有可用的本地内容仍保持可见。

上传尝试的原账号 id、请求 key、归档与发布团队会跨面板重挂保留。上传只创建私有草稿。重新登录原账号后可用原 key 重试；其他账号不能复用该尝试。切换选择或制作另一包不会悄悄丢弃未确认尝试。单独的放弃确认会说明服务端可能已存在草稿。提交与审核使用所展示的原发行修订号。审核未确认时读取原 id，不会重新提交更新的修订。

卸载会移除面板、导航、字典、反馈叠层与 Remote 注册。Toast 结果可跨面板导航显示；插件卸载后会抑制晚到结果。[发行包组件](../../host/muse-market/README.zh.md)负责归档校验、存储、激活和云端权限。

<a id="understand-the-implementation"></a>
## 理解实现

[Remote 适配器](src/client/market-remote.ts)保留全部十五个操作结果及结构化错误。[控制器](src/client/market-controller.ts)负责私有请求代次。renderer 拥有所注册的创作者草稿 store；其中仅保存用户选择和原重试身份，不代替安装或云端账本。组件使用框架 hook、派生 slot props，以及现有 Button、Modal 与 Toast 原语。

<a id="further-exploration"></a>
## 进一步阅读

- [账号界面](../ui-muse-account/README.zh.md)——登录及账号状态。
- [云端身份迁移](../../../docs/upgrade-guide/v0.2.2-rc.1/skill-market-identity/guide.zh.md)——配套账号 DTO 与浏览器解析入口。

<a id="model-experience"></a>
## 模型体验

### 显式发行选择

#### 模型看到的内容

面板导航和云端浏览不添加模型消息。`museMarketActivation` 服务与现有 Skill 消费者通过已记录的 Session 绑定及普通 Skill 加载暴露所选版本。

#### Token 影响

UI 状态不消耗模型 token。加载所选 Skill 保持已有目录与指令的 token 行为。

#### KV 缓存影响

导航不改变请求前缀。默认值变化影响符合条件的未绑定聊天；已执行聊天保持原有绑定。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 云端操作需要匹配且已配置的服务端。本界面不会部署服务端、自动发布，或更改已执行聊天的版本绑定。全局面板不声称展示某个所选 Session 的绑定。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
