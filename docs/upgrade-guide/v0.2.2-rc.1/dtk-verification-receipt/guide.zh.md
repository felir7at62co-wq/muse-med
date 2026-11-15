---
kind: upgrade-guide
description: "DTK 部署回执移除未经验证的 profiles 字段，并要求观测私有运行配置。"
---

# DTK 验证回执

[English](guide.md) | 中文

## 变更

DTK 部署验证器不再在 JSON 回执中输出 `profiles`。原有 `images` 的键标识实际观测到的必需服务，不能据此推断历史 Compose profile 参数。新回执增加实际观测的 `publishedBindings`、`networkModes` 和 `transcriberRuntime`。公网绑定、未知运行状态或已配置的转写会导致脚本拒绝生成成功回执。

## 迁移

1. 修改回执读取方，不再读取 `profiles`；检查已观测的必需服务时使用 `images`。
2. 按[部署验证流程](../../../../services/muse-media/deploy/README.zh.md)，在仓库根目录重新运行 `python3 services/muse-media/deploy/verify.py --source /opt/muse/dtk/source-v5.1.10`。就绪阶段默认预算为 120 秒，操作系统创建或终止进程可能额外耗时；可用 `--readiness-timeout <seconds>` 指定正且有限的新预算。
3. 要求脚本成功退出，并检查回执中的 `verifiedAt` 为本次新时间。从这个新验证的回执读取 `listen` 和 `transcriberEnabled`；旧回执属于历史记录，检查失败时不会被重写。
