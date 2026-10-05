---
kind: upgrade-guide
description: "Muse 撤下上游模型目录已不再供应的内置 GLM-5 与 GLM-5.1 路由。"
---

# 为保存的 GLM-5 对话选择可用 Muse 模型

[English](guide.md) | 中文

## 变更

Muse 内置模型目录撤下 `yunying/glm-5` 与 `yunying/glm-5.1`：两者都返回 HTTP 404，且不在上游模型清单中。保存了其中任一选项的对话须先选择当前供应的模型才能继续。其他已配置模型 ID 保持原标识。已有 Session 日志和对话内容仍可读取；此次变更不改变 Session 格式，也不会自动替换成其他模型。

## 迁移

1. 登录后刷新 Muse 模型列表，打开受影响对话的模型选择器。
2. 选择可用的 Muse 模型，例如 `glm-5.3` 或 `glm-5.3-flash`，继续任务。确认选择器显示新选项且下一次请求完成。
3. 管理员从 `providers.yunying.models` 移除两项前须保留私有目录备份。通过全局模型设置编辑；若直接编辑私有目录文件，则重启账号网关。确认经过认证的 `GET /api/desktop-models/providers` 不再公开已撤下的 ID。只有提供方恢复供应且工具调用与续接验证成功后才恢复相应 ID。
