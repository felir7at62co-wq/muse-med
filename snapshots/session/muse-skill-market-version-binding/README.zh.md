---
description: "无需密钥的 Native 验证：已执行的会话保留 Skill 发布版本，首次执行的会话选择当前默认版本。"
kind: "reference"
---

# 每个会话的 Skill 发布版本选择

[English](README.md) | 中文

已发布的 Headless 配置加载生产本地发布和激活服务。同一个 Skill 的两个完整发布包具有不同的指令和参考资源。主 Agent 加载版本一后，通过显式比较并设置操作将默认值改为版本二，随后真实的 Skill 加载仍保留版本一。在更改前创建的空白 Agent 于更改后首次执行时使用版本二；新建 Agent 也使用版本二。两个子 Agent 均通过真实的 Agent 注册表、循环、Skill 工具和录制模型适配器运行。

每个完整的 Skill 结果都会在随后的模型请求中检查。夹具对三个会话逐一比对必读的 muse-market/bound 事件、会话投影、提供器元数据、精确的归档 SHA 和所选参考资源字节。工作区凭据记录这些检查，完整的生命周期工具结果进入主 Agent 的下一次请求。缺失缓存和历史读取器的拒绝矩阵仍由包测试负责。此场景不请求供应商，也不执行资源。

[PTC 对应场景](../muse-skill-market-version-binding-ptc/README.zh.md)通过实际程序化工具分派执行相同的三会话生命周期。
