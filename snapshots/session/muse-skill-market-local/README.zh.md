---
description: "无需密钥的 Native 验证，覆盖本地 Skill 发布、归档往返及停用的安装记录。"
kind: "reference"
---

# 本地 Skill 发布生命周期

[English](README.md) | 中文

已发布的 Headless 配置通过常规 Loader 加载生产 Muse Market 服务和私有文件系统 Skill。八次 Native 调用依次发现来源、准备并导出发布包、拒绝损坏的导入、再次导入原始归档、查看停用的安装记录、移除记录，再查看空安装列表。夹具工具转发全部六个服务方法，将 void 返回值编码为 JSON null，并在工具失败中保留 RemoteError 的每个公开字段。每个完整的实际结果都进入下一次模型请求。

工作区凭据检查原始 SKILL.md 前言及每个参考文档、脚本和二进制资源的字节、归档 SHA 往返，以及重复安装的标识和停用状态。拒绝损坏的导入后，全部已存储文件保持不变；移除记录会保留归档，来源 Skill 也保持不变。此场景仅在本地发布，不启用或执行 Skill，也不访问云服务。

[PTC 对应场景](../muse-skill-market-local-ptc/README.zh.md)通过实际程序化工具分派执行相同生命周期。
