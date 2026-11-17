---
description: "按集数选择已记录视频，在可停靠预览中查看原始画面片段，并在同一会话请求 Agent 建议或修改。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-video

[English](README.md) | 中文

## 概述

在一个会话内完成一部剧，同时选择集数、视频和原始画面片段。在右侧 Sidebar 或浮动面板预览所选视频，不切换会话或草稿。跨集选择视频、请求 Agent 审阅，再通过普通聊天描述修改。建议链接返回精确的已记录来源范围；仅选择媒体不会修改或重新生成。

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

此包拥有可选的 Muse 视频工作区。在**设置 → 通用 → Muse 视频工作区**中，可随时启用或停用，无需重启或刷新页面。开关通过原生配置表单保存到配置档案。停用会释放本展示的注册和预览媒体，保留会话、草稿、附件、已记录文件和运行中的 Agent 任务。再次启用会创建全新的展示作用域，不重复注册控件。只要安装了此包，设置行就会保留。

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

会话入口和已记录视频卡片打开同一个视频工作区。原生右侧 Sidebar 拥有停靠、浮动、调整尺寸与标签导航；这些操作保留同一会话、播放选择和输入框。视频工作区不为每一集创建新 Session。

预览使用导航与控制区之外的面板剩余高度。横屏和竖屏媒体都按可用宽高等比显示，不裁切、不拉伸。调整面板大小或切换浮窗会保留播放。较矮的面板在内部滚动，保留可用预览和控制入口。

视频选择器按显示集号筛选已记录清单。只有结构化制作事实决定集数归属；没有已核实显示集号的来源保留在**未分集**中。切换筛选不会清除跨集选择。媒体缺失、清单不完整或检测失败时保留明确状态与重试控件。失败的分析不提供虚构画面片段。

**带入对话**把当前视频或选中的时间轴片段加入同一个输入框。**整个视频**清除预览的片段范围，不改变播放位置和已有输入框引用。选择器也支持跨集勾选整个视频。每项选择保留来源标识、版本和原始时间范围。FFmpeg 检测的画面片段独立于创作分镜号和视频包序号。时间轴缩放调整水平比例，同时保留原始媒体时间和片段范围。

按下选择针时保留其当前位置。拖拽根据轨道在屏幕上的实际边界映射时间，并保留初始抓取位置与针中心的偏移，可适配不同的页面缩放比例。

**让 Muse 看看**使用已有的所选引用；没有引用时，直接加入当前视频或选中的片段。它请求限定范围的只读审阅，给出最多三条问题和可执行建议，每条链接到提供的画面定位。输入框为空且没有附件时可直接提交，已有未完成输入则保留。结构化引用将 `muse_video` 标为审阅工具，Host 限制其所选区间；提示本身不授予修改或生成权限。

创作镜头按钮使用版本绑定的实测 `shotRanges`，与检测切镜相互独立。没有实测时间的镜头保持禁用并说明原因。选择创作镜头会跳到其真实区间，并将镜号放入普通对话引用。

所选视频引用可以在同一个输入框中伴随自然语言修改要求。引用序列化在提交来源证据前核对最新清单；来源变化或不可用时拒绝提交，保留草稿供重新选择。**准备修改要求**追加可编辑的修改请求，不发送。修改与重新生成请求指导 Agent 保留原版和未涉及的内容。仅选择媒体不授权其中任何操作。

Agent 建议链接重新打开同一个工作区，定位已记录的来源版本和原始范围。过期链接提示需要刷新选择，不静默指向另一个版本。已交付视频以紧凑入口打开右侧预览；原生文件预览和打开操作仍由 Deliverables 拥有。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部结构——点击展开</summary>

设置控制器用串行化的 Cordis 子作用域拥有可选贡献。原生会话标题区的视频工具按钮独立于协调器打开工作区。会话视频 Host 服务保持独立，供其他消费者使用。停用工作区后停止其清单观察和画面分析；输入引用编解码器保持注册，已有视频引用仍可通过普通聊天发送，仅在用户提交这些引用时读取当前清单。

插件挂载生成的 `sessionVideo` Remote 贡献，并注册原生右侧 Sidebar 标签页。资源提供者保留所属 Session，从已记录变化刷新清单，并取消已释放读取。会话作用域的视图 store 在展示切换时保留浏览和来源局部选择。输入框引用使用既有输入触发器 codec 和普通消息提交，插件不拥有第二套消息流程。卸载播放器会释放媒体，可选缩略图失败仍保留播放。

选区证据使用本插件拥有的 `<muse-video-selection>` 文本标记。工作区启用时，其用户文本规则只接受本插件的严格字段集与一致的来源链接，再于已发送消息和队列预览中绘制紧凑视频标签。任意 JSON、格式错误的标记和不支持的字段保持普通文本。只有所属会话中的可交互标签才能导航；渲染不改写已记录或模型可见的消息。

| 源文件 | 职责 |
|---|---|
| [config.ts](src/config.ts) | Host 校验的公开启动比例 |
| [client/index.ts](src/client/index.ts) | Remote 与原生 Slot 注册 |
| [VideoWorkspace.tsx](src/client/VideoWorkspace.tsx) | 分集筛选、多选、预览和审阅请求 |
| [VideoPlayer.tsx](src/client/VideoPlayer.tsx) | 真实播放、画帧采集与媒体清理 |
| [VideoTimeline.tsx](src/client/VideoTimeline.tsx) | 受控时间映射、选择针与按需边缘渐隐 |
| [target-selection.ts](src/client/target-selection.ts) | 绑定版本的选择、来源证据和建议链接坐标 |
| [references.ts](src/client/references.ts) | 输入框引用与提交时的来源校验 |
| [user-text-rules.ts](src/client/user-text-rules.ts) | 自有标记的严格匹配与紧凑用户文本节点 |
| [VideoSelectionText.tsx](src/client/VideoSelectionText.tsx) | 原生行内视频标签与同会话导航 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [会话视频服务](../../drama/session-video/README.zh.md)——已记录来源访问与有界视觉检测。
- [Chat](../ui-chat/README.zh.md#message-bubbles)——原生聊天记录与固定区贡献。
- [Deliverables](../ui-deliverables/README.zh.md#explicit-deliveries)——已声明文件与原生操作。

<a id="model-experience"></a>
## 模型体验

### 视频审阅与修改

#### 模型看到的内容

已提交的用户消息包含审阅或修改要求，以及带标记的结构化来源证据：来源标识和版本、本地路径或已记录提供者 URL、事件坐标、可选的制作元数据与创作镜号、原始片段范围、审阅工具及 `review_link`。引用在普通输入框中仍可编辑，模型接收完整的已记录证据。清单、播放、分集筛选和视觉切镜检测不增加模型输入。

#### Token 影响

只有已提交的审阅或修改消息增加请求 token。只读 Agent 审阅可以消耗模型 token。浏览、选择媒体和准备未发送草稿不发起模型或生成请求。

#### KV 缓存影响

播放和检测保留已有请求前缀。之后的用户提交延长普通会话历史；所选供应商拥有其缓存行为。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

这些限制区分检查与媒体制作。

- **视觉切镜范围**——检测不推断剧情场景、对白、人物连续性或创作分镜号。它引用原视频范围，不创建独立片段文件；所请求的 Agent 审阅拥有内容观察及其不确定性。
- **已记录的受支持来源**——省略或不可用的来源遵循服务的清单诊断。粘贴任意 URL 不代表已获授权的来源。
- **明确生成**——选择媒体和请求建议不授权生成或支出。修改与重新生成仅通过已提交的用户请求及现有 Agent 工具执行。
- **浏览器媒体支持**——预览需要兼容解码器。远端来源缺少可用的跨源媒体权限时，画帧采集可能失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
