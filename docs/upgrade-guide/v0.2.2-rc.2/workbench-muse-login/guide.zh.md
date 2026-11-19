---
kind: upgrade-guide
description: 镜流通过 Muse 登录已有工作台账号。
---

# 将工作台账号关联到 Muse

[English](guide.md) | 中文

## 变更

镜流使用 Muse 登录。镜流聊天工具使用桌面当前账号。已有项目、剧本归属、权限和余额由业务系统中的数字用户 ID 关联。

## 迁移

1. 在 Muse 网关的 `MUSE_WORKBENCH_LOGIN_CONFIG` 中配置镜流的固定回调地址与服务凭据。参见[网关配置](../../../../services/muse-accounts/README.zh.md)。
2. 配置并安装[业务服务适配器](../../../../services/muse-workbenches/README.zh.md)。开放入口前，核实原工作台用户 ID，再将它绑定到稳定的 Muse 账号 ID。
3. 为桌面配置 `MUSE_JINGLIU_ORIGIN`。用已绑定的测试账号打开已有镜流项目，再换另一个账号验证私人项目访问权限。
