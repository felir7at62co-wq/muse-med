---
kind: upgrade-guide
description: "新的共享人物时期音频登记需要已认证的 Muse 协调器，不再独立创建资产。"
---

# 启用共享声线登记协调

[English](guide.md) | 中文

## 变更

同时提供 character_id 与 voice_period_id 的新 jubian_asset register 请求，在创建音频资产前需要 Host 的 Muse 账号服务和已启用的网关协调器。协调不可用或忙碌时返回待处理结果，不发送供应商 POST。已有音频复用、原账本操作对账和无标签旧登记保留原行为。不改变 Session 代际，不迁移已有音频资产。

## 迁移

1. 同时升级网关与桌面运行时，在 tool-jubian 旁挂载 muse-account，并通过原 Muse 账号设置登录。
2. 将 MUSE_VOICE_SLOTS_DIR 设置为网关发布目录之外的绝对私密持久目录，跨重启、升级保留其回执。超时和锁处理见[服务器配置](../../../../services/muse-accounts/README.zh.md#shared-voice-registration)。
3. 运行 `node --test services/muse-accounts/voice-slots.test.mjs`。确认未认证的协调请求返回 401，已认证但未配置的请求返回 503。模拟并发测试只授予一次新登记开始许可。
4. 已提交或未知登记沿原 key 对账。不能清除 submitted 回执重试或更换认领，须确认写进程停止并核查后才清理遗留锁。用已有完整音频库存复用，并在检查重复清理前查询[共享用途](../../../../packages/drama/tool-drama-assets/README.zh.md#shared-project-uses)。
