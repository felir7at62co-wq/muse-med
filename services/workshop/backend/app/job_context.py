"""当前正在执行的作业号 —— 让"这次作业改了哪几集"可被回答。

## 为什么需要它

`script_episode_history` 过去没有任何列能关联到作业，于是
`GET /v1/agent/jobs/{id}/changes` 只能按 draft 取"最近 N 条"，
点**任意**作业的「看改动」看到的都是同一份（dev 实测 job #107 修 1 集大纲
与 #110 整本精修 61 集，返回内容 md5 完全相同）。

## 为什么用 contextvar 而不是给 33 个调用点加参数

写历史的两条底层入口是 `stages/candidate_store.snapshot_in` 与
`stages/router_m5_enhanced._save_episode_history`，全仓共 33 处调用它们。
作业号是**执行环境**的属性，不是每次写入的业务参数 —— 逐处传参既啰嗦又
容易漏（漏一处就丢一集的归因）。contextvar 让它自动流到写入点。

## 为什么单独一个模块

`jobs.py` 属于 agent 层、写入口属于 stages 层，`jobs.py` 自己也刻意把
`chat_jobs` 的 import 推迟到函数内以避开成环（见 `worker_loop` 里的注释）。
把 ContextVar 放在这个两边都能安全 import 的中立位置，谁都不必依赖谁。

## 用法

    token = JOB_ID.set(job_id)
    try:
        ...           # 这段里写的历史都带上 job_id
    finally:
        JOB_ID.reset(token)   # ← 漏掉它，worker 长循环里下一个作业会读到上一个的 id

写法与 `app/factory/usage.py` 的 `_usage_ctx` 同款（那边也是"用 contextvar
把作业身份传给所有下游写入点"，两处刻意保持一致）。
"""
from __future__ import annotations

import contextvars

#: 当前作业号。None = 不在作业上下文里（HTTP 请求内直接写、脚本、定时任务）。
JOB_ID: contextvars.ContextVar[int | None] = contextvars.ContextVar(
    "agent_job_id", default=None)


def current_job_id() -> int | None:
    """取当前作业号；不在作业里返回 None（读侧据此回落到时间窗查询）。"""
    return JOB_ID.get()


# ---------------------------------------------------------------------------
# 写作模型覆盖：对话栏选的模型 → 这次触发的所有平台写作调用
# ---------------------------------------------------------------------------
#
# ## 为什么在 get_llm 一处生效，而不是给每个写作入口加参数
#
# 平台的写作链路（生成大纲/正文/剧本、按意见重生成、精修、修复、补节拍、续写、
# 区间重写、节奏重排、角色卡、改编、裂变、小说推文……）有二十多个入口，各自从
# `draft.model_provider` 或硬编码默认值取模型。逐个加参数必然漏，漏掉的那条会
# **静默**用回草稿的模型 —— 用户选了 A、稿子被 B 写，界面和日志都看不出来
# （2026-10-19 实测：选了 deepseek，生成剧本仍走 gemini）。所有平台 LLM 调用都经过
# `models.llm.get_llm`，在那里替换是唯一不会漏的位置。
#
# ## 作用范围
#
# 只在显式设置了它的执行环境里生效：Agent 引擎的一轮运行（工具执行期间）、由它入队
# 的作业（payload["writing_model"] 跨进程携带，worker 执行时恢复）、对话栏动作按钮
# 的那次请求。草稿页上的按钮、定时任务、脚本都不受影响。
# Agent 自己"思考"用的模型不经过 get_llm，不会被它改掉。
# 跨厂商兜底的 qwen 不替换（它的存在意义就是"换个厂商再试"）。
#
# 写法同上面的 JOB_ID：set 拿 token，finally 里 reset。
WRITING_MODEL: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "writing_model_override", default=None)


def current_writing_model() -> str | None:
    """当前执行环境指定的写作模型（"厂商:型号"）；没指定返回 None。"""
    return WRITING_MODEL.get()
