"""任务入口的模式闸门：本模式与其他模式的任务互不串门。

  · 本模式项目提交普通拆镜（剧本页导入后、「补拆」按钮、Agent）→ 自动改走 nd_breakdown
  · 本模式项目提交普通出片/提示词/配音 → 拒绝（会把对齐好的片子与剪辑方案弄乱）
  · 去字幕 / 高清放大**放行**（交付页，2026-10-31 用户要求）：二者产物与源片逐帧等长、
    记录了 src_video_url，剪辑方案能原样套上去（见 pipeline.current_video）
  · 非本模式项目提交 nd_* → 拒绝

放在后端而不是前端：桌面端与超级 Agent 也走 /v2/jobs，前端拦不住它们。
"""
from __future__ import annotations

from fastapi import HTTPException

from ..db import Project, get_session
from . import is_nd

ND_KINDS = ("nd_breakdown", "nd_produce")
#: 本模式下不允许的通用任务：它们会改镜头视频/提示词/音频，与对齐结果脱节
BLOCKED = {"shot_videos", "one_click_film", "first_frames", "first_frame_pipeline",
           "reprompt", "tts_batch"}


def reroute(kind: str, payload: dict | None) -> str:
    pid = (payload or {}).get("project_id")
    if not pid or (kind not in ND_KINDS and kind not in BLOCKED and kind != "breakdown_all"):
        return kind
    with get_session() as session:
        nd = is_nd(session.get(Project, pid))
    if kind in ND_KINDS and not nd:
        raise HTTPException(409, "这个任务只用于「解说剧·角色开口」项目")
    if nd and kind == "breakdown_all":
        return "nd_breakdown"
    if nd and kind in BLOCKED:
        raise HTTPException(409, "「解说剧·角色开口」项目请在「一键成片」页操作："
                                 "出片、核对、补位都由流程自动完成（去字幕、高清放大在「交付」页）")
    return kind
