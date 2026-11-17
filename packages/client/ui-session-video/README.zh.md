---
description: "回看 Muse 会话中记录的视频，检查视觉切镜范围，并准备明确的镜头修改草稿。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-video

[English](README.md) | 中文

## 概述

在聊天卡片中直接查看已记录视频，使用来源选择器、与原视频绑定的视觉切镜范围，以及鼠标或键盘定位。紧凑的顶栏菜单以同款卡片展示历史视频。每张卡片保留独立的来源选择。准备镜头修改时仅追加可审阅的草稿，仍由用户通过普通聊天提交。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

独立的 [Muse 视频插件包](../../bundle/muse-video-ui/README.zh.md)将此界面及其媒体服务一起安装。

视频控件、状态信息和镜头修改草稿遵循应用当前语言，完整注册中文、英语、日语、西班牙语、法语、德语、俄语和葡萄牙语词典。

此包拥有可选的聊天视频卡片和会话视频历史。在**设置 → 通用 → 视频卡片与轨道**中，可随时启用或停用，无需重启或刷新页面。开关通过原生配置表单保存到配置档案。停用会移除增强播放器和历史入口，恢复原生已交付视频播放，并暂停、释放预览媒体。聊天记录的组件身份、输入草稿、附件、已录制文件和运行中的 Agent 任务仍由 Muse 拥有。再次启用会创建全新的界面作用域，不重复注册控件。只要安装了此包，设置行就会保留。

Muse Desktop 组合挂载此 UI 和[会话视频服务](../../drama/session-video/README.zh.md)。普通 Web profile 默认不启用这两个包。自定义组合保留用于实时设置的规范条目 ID `ui-session-video`，并需要同时挂载这两行，以及原生 Chat、Deliverables、语言、渲染器和 Remote 服务。

```yaml
- insert:
    - id: session-video
      name: '@deepseek-ai/dsh-session-video'
    - id: ui-session-video
      name: '@deepseek-ai/dsh-client-ui-session-video'
      config:
        pixelsPerSecond: 48
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 整套会话界面的实时开关，也可在通用设置中修改 |
| `pixelsPerSecond` | `48` | 正数时间轴比例；一秒占用此处指定的水平像素数 |

Host 校验此不含秘密的展示策略，并将其写入页面启动数据。新页面在注册界面前读取已解析值；已接受的实时设置会取代启动开关。`enabled` 是 volatile 字段，即使关闭配置 HMR，也只切换界面注册。它与会话视频服务拥有的媒体处理限制分开。

普通会话顶栏提供紧凑的**会话视频**菜单，已记录来源按最新优先排列。选中来源后，在聊天顶部以正常文档流展示同款可编辑视频卡片，也支持原消息尚未加载的历史视频。关闭此卡即可回到聊天记录。界面不再提供悬浮 Muse 气泡、浮层播放器或专用占位。

会话控制器独立于菜单和卡片读取清单。可见卡片请求分析所选的带版本来源，并共用一个会话级分析队列；仅打开菜单不会分析所有视频。媒体缺失、清单不完整或检测失败时保留状态与重试控件。失败的分析不提供虚构镜头。组合时间轴保留每个来源的原始局部时间范围；选中镜头会打开其来源并定位至该范围。

每张卡片分别保留视频选择、选中镜头、播放位置和时间轴比例。播放和缩放控件保留原媒体时间及镜头范围。已交付视频、已生成视频和选中的历史视频共用同一卡片组件。

按下选择针时保留其当前位置。拖拽根据轨道在屏幕上的实际边界映射时间，并保留初始抓取位置与针中心的偏移，可适配不同的页面缩放比例。

每张视频卡片提供修改入口。未选择轨道镜头时按钮禁用，悬停提示会说明要求；选中后，修改操作向已有输入草稿追加来源、镜头身份和原始时间范围。它既不发送草稿，也不替换视频。已交付视频贡献仅替换播放正文；原生文件预览和打开操作仍由 Deliverables 拥有。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部结构——点击展开</summary>

设置控制器用串行化的 Cordis 子作用域拥有全部可选贡献，保留原生会话顶栏展示方式。会话视频 Host 服务保持独立，供其他消费者使用；停用此界面后不再发起视频清单或镜头分析请求。

插件挂载生成的 `sessionVideo` Remote 贡献，在 `conversation.session.header.utilities` 中挂载会话控制器与菜单，在 `conversation.chat.pinned` 中展示历史视频卡，并贡献至原生交付视频链和轮次收尾位置。查询使用调用者取消信号。每张可见的行内卡独立选择其原始来源，也可切换到同一会话中记录的其他来源。卡片离屏后释放分析需求、暂停播放并停止提取缩略图；已记录的分析结果仍可用于共享时间轴。尚未匹配到来源的交付保留其原有的授权播放地址。修改切镜需要本地版本绑定的播放来源；如果来源解析完成前用户已经播放或拖动，切换至绑定版本需要用户操作，此前保持现有播放。卡片在两种页面主题下共用深色材质与亮色文字。

| 源文件 | 职责 |
|---|---|
| [config.ts](src/config.ts) | Host 校验的公开启动比例 |
| [client/index.ts](src/client/index.ts) | Remote 与原生 Slot 注册 |
| [VideoController.tsx](src/client/VideoController.tsx) | 会话清单与可见来源分析 |
| [VideoHistory.tsx](src/client/VideoHistory.tsx) | 会话菜单与历史视频卡片 |
| [VideoPlayer.tsx](src/client/VideoPlayer.tsx) | 真实播放、画帧采集与媒体清理 |
| [VideoTimeline.tsx](src/client/VideoTimeline.tsx) | 受控时间映射、选择针与按需边缘渐隐 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [会话视频服务](../../drama/session-video/README.zh.md)——已记录来源访问与有界视觉检测。
- [Chat](../ui-chat/README.zh.md#message-bubbles)——原生聊天记录与固定区贡献。
- [Deliverables](../ui-deliverables/README.zh.md#explicit-deliveries)——已声明文件与原生操作。

<a id="model-experience"></a>
## 模型体验

### 镜头修改草稿

#### 模型看到的内容

UI 在普通输入草稿中准备来源身份、镜头身份、来源局部时间范围和可编辑的修改要求。英文草稿将这些字段标为 `Source`、`shot ID` 和 `original range`。它们仅在用户提交草稿后到达模型。清单、播放、滚动和切镜检测不增加模型输入。

#### Token 影响

只有用户提交的草稿增加请求 token。浏览和准备草稿不发起模型或生成请求。

#### KV 缓存影响

播放和检测保留已有请求前缀。之后的用户提交延长普通会话历史；所选供应商拥有其缓存行为。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

这些限制区分检查与媒体制作。

- **视觉切镜范围**——UI 不推断剧情场景、对白或人物连续性。它引用原视频范围，不创建独立片段文件。
- **已记录的受支持来源**——省略或不可用的来源遵循服务的清单诊断。粘贴任意 URL 不代表已获授权的来源。
- **明确生成**——修改草稿需要用户提交并进入已有 agent 工作流；仅选择镜头不会授权生成或支出。
- **浏览器媒体支持**——预览需要兼容解码器。远端来源缺少可用的跨源媒体权限时，画帧采集可能失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
