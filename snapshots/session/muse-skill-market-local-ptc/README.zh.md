---
description: "无需密钥的 PTC 验证，覆盖本地 Skill 发布及完整工具错误后的继续执行。"
kind: "reference"
---

# 通过 PTC 发布本地 Skill

[English](README.md) | 中文

已发布的 Headless PTC 配置通过八次实际 tools.market_local 分派运行 [Native 生命周期](../muse-skill-market-local/README.zh.md)。每个成功程序输出完整的服务结果。损坏导入程序捕获实际 ToolCallError，并输出其完整公开字段 name、toolName 和 message；message 保留真实服务失败中 RemoteError 的每个公开字段。日志中的嵌套分派仍为错误，后续程序继续使用原始归档。

夹具在每次后续模型请求中观察完整的已记录程序输出，并统计八次分派开始及结束。独立工作区凭据与 Native 场景一样，检查原始资源字节、归档 SHA 往返、停用的安装标识、拒绝导入后存储不变及记录移除。不需要错误堆栈归一化或云服务。
