---
kind: upgrade-guide
description: "Muse 移除内置 Bot 界面，新工作使用普通会话，并保留历史数据。"
---

# Muse 使用普通会话

[English](guide.md) | 中文

## 变更

Muse Desktop 不再加载内置 `ds-bot` 界面、团队服务或手机控制入口。新会话使用 `short-drama`。`bot-coordinator` 预设仅为恢复已有会话保留通用工具，不可用于新建会话，也不恢复 Bot 团队或自动编排。

产品不再提供 Bot 名册和群组管理、跨 Bot 消息、`show_view`、`ask_user`、`read_browser`、密钥卡片、Bot 记忆与保存的 Bot 能力。原生会话历史、`ask_user_question`、`present`、凭据设置、网页搜索、后台 Jobs、子代理和数据采集／下载工具继续可用。普通 Web 会话继续受支持；归档的 Bot 手机控制界面没有替换为新的手机入口。

会话日志、工作文件、模型选择和 Bot 状态不会被删除或转换。保留这些文件不会重新启用归档界面，也不会把 Bot 记忆导入普通会话。

## 迁移

1. 升级前结束正在执行的工作。保留原有应用 home、Electron userData、会话日志、Bot 状态与源码归档。无需重写凭据、工作间或历史会话。
2. Desktop 准备 profile 时移除内置 Bot bundle，并停用其旧 profile 配置项。原 package 元数据备份为 `package.json.<UTCstamp>-<UUID>.bak`；受影响的 profile 补丁逐字节备份为 `cordis.patch.yml.bot-retired-<UUID>.bak`。将这些备份与未改动的 Bot 数据一起保留。专用 `$DSH_HOME/profiles/desktop` profile 拒绝添加、更新或启用 `ds-bot`／`muse-bot`，已有停用清单仍可读取。单独部署归档插件仍由其所有者负责。
3. 从历史打开普通会话，或新建会话。已有 `bot-coordinator` 会话可使用保留的通用工具；继续工作前确认原生模型和工作间。使用 `ask_user_question` 获取决定，使用 `present` 交付文件。凭据保留在既有设置中，不再通过 Bot 密钥卡片输入。
4. 确认产品提供普通会话，不再显示 Bot 导航或手机控制入口。检查原有会话历史和模型选择，再查看 `job_list` 并搜索采集／下载工具。新建会话选项中不应出现隐藏的旧预设。不要因为界面停用就删除旧 Bot 文件。
