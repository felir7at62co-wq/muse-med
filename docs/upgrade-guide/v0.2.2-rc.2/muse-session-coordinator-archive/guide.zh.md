---
kind: upgrade-guide
description: "Muse Desktop 配置不再挂载 Session 协调插件，主会话停止调度，`coordinator_*` 工具不再提供。"
---

# Muse Session 协调插件归档

[English](guide.md) | 中文

## 变更

Muse Desktop 配置此前挂载 `@deepseek-ai/dsh-session-coordinator`、它的执行端与 Client 条目以及 `@deepseek-ai/dsh-session-activity`，启动时打开主会话，并在新建对话时提供 `main-session`。主会话用 `coordinator_*` 工具搜索会话并派发工作，被派发的会话用 `coordinator_report` 回报。

现在配置不再挂载这些条目。启动时不打开主会话，`main-session` 不可选择，`coordinator_*` 工具不再注册，短剧提示词也不再要求对话向主会话回报。`main-session` 预设只为重新打开既有主会话而保留：它不含调度角色和工具，对话能显示历史，但不派发任何工作。主会话派发过的会话仍是普通短剧对话。会话日志和 `muse_coordination` 存储域既不修改也不删除。协调插件的包保留在仓库中，自定义组合仍可挂载它们。

受影响的是通过主会话派发工作的用户，以及在 Desktop 配置中调用 `coordinator_*` 工具的自动化流程。

## 迁移

1. 升级前，完成或记下主会话中仍未结束的任务。升级后主会话不再跟踪或核对它们。
2. 升级后，新工作交给 Bot，或在“Muse 会话”下的普通对话中进行。之前的工作在原来执行它的会话里继续；该会话和其他对话一样列在所属工作间中。
3. 如果配置补丁在 `selectablePresets` 或默认预设中写了 `main-session`，将其移除。
4. 仍需要调度的自定义组合自行插入协调插件条目，做法见 [Web 测试 overlay](../../../../apps/web/tests/muse-session-coordinator.overlay.yml)。
5. 确认结果：应用启动时不打开主会话，既有主会话能打开并显示历史，新对话的工具列表中没有 `coordinator_*` 名称。
