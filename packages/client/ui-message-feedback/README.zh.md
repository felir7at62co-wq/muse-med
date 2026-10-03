---
description: "Web 反馈界面：已定稿助手消息动作行中的 Like/Dislike 对、两种评分与 `/feedback` 共用的反馈弹窗，以及确认和失败 toast；供反馈体验的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-message-feedback

[English](README.md) | 中文

## 概述

通过同一个弹窗反馈已完成的回答或当前任务。用户可以选择分类并填写描述；提交失败会保留草稿。Muse 桌面端将两类反馈提交到登录账号的 Muse 意见箱，并提供可选的有限对话诊断信息。其他部署使用本地 Session 反馈及所配置的日志投递。评分和备注不进入模型上下文。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

与 `ui-conversation`、`ui-commands` 一起挂载本插件；Like/Dislike 对出现在每个已完成回答的动作行中，位于复制与分支之间。输入框的「反馈」动作，以及挂载 `session-log-export` 后的会话标题栏「反馈」动作，都打开同一个弹窗。七个分类与描述均可不填。已记录的评分不需要悬停也一直可见；再次点击会撤回本地评分。不带文本的 `/feedback` 打开 Session 弹窗；`/feedback <text>` 保留独立的宿主命令路径。

在 Muse 桌面端，提交会将草稿、分类和任务或消息标识发送到 Muse 意见箱。诊断选项默认不勾选，只有勾选后才附带最近请求与相关回答的有限摘录，不附完整日志、工具参数与结果、思考内容或附件。服务端确认回执后才显示「已提交到 Muse 意见箱」；本地日志仅保留回执标记和分类。撤回本地评分不会删除已经提交的意见箱记录。

### 失败

评分或列表加载失败在行内展示；提交失败显示警告 toast 并保留草稿。Muse 需要投递提供方及当前账号，不会把本地记录当作入箱成功。发送结果不明或账号切换时，会提示用户先检查原账号意见箱，再决定是否重试。云端回执已确认后，本地标记保存失败不改变提交成功。只有已定稿的消息进入消息条目；被中断的部分输出没有 `messageId` 或反馈控件。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包贡献 `conversation.chat.assistant-actions` 的 `feedback` 条目（order 10），由 ui-conversation 声明并渲染在已定稿助手消息的 IconActions 行内；同时贡献 `conversation.input.overlay` 的 `feedback-dialog` 条目（order 2），它通过 body portal 渲染 Modal 与 Toast 基元，并让 toast 以其所在的输入框卡片为中心。`feedbackUi.openSession(sessionId)` Client 服务打开同一个 Session 级弹窗，不记录反馈；标题栏菜单和命令装饰共用此方法。`/feedback` 装饰是经 `ctx.commandUi.decorate` 注册的 `action`，因此菜单选中或不带参数的回车会消费触发 token 并打开弹窗，而带参数的命令行仍到达宿主命令。

每个 Session 的消息控制器按需加载评分，并根据观察到的版本串行修改本地记录。一个弹窗控制器拥有草稿和确认提示；新草稿重置诊断选项，迟到的结果不会关闭更新的草稿，释放时停止在途确认提示。可选的 `feedbackDelivery` 提供方先将所选目标提交到账号意见箱，再记录本地回执标记。没有该提供方时，其他产品使用 `messageFeedback.put` 或 `sessionFeedback.record`，Muse 则报告暂不可用。[Muse 账号提供方](../../host/muse-account/README.zh.md)负责鉴权投递与诊断过滤。

投递服务公开 Client 自有的目标与内容类型。分类键共用弹窗的展示列表，并按持久化反馈分类表进行编译检查。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当反馈界面不够用时阅读以下页面。它们从浏览器条带进入 Session 日志后端与会话外壳。

- [dsh-message-feedback](../../feedback/message-feedback/README.zh.md)——拥有按条目比较并交换与持久化的 Session 日志后端。
- [dsh-command-feedback](../../feedback/command-feedback/README.zh.md)——`/feedback` 命令、`sessionFeedback` Remote 与分类表。
- [ui-commands](../ui-commands/README.zh.md)——`/feedback` 行所经过的命令装饰约定。
- [ui-conversation](../ui-conversation/README.zh.md)——声明助手动作条与输入框浮层。
- [客户端包映射](../README.zh.md)——相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

无。评分、分类与备注是仅写日志的事件，不是模型输入。可选的 Session 日志投递使用请求元数据，而非模型上下文。

#### KV Cache 影响

无；反馈变更不改变模型可见的历史。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前反馈界面。它们是当前包约束，不是通用评分对比或任务积压。

- **备注大小是宿主策略**——部署方配置 `maxNoteBytes`（Web bundle 中为 8192），超长备注由宿主以 `note-too-large` 拒绝。弹窗不预先校验该上限，因此针对消息的超长描述在提交时才失败，而不是在输入过程中；Session 级备注没有上限。
- **无跨标签页推送**——另一个标签页的评分要等到重连或下一次冲突响应才可见，不会立即出现；控制器不消费反馈日志事件。
- **仅限对话视图**——trajectory 与 waterfall 视图不渲染反馈控件，尽管它们的助手节点也带有相同的 `messageId`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
