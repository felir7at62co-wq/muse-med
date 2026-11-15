---
description: "无需密钥的 native 视频任务查询与原 key 回读。"
kind: "reference"
---

# 通过 Native 工具查询视频任务

[English](README.md) | 中文

随附的 Headless profile 和 Loader 通过 Native 执行器运行生产 Jubian 工具。共享[离线 fixture](../muse-video-task-discovery-native/task-discovery-fixture.mjs)返回空的按类型筛选列表、空的未筛选提供方列表，以及可回读的已知任务。四次真实日志结果进入后续模型请求；原账本文件字节保持不变，所有提供方请求均为 GET。

`project_complete` 仅覆盖本次响应中提供方的未筛选列表，不能证明历史任务不存在，也不授权重新生成。`workspace.expected/task-discovery-proof.json` 记录已核实的请求、已知任务、原 key 和零计费写入。模型响应是受控的回放输入。`writerOutput: true` 独立保留规范输入与当前 writer 输出。
