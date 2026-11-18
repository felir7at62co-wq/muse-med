# Muse 独立制作平台

[English](README.md) | 中文

Muse 的**制作平台**管理独立项目、剧本、人物/场景/道具资产、提示词版本和视频。默认配置尚未选择生成后端；已有项目和媒体存储无需供应商账号即可使用。

项目修改保留冲突检查和版本历史。历史结果展示自身保存的输入；缺少原提示词或资产图时明确标记未知，不能借用当前分镜设置。复制部署时必须一并保留原数据库、媒体和操作回执。

在 Muse 会话中使用剧本读取工具辅助规划。此桌面配置不启用把工作台按钮操作发到会话的功能。规划只读取已保存的项目数据，不提交供应商任务。

服务默认 `muse_generation.enabled: false`；`MUSE_STANDALONE_NO_AI=1` 也会关闭生成，即使保存的配置启用了生成。关闭模式会在接触供应商前拒绝 AI 路由和直接文本/图像/视频客户端调用，跳过启动时任务恢复与 Agent 初始化，并在 `/health` 中返回 `generationBackend: "unconfigured"`、`backgroundGeneration: false`。已有凭据、项目、资产、任务和历史不会被删除；原生存储与导入路由仍可使用。

## 保留的服务

此目录维护 LocalMiniDrama 存储及独立部署。SQLite 和媒体继续留在持久卷中。

请一并备份完整 `/var/lib/localminidrama` 卷和 Host 的 `localminidrama/operations` 回执目录。重建容器必须复用原卷。原生项目和剧变项目编号属于不同身份；查看历史不会迁移或覆盖任一项目。

已有 Windows 隔离服务可通过 [start-studio.ps1](windows/start-studio.ps1) 读取 `deployment.json` 并启动其原后端，日志仍保存在 `logs/studio-launcher.log`。保留另一份运行中的安装时，请使用独立部署目录和回环端口。

## 构建与验证

Dockerfile 对固定的上游版本应用 `patch-upstream.mjs` 并构建独立前端。配置中的文本、图像和视频默认提供方均为空。参阅[独立部署指南](standalone/README.zh.md)，使用临时项目数据启动和验证工作台，无需付费请求。

`patch-upstream.mjs` 写入前核对固定上游的所有替换。[Compose 配置](compose.yaml)只在宿主机回环地址发布端口，保留 `localminidrama-data`，并始终禁用生成。远程部署保持回环监听，通过授权的 SSH 转发访问；不要直接暴露管理 API。

参见[编辑与历史](edit-migration.md)和[修订](revisions.md)了解项目保存行为。[预算](budget.md)和[音频](audio.md)所述为可选协议，不提供已配置的生成后端。
