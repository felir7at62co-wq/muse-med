"""生成工具：提交异步 job，**全部花钱**。

## 每个函数的形状都一样

```
def run_xxx(ctx, ...) -> dict:
    return await submit_idempotent(ctx, kind="...", payload={...},
                                   tool_call_id=..., tool="...")
```

不要在这里做业务编排 —— 编排逻辑在 `jobs.py` 的 runner 里，与用户在页面上
点按钮走的是**同一条**路径。agent 与手工操作必须是同一个实现，否则两边
行为会漂移，而用户无法解释"为什么 agent 做的和我做的不一样"。

## ⚠️ 绝不直接 create_job

必须用 `submit_idempotent`。原因见 `registry.submit_idempotent` 的文档：
进程重启后 LangGraph 会重放节点，直接 create_job 会让同一批镜头生成两遍。
"""
from __future__ import annotations

import asyncio
import json
import logging

from ..db import Project, Shot, get_session
from ..script_import import episodes_json
from .executor import ToolCtx
from .registry import engine_tool, submit_idempotent

logger = logging.getLogger("fw.agent.tools.gen")


def _cid(ctx: ToolCtx, fallback: str) -> str:
    """当前 tool_call_id。空时用 fallback —— 保证至少同一轮内不重复。"""
    return ctx.tool_call_id or f"{fallback}:{ctx.run_id}"


def _episodes_of(project_id: str) -> list[int]:
    with get_session() as s:
        rows = (s.query(Shot.episode).filter(Shot.project_id == project_id)
                .distinct().all())
        return sorted({int(r[0] or 1) for r in rows})


def _replaces_script(args: dict) -> bool:
    """项目里已经有剧本 → 这次写入会把它换掉（旧剧本不留历史），要人点头。

    空项目第一次写剧本没有任何东西可丢，不拦：「上传剧本让它做整部剧」就是这条路。
    """
    pid = args.get("project_id")
    if not pid:
        return True
    with get_session() as s:
        p = s.get(Project, pid)
        return bool(p and ((p.raw_script or "").strip()
                           or (p.optimized_script or "").strip()))


@engine_tool(
    name="import_script",
    risk="write",
    role="editor",
    confirm=_replaces_script,
    description="把剧本正文写入项目。项目已有剧本时会**整体替换**（需要用户确认）。"
                "只改其中几处时用 replace_in_script，不要整篇重写（长剧本会超出单次回复上限被截断）。"
                "写完要拆解才会产出镜头。",
)
async def import_script(ctx: ToolCtx, project_id: str, script: str) -> dict:
    """直接写 `projects.raw_script`，原样落库（是否优化剧本由用户决定）。"""
    text = (script or "").strip()
    if not text:
        return {"ok": False, "error": "剧本为空"}
    with get_session() as s:
        p = s.get(Project, project_id)
        if not p:
            return {"ok": False, "error": "项目不存在"}
        old_chars = len(p.raw_script or "")
        p.raw_script = text
        p.episodes = episodes_json(text)   # 网页的分集列表读这一列，见 script_import.episodes_json
        s.commit()
    return {"ok": True, "chars": len(text), "previous_chars": old_chars,
            "note": "剧本已写入；需要拆解才会产出镜头"}


@engine_tool(
    name="replace_in_script",
    risk="write",
    role="editor",
    description="在剧本里把一段文字精确替换成另一段（改错字、改标题行、改称呼、改一句台词）。"
                "**改动小于整篇时一律用它，不要用 import_script 整篇重写**——整篇重写要把全剧本写一遍，"
                "长剧本会超出单次回复上限被截断。old 必须与剧本原文逐字一致（先 read_script 看原文）；"
                "old 出现多次时默认拒绝，replace_all=true 才全部替换。edits 可一次给多处 [{old, new, replace_all?}]，按顺序执行。"
                "已拆过镜头的集，改完剧本不会自动改镜头。不花钱。",
)
async def replace_in_script(ctx: ToolCtx, project_id: str, edits: list[dict]) -> dict:
    """对剧本做字面量替换。逐条校验，任何一条不成立则一条都不写（全有或全无）。"""
    if not isinstance(edits, list) or not edits:
        return {"ok": False, "error": "edits 为空：给 [{old, new}]"}
    if len(edits) > 50:
        return {"ok": False, "error": "一次最多 50 处，请分批"}
    with get_session() as s:
        p = s.get(Project, project_id)
        if not p:
            return {"ok": False, "error": "项目不存在"}
        # 改的是读侧真正读的那一份：有优化稿时拆解/读取都读优化稿。
        field = "optimized_script" if (p.optimized_script or "").strip() else "raw_script"
        text = getattr(p, field) or ""
        if not text.strip():
            return {"ok": False, "error": "项目还没有剧本：用 import_script 写入"}
        done = []
        for i, e in enumerate(edits, 1):
            old = str((e or {}).get("old") or "")
            new = str((e or {}).get("new") if (e or {}).get("new") is not None else "")
            if not old:
                return {"ok": False, "error": f"第 {i} 处缺 old", "applied": 0}
            n = text.count(old)
            if n == 0:
                return {"ok": False, "applied": 0,
                        "error": f"第 {i} 处在剧本里找不到原文「{old[:60]}」；先 read_script 核对原文（空格、标点、全半角要一致）"}
            if n > 1 and not (e or {}).get("replace_all"):
                return {"ok": False, "applied": 0,
                        "error": f"第 {i} 处「{old[:60]}」出现了 {n} 次；多带几个字让它唯一，或设 replace_all=true"}
            text = text.replace(old, new) if (e or {}).get("replace_all") else text.replace(old, new, 1)
            done.append({"old": old[:80], "new": new[:80], "count": n if (e or {}).get("replace_all") else 1})
        setattr(p, field, text)
        if field == "raw_script":
            p.episodes = episodes_json(text)   # 改了标题行时分集列表要跟着变
        s.commit()
    return {"ok": True, "applied": len(done), "edits": done, "chars": len(text), "field": field,
            "note": "剧本已改；已拆过镜头的集不会自动更新，需要时对那几集重新拆解或直接改镜头"}


@engine_tool(
    name="run_breakdown",
    risk="generate",
    costs=True,
    long_running=True,
    role="editor",
    # force 会直接删掉这些集已有的镜头（硬删、无版本），只有它需要用户点头
    confirm=lambda args: bool(args.get("force")),
    description="把剧本拆解成镜头（AI 分镜，机器初稿）。episodes 指定只拆这几集；已拆过的集自动跳过。"
                "force=true 会重拆已有镜头的集（**删掉这些集已有的镜头，需要用户确认**）。"
                "只建镜头行与要素（角色/场景/道具、造型、档案、场景描述），**不写镜头脚本**："
                "镜头脚本由你在场景图出好之后用 set_shot_prompts(lock=true) 写入并锁定。"
                "拆得不对的地方直接改（patch_shot / insert_shot / split_shot / merge_shots / "
                "delete_shots / move_shot）；想完全按自己的拆法来，用 write_episode_shots。",
)
async def run_breakdown(ctx: ToolCtx, project_id: str,
                        episodes: list[int] | None = None,
                        force: bool = False) -> dict:
    payload: dict = {"project_id": project_id, "force": bool(force)}
    if episodes:
        payload["episodes"] = [int(x) for x in episodes]
    return await submit_idempotent(
        ctx, kind="breakdown_all", payload=payload,
        tool_call_id=_cid(ctx, "breakdown"), tool="run_breakdown")


@engine_tool(
    name="run_asset_fill",
    risk="generate",
    costs=True,
    long_running=True,
    role="editor",
    description="补齐**还没有图**的资产图，一律按平台模板自动拼提示词。kinds 指定只补哪几类："
                "character（角色：补的是**造型图**；角色还没有造型时先建一套默认造型再画）/ location（场景）/ prop（道具）。缺省 = 三类都补。已有图的不动。"
                "⚠️ 它**不读**用 set_asset_prompts 写的整段稿，角色补的是造型图；"
                "某件资产要按自己写的稿出图，用 run_asset_generate 并把稿放进 prompt 参数。",
)
async def run_asset_fill(ctx: ToolCtx, project_id: str,
                         kinds: list[str] | None = None) -> dict:
    payload: dict = {"project_id": project_id}
    if kinds:
        payload["kinds"] = [k for k in kinds if k in ("character", "location", "prop")]
    return await submit_idempotent(
        ctx, kind="asset_fill", payload=payload,
        tool_call_id=_cid(ctx, "asset_fill"), tool="run_asset_fill")


@engine_tool(
    name="run_asset_generate",
    risk="generate",
    costs=True,
    long_running=True,
    role="editor",
    description="生成**一件**资产的图并立即替换（不管它现在有没有图；旧图留在版本里）。"
                "kind + name 定位资产；角色的图出片时读的是**造型**，所以角色有造型时要传 stage_id"
                "（list_assets 能看到每套造型的 id）——不传就只换角色资产自己的图（角色有造型图时，卡片和兜底显示的是基础造型的图，这张基本用不到）。"
                "提示词：prompt 传了就**原样**用这段（例如用户给的框架写出的整段稿）；"
                "不传时，资产用 set_asset_prompts 写过的稿，造型按模板 + 着装描述自动拼。",
)
async def run_asset_generate(ctx: ToolCtx, project_id: str, kind: str, name: str,
                             stage_id: str | None = None, prompt: str = "") -> dict:
    payload: dict = {"project_id": project_id, "kind": kind, "name": name}
    if stage_id:
        payload["stage_id"] = stage_id
    if (prompt or "").strip():
        from ..prompt_sanitize import strip_editor_chrome
        payload["prompt"] = strip_editor_chrome(prompt).strip()
    return await submit_idempotent(
        ctx, kind="asset_generate", payload=payload,
        tool_call_id=_cid(ctx, "asset_generate"), tool="run_asset_generate")


# ⚠️ 这里原有 `run_first_frames` 工具（批量生成镜头首帧图，可带调用方写的首帧画面描述），
# 2026-11-20 从 Agent 工具面删除：首帧 / 首尾帧 / 尾帧三种生成模式整体下线（用户裁定），
# 出片统一走全能参考，镜流不再给镜头出首帧图。对应的任务类型 `first_frames` 回 410
# （`jobs.RETIRED_KINDS`）。要指定开头或结尾画面，把那张图作为参考图加进镜头。


@engine_tool(
    name="run_shot_videos",
    risk="generate",
    costs=True,
    long_running=True,
    role="editor",
    description="批量生成镜头视频。**这是最贵的一步**。"
                "只出**已锁定镜头脚本**的镜头（set_shot_prompt(s) 的 lock=true）：没有锁定稿的镜头会当场失败并说明，"
                "镜流不会替它现写提示词。"
                "shot_ids 缺省 = 全片未出片的镜头；episode 只出某一集。"
                "resolution 只改这一次的分辨率（480p / 720p / 1080p / 2k），不传按项目设置；"
                "要以后都用某个分辨率，用 set_project_models 改项目设置。"
                "建议先用单个 shot_ids 试片，确认后再扩。",
)
async def run_shot_videos(ctx: ToolCtx, project_id: str,
                          shot_ids: list[str] | None = None,
                          episode: int | None = None,
                          resolution: str | None = None) -> dict:
    from ..shot_timing import RESOLUTION_TIERS

    payload: dict = {"project_id": project_id}
    if resolution:
        res = str(resolution).strip().lower()
        if res not in RESOLUTION_TIERS:
            return {"ok": False, "error": f"不支持的分辨率 {resolution}；可选：{', '.join(RESOLUTION_TIERS)}"}
        payload["resolution"] = res
    if shot_ids:
        payload["shot_ids"] = list(shot_ids)
    elif episode is not None:
        with get_session() as s:
            ids = [r[0] for r in (s.query(Shot.id)
                                  .filter(Shot.project_id == project_id,
                                          Shot.episode == int(episode),
                                          Shot.disabled == 0,
                                          Shot.is_special == 0)
                                  .order_by(Shot.order).all())]
        payload["shot_ids"] = ids
        if not ids:
            return {"ok": False, "error": f"第 {episode} 集没有可生成的镜头"}
    return await submit_idempotent(
        ctx, kind="shot_videos", payload=payload,
        tool_call_id=_cid(ctx, "shot_videos"), tool="run_shot_videos")


@engine_tool(
    name="run_tts",
    risk="generate",
    costs=True,
    long_running=True,
    role="editor",
    description="把待合成的音频段合成出来（解说剧旁白 / 角色配音）。"
                "clip_ids 缺省 = 所有 pending 的段。",
)
async def run_tts(ctx: ToolCtx, project_id: str,
                  clip_ids: list[str] | None = None) -> dict:
    payload: dict = {"project_id": project_id}
    if clip_ids:
        payload["clip_ids"] = list(clip_ids)
    return await submit_idempotent(
        ctx, kind="tts_batch", payload=payload,
        tool_call_id=_cid(ctx, "tts"), tool="run_tts")


@engine_tool(
    name="generate_narration",
    risk="write",
    role="editor",
    description="解说剧：按镜头逐一建旁白段（只建段不合成，合成走 run_tts）。"
                "旁白内容为剧本原文照读，不改写。",
)
async def generate_narration(ctx: ToolCtx, project_id: str,
                             replace: bool = False) -> dict:
    from ..routers.audio import GenNarrationIn, generate_narration as _gen

    # GenNarrationIn 的 project_id 是必填字段；漏传会让这个工具每次都抛参数校验错误
    # （2026-10-30 桌面端全量冒烟发现，此前从未成功过）。
    r = _gen(project_id, GenNarrationIn(project_id=project_id, replace=bool(replace)))
    return {"ok": True, **(r or {})}


@engine_tool(
    name="run_desub_apply",
    risk="generate",
    costs=True,
    long_running=True,
    role="editor",
    description="擦除已检测出的烧录字幕。**按处理时长计费且不可逆**（原片会作为"
                "历史版本保留）。region_ids 只擦指定的那几条区间。",
)
async def run_desub_apply(ctx: ToolCtx, project_id: str,
                          shot_ids: list[str] | None = None,
                          region_ids: list[str] | None = None) -> dict:
    payload: dict = {"project_id": project_id}
    if shot_ids:
        payload["shot_ids"] = list(shot_ids)
    if region_ids:
        payload["region_ids"] = list(region_ids)
    return await submit_idempotent(
        ctx, kind="desub_apply", payload=payload,
        tool_call_id=_cid(ctx, "desub_apply"), tool="run_desub_apply")


@engine_tool(
    name="run_upscale",
    risk="generate",
    costs=True,
    long_running=True,
    role="editor",
    description="把已出片的镜头做高清放大（按机时计费）。默认跳过已高清的。",
)
async def run_upscale(ctx: ToolCtx, project_id: str,
                      episode: int | None = None,
                      shot_ids: list[str] | None = None) -> dict:
    payload: dict = {"project_id": project_id}
    if shot_ids:
        payload["shot_ids"] = list(shot_ids)
    elif episode is not None:
        payload["episode"] = int(episode)
    return await submit_idempotent(
        ctx, kind="upscale", payload=payload,
        tool_call_id=_cid(ctx, "upscale"), tool="run_upscale")


@engine_tool(
    name="cancel_job",
    risk="write",
    role="editor",
    description="取消一个正在跑的任务。取消得越早退得越多（已消耗的部分不退）。",
)
async def cancel_job(ctx: ToolCtx, job_id: str) -> dict:
    """与网页 `POST /v2/jobs/{id}/cancel` 同一语义：只标记、刻意不结算。

    归属必须校验（`_job_of_project`）：否则对任一项目有 editor 档的人
    就能取消别人项目的任务。
    """
    from datetime import datetime, timezone

    from ..db import Job, get_session as _gs
    from .tools_read import _job_of_project

    j = _job_of_project(ctx, job_id)
    if not j:
        return {"ok": False, "error": f"任务不存在: {job_id}"}
    if j.status not in ("pending", "running"):
        return {"ok": True, "job_id": job_id, "status": j.status,
                "note": "任务已结束，无需取消"}
    with _gs() as s:
        row = s.get(Job, job_id)
        if row and row.status in ("pending", "running"):
            row.status = "cancelled"
            row.error = "用户取消"
            row.updated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
            s.commit()
    return {"ok": True, "job_id": job_id, "status": "cancelled"}


@engine_tool(
    name="export_jianying",
    risk="read",
    role="viewer",
    description="导出剪映草稿包（含视频轨、配乐轨、字幕轨）。返回下载地址。"
                "必须先把该出的片出完、该配的音配完，否则导出的是空轨。",
)
async def export_jianying(ctx: ToolCtx, project_id: str,
                          episode: int | None = None,
                          single_file: bool = True) -> dict:
    """直接调路由函数（不走 HTTP）：agent 跑在后台，没有 request 上下文。"""
    from ..routers.jianying import ExportReq, export_draft

    req = ExportReq(episode=episode, single_file=bool(single_file))
    # 路由函数是同步的（打包 + 直传进桶），放进线程，不占事件循环
    out = await asyncio.to_thread(export_draft, project_id, req)
    if isinstance(out, dict) and out.get("url"):
        out.setdefault("note", "下载后双击包内的一键导入即可")
    return {"ok": True, **(out or {})}


@engine_tool(
    name="export_srt",
    risk="read",
    role="viewer",
    description="导出 SRT 字幕文本（用于外部烧录或校对）。",
)
async def export_srt(ctx: ToolCtx, project_id: str) -> dict:
    from ..routers.subtitle import export_subtitles_srt

    r = export_subtitles_srt(project_id)
    return {"ok": True, **(r or {})}
