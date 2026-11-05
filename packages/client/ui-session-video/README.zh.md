---
description: "回看 Muse 会话中记录的视频，检查视觉切镜范围，并准备明确的镜头修改草稿。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-video

[English](README.md) | 中文

## 概述

通过紧凑的蜘蛛入口和一个可展开播放器回看当前会话记录的视频。时间轴显示绑定来源的视觉切镜范围，支持指针与键盘定位。已交付和受支持的生成视频保留行内播放，并可随聊天记录滚动收纳至入口。准备镜头修改会追加一份可核对的草稿；仍由用户通过普通聊天提交。

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

Muse Desktop 组合挂载此 UI 和[会话视频服务](../../drama/session-video/README.zh.md)。普通 Web profile 默认不启用这两个包。自定义组合需要同时挂载这两行，以及原生 Chat、Deliverables、语言、渲染器和 Remote 服务。

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
| `pixelsPerSecond` | `48` | 正数时间轴比例；一秒占用此处指定的水平像素数 |

Host 校验此不含秘密的展示策略，并将其写入页面启动数据。新页面在注册界面前读取已解析值。它与会话视频服务拥有的媒体处理限制分开。

幕布只为紧凑顶行预留固定占位，展开内容以浮层覆盖正文，不推动消息或输入框。展开与收起使用相同的 900 毫秒缓动，收起内容仅保留到退出动画结束。减少动态效果偏好会移除此过渡。

打开蜘蛛入口会显示已记录的清单，并分析可用且带版本的来源。媒体缺失、清单不完整或检测失败时保留明确状态与重试控件。失败的分析不提供虚构镜头。组合时间轴保留每个来源的原始局部时间范围；选中镜头会打开其来源并定位至该范围。

视频名选择器直接与蜘蛛顶行对齐，不带填充胶囊底色，并随幕布渐隐；它保留来源切换，画面上不重复显示文件名。居中的播放按钮与右对齐的缩放控件位于画面和时间轴刻度之间，上下留白相等。时间轴缩放调整水平比例，同时保留原始媒体时间和镜头范围。

按下选择针时保留其当前位置。拖拽根据轨道在屏幕上的实际边界映射时间，并保留初始抓取位置与针中心的偏移，可适配不同的页面缩放比例。

视频可用时，修改入口在展开的蜘蛛顶行右侧保持可见，没有填充底色或阴影。未选择轨道镜头时按钮禁用，悬停会提示先选镜头；选中后，修改操作向已有输入草稿追加来源、镜头身份和原始时间范围。它既不发送草稿，也不替换视频。已交付视频贡献仅替换播放正文；原生文件预览和打开操作仍由 Deliverables 拥有。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部结构——点击展开</summary>

插件挂载生成的 `sessionVideo` Remote 贡献，注册会话作用域的 `conversation.content.overlay` 幕布和固定的 `conversation.chat.pinned` 占位，并贡献至原生交付视频链和轮次收尾位置。幕布仅在对话视图激活时挂载，展开层位于聊天记录的弹出浮层之上。查询使用调用者取消信号；收起时暂停保留的播放，卸载播放器时释放媒体来源。收纳预览仍位于原 Chat 框架内，仅在该框架所属的会话容器中查找接收入口。它保留原行内卡片的布局占位，并尊重减少动态效果偏好。收纳时会一同隐藏外层原生交付面板；逆向滚动或卸载清理会恢复其原有可见性、inert 状态与 ARIA 属性。蜘蛛控件、展开播放器和行内视频卡片在两种页面主题下共用深色材质与亮色文字。

| 源文件 | 职责 |
|---|---|
| [config.ts](src/config.ts) | Host 校验的公开启动比例 |
| [client/index.ts](src/client/index.ts) | Remote 与原生 Slot 注册 |
| [VideoShelf.tsx](src/client/VideoShelf.tsx) | 清单、来源选择与修改草稿 |
| [VideoPlayer.tsx](src/client/VideoPlayer.tsx) | 真实播放、画帧采集与媒体清理 |
| [VideoTimeline.tsx](src/client/VideoTimeline.tsx) | 受控时间映射、选择针与按需边缘渐隐 |
| [useAbsorption.tsx](src/client/useAbsorption.tsx) | 随滚动变化的收纳预览 |

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
