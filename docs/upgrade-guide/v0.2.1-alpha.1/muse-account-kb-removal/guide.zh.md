---
kind: upgrade-guide
description: "Muse 账号启用时不再启动内置知识库 MCP 服务或注册其工具。"
---

# 移除 Muse 账号内置知识库 MCP

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-muse-account` 不再启动 `muse-account` MCP 子进程。新的工具发现不再包含 `mcp__muse-account__*` 命名空间，包括账号状态与 `muse_kb_*` 操作。本包同时移除 `src/kb.ts`、`src/mcp-server.ts` 模块及其生成入口。

账号登录、账号授权模型、模型直连、语音转写、意见反馈、网页搜索和桌面远程访问保留其账号接口。用户自行配置的 MCP 服务仍独立配置。此次桌面端变更不删除或迁移云端 vault、文档或本地会话历史，也不部署网关变更。

## 迁移

1. 使用更新后的账号包重启 Host。若自定义 `cordis.yml` 或补丁行手动启动本包原有的 `lib/types/mcp-server.js` 入口，请移除该行；更新后的包不再提供这个程序。
2. 移除依赖 `mcp__muse-account__*` 工具的指令与工作流。账号状态可通过**设置 → MUSE 账号**或既有的 `museAccount.status` Remote 方法读取。工作流需要外部知识服务时，通过 [MCP 客户端](../../../../packages/mcp/mcp-client/README.zh.md)配置该服务支持的独立服务端，并使用其授权方式。
3. 确认账号登录与模型选择器仍可使用，且新的工具发现不包含 `mcp__muse-account__*` 名称。另行确认用户自配的 MCP 工具仍可使用。现有云端数据继续遵循其原有访问规则；此次迁移不需要删除数据。
