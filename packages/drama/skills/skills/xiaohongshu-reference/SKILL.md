---
name: xiaohongshu-reference
description: Use when 需要通过本地 xpzouying/xiaohongshu-mcp 只读检索小红书高赞图文参考、读取详情、下载公开参考图并保存可审核清单，尤其用于仿真人角色服装、妆发和抽象五官审美参考。
---

# 小红书只读参考检索

本 skill 是独立的平台检索能力。它负责安装、启动、登录检查、公开笔记检索、详情读取、参考图下载和安全落盘；不负责决定短剧角色重要性，也不负责写剧变提示词或生成图片。

## 只读边界

包装器只允许 `check_login_status`、`search_feeds` 和 `get_feed_detail`。禁止发布、编辑、删除、评论、回复、点赞、收藏及取消操作。即使上游 MCP 暴露这些工具，也不得绕过包装器调用。

运行时可执行文件、Cookie 和登录态位于 `XIAOHONGSHU_RUNTIME` 指定目录，默认 `${DSH_HOME:-~/.dsh}/xiaohongshu-runtime`，不写入技能安装目录。项目产物不得保存 Cookie、`xsec_token`、MCP session ID、请求头、Authorization 或登录二维码。可保存公开笔记 ID、来源链接、公开作者名、发布时间、互动数、图片 URL、本地路径、查询条件和审核状态。

## 使用流程

以下命令从本技能实际目录运行；需要 Windows amd64、PowerShell 和 Python 3.11+。

1. 完整阅读 [使用契约](references/usage-contract.md)。
2. 运行 `scripts/start_xiaohongshu_mcp.ps1`。脚本会校验固定版本；首次运行可能下载约 140–190 MB 的内置浏览器，默认最多等待 20 分钟。
3. 运行 `python -B scripts/xhs_reference_search.py status`。
4. 返回 `login_required` 时，运行 `scripts/start_xiaohongshu_mcp.ps1 -Login`，由用户在可见窗口扫码；不得代替用户处理凭据。
5. 用调用方提供的主体 ID、标签和 2–3 个查询执行 `search`。默认筛选“最多点赞、图文、半年内”。
6. 下载 3–6 个互补候选，写入调用方项目的 `asset_style_references.json`，初始状态只能是 `pending_review`。
7. 由调用方 Agent 审核并决定采用/淘汰。本 skill 不得自行把 `style_reference_status` 改成 `approved`。

搜索结果为空、未登录、超时或下载失败时必须返回真实状态，不得伪造候选，也不得切换到发布类接口。

## 上游源码

运行时固定使用 `xpzouying/xiaohongshu-mcp` v2.2.6 发布包，并按清单校验文件大小和 SHA-256。仓库根目录用户准备的 `xiaohongshu-mcp-main/` 仅作为上游源码审计和将来构建备用，不是运行时硬依赖，也不复制进本 skill。

上游采用 Apache-2.0，许可证副本见 [LICENSE.xiaohongshu-mcp.txt](references/LICENSE.xiaohongshu-mcp.txt)。
