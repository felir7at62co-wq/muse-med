---
name: jubian-snatch
description: Use when 用户要查看剧变剧本池的可领剧本、认领指定剧本，或在明确的时间窗口内按指定 ID 或新增可领范围抢本。
---

# 剧变剧本池认领

认领会改变用户在剧变上的业务状态。先回看用户原话，确认用户明确授权了哪些剧本或哪一类新本、开始与结束时间。用户只要求查看、讨论或配置抢本能力时，只读检查，不启动认领；不能把 `jubian_find` 找到可领剧本理解成授权，也不能自行扩大为“一键抢光”。

| 用户需求 | 调用 | 结果 |
|---|---|---|
| 看池子里有哪些本 | `jubian_find`，`scope=pool` | 只读；逐行看 `can_claim`，只有 `canClaim=1` 才是当前账号可领 |
| 核对一个 ID | `jubian_claim.inspect`，带 `script_id` | 只读；核对当前账号的 `can_claim`、状态和角色 |
| 认领一个已授权 ID | `jubian_claim.claim`，带 `script_id`、`idempotency_key`、`authorization_basis` | 工具先核对 `canClaim=1`，再按 `viewRole` 选组长或组员接口，最多发一次写请求 |
| 在指定窗口抢本 | `jubian_snatch`，带 `scope`、UTC `start_at`／`end_at`、`idempotency_prefix`、`authorization_basis` | 返回 `job_id`；用 `job_output` 读取逐本结果，用 `job_kill` 停止后续观察 |

`scope=ids` 必须带用户明确授权的 `script_ids`，只尝试这些 ID；`scope=new_claimable` 只在用户明确授权“窗口内新增可领剧本”时使用，先读取完整池子作为基线，再只考虑新出现且当前账号 `canClaim=1` 的行。两种范围都不包含自动退回、分发或删除。`authorization_basis` 简述用户原话中的授权，不要编造；缺少目标范围或时间时先请用户说明。时间使用 UTC ISO 格式并换算用户所说的本地时间，确认日期与时区后再提交。

每个 ID 只认领一次。单本重复查询保留同一个 `idempotency_key`；定时任务每本的键是 `<idempotency_prefix>/<script_id>`。遇到超时、权限拒绝、收据不一致或回读不确定时，使用原键和 `jubian_claim.inspect` 只读对账，不换键重投。只有回读显示当前账号 ID 在相应领本位置，才把状态写为 `verified`；`accepted_unverified` 仅表示收到受理收据，仍需核对。账号角色未知或扫描未覆盖提供方报告的总数时停止，不猜测端点或遗漏本数。

定时作业有部署设置的轮询间隔、扫描页数、认领数量与窗口上限；不要在外部写无界循环或高频请求。作业随 Muse Host 进程重启不恢复；重新开始前先读本地账本与池子，核对未确定的旧尝试，并取得新的目标与时间授权。不要在工具参数、记录、回复或文件中输出剧变 token。当前 Muse 的剧变凭据由产品设置管理，本 skill 不读取其他项目的凭据文件。
