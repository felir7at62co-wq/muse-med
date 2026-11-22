"""TB-02 字幕轨：文本 / 剧情字幕 / 标题，以及 SRT 导出与项目级样式。

`GET    /v2/projects/{pid}/subtitle-clips`
`GET    /v2/projects/{pid}/spoken-lines`     —— 会被念出来的台词原文（本地强制对齐用）
`POST   /v2/subtitle-clips`
`POST   /v2/subtitle-clips/bulk`
`PATCH  /v2/subtitle-clips/{clip_id}`
`DELETE /v2/subtitle-clips/{clip_id}`
`GET/PUT /v2/projects/{pid}/subtitle-style`  —— 项目级默认字幕样式
`GET    /v2/projects/{pid}/subtitles.srt`    —— 烧录用 SRT

## 为什么从 routes_v2.py 搬出来

行数预算「只许减」（见 `routers/__init__.py`）。这一域在原文件里本就是一整块
连续代码（3851–4175），与相邻的音频/资产域没有共享状态，整块搬走最干净。

## 两条容易踩的口径陷阱（原文照录，别删）

- `list_spoken_lines` 必须走后端：判定"哪一行是台词"的权威实现是
  `drama_timing.split_units`，拆镜算时长用的就是它。前端再写一份 TS 版必然漂移，
  而字幕文本一旦和"当初让视频模型念的文本"不一致，对齐就没有意义了。
- `effective_shot_sec` 的三因素（取片窗口 / 变速 / 缺省 5s）必须与导出口径一致
  （导出侧权威写法在 `media._sec = clip_dur / _spd`）。原本 SRT 只累加
  `duration_sec`，只要项目里有一个被分割或变速过的镜头，它之后**所有**字幕的
  时间码就整体偏掉，而用户只会觉得"字幕对不上口型"（B16）。
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional
import json
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import access   # 多用户隔离：归属校验（2026-10-09）
from ..db import Project, Shot, SubtitleClip, get_session, profile_of
from ..shot_timing import _clamp_anchor, subtitle_place

router = APIRouter(prefix="/v2", tags=["subtitle"])


# ---------- TB-02 字幕轨（文本 / 剧情字幕 / 标题）----------
class SubtitleClipIn(BaseModel):
    project_id: str
    text: str
    kind: str = "subtitle"                # normal | subtitle | title
    start_shot_order: int = 1
    start_offset_sec: float = 0.0
    duration: float = 3.0
    style: Optional[dict] = None


class SubtitleClipPatch(BaseModel):
    text: Optional[str] = None
    kind: Optional[str] = None
    start_shot_order: Optional[int] = None
    start_offset_sec: Optional[float] = None
    duration: Optional[float] = None
    style: Optional[dict] = None


_SUB_KINDS = ("normal", "subtitle", "title")


def _sub_out(s) -> dict:
    return {"id": s.id, "text": s.text, "kind": s.kind,
            "start_shot_order": s.start_shot_order,
            "start_offset_sec": s.start_offset_sec,
            "duration": s.duration,
            "style": json.loads(s.style) if s.style else None,
            "created_at": s.created_at}


@router.get("/projects/{project_id}/subtitle-clips")
def list_subtitle_clips(project_id: str) -> dict:
    from ..db import SubtitleClip
    with get_session() as session:
        rows = (session.query(SubtitleClip)
                .filter(SubtitleClip.project_id == project_id)
                .order_by(SubtitleClip.start_shot_order,
                          SubtitleClip.start_offset_sec).all())
        return {"clips": [_sub_out(s) for s in rows]}


@router.get("/projects/{project_id}/spoken-lines")
def list_spoken_lines(project_id: str) -> dict:
    """每个镜头**会被念出来**的台词原文，供客户端做本地强制对齐字幕。

    为什么这条要走后端而不在前端自己解析剧本：判定"哪一行是台词"的权威实现
    是 `drama_timing.split_units`（`角色os【情绪】：台词` 那套格式），
    拆镜算时长用的就是它。前端再写一份 TS 版必然与它漂移，而字幕文本一旦
    和"当初让视频模型念的文本"不一致，对齐就没有意义了 —— 单一真源必须留在后端。

    这条**不产生任何费用、不调模型**：纯文本变换。真正的重活（silencedetect
    停顿探测）在用户本机的 ffmpeg sidecar 上跑（见 `probeSilence.ts`）。

    只回 `lines`/`text`，不回时长与 URL：那些前端已经从 project detail 拿到了，
    再发一份就会出现两处不一致的可能。按 order 关联。
    """
    from ..drama_timing import spoken_lines
    with get_session() as session:
        rows = (session.query(Shot)
                .filter(Shot.project_id == project_id)
                .order_by(Shot.order).all())
        out = []
        for sh in rows:
            lines = spoken_lines(sh.script_ref or "")
            if not lines:
                continue
            out.append({
                "shot_id": sh.id,
                "order": sh.order,
                "episode": sh.episode,
                "lines": lines,
                # 拼接用换行：下游 `splitIntoCues` 会把空白折叠掉，但换行能保证
                # 两句台词之间一定断开 —— 直接相接会把「…谁碰掉的！我根本没碰过」
                # 粘成一条，而它们是两个人说的。
                "text": "\n".join(lines),
            })
        return {"shots": out}


@router.post("/subtitle-clips")
def create_subtitle_clip(body: SubtitleClipIn) -> dict:
    from datetime import datetime, timezone
    from ..db import SubtitleClip
    if not (body.text or "").strip():
        raise HTTPException(status_code=422, detail="text required")
    if body.kind not in _SUB_KINDS:
        raise HTTPException(status_code=400, detail=f"kind 只能是 {'/'.join(_SUB_KINDS)}")
    with get_session() as session:
        if not session.get(Project, body.project_id):
            raise HTTPException(status_code=404, detail="project not found")
        s = SubtitleClip(
            id=uuid.uuid4().hex[:12], project_id=body.project_id,
            text=body.text.strip(), kind=body.kind,
            start_shot_order=_clamp_anchor(session, body.project_id,
                                          body.start_shot_order),
            start_offset_sec=max(0.0, body.start_offset_sec),
            duration=max(0.1, body.duration),
            style=json.dumps(body.style, ensure_ascii=False) if body.style else None,
            created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            origin="manual",          # 手加的：不参与「按哪份素材做的」判断（见 subtitle_status）
        )
        session.add(s)
        session.commit()
        return {"ok": True, **_sub_out(s)}


class SubtitleBulkIn(BaseModel):
    project_id: str
    clips: list[SubtitleClipIn]
    #: 先删掉该 kind 的旧字幕再写入（重新对齐时用）。None = 只追加。
    #: 语义与 run_auto_subtitles 的 replace 一致：只清自动生成的那一类，
    #: 用户手工加的 normal/title 不动。
    replace_kind: Optional[str] = None


@router.post("/subtitle-clips/bulk")
def bulk_create_subtitle_clips(body: SubtitleBulkIn) -> dict:
    """批量写入字幕段（本地对齐产物的落库入口）。

    为什么必须有批量口：一段 205 字的旁白按 15 字拆条就是 ~14 条 cue，
    一个 21 段旁白的项目就是 300 条。逐条 POST 等于 300 次往返 + 300 次
    commit，用户点一下要等半分钟，中途任何一次失败还会留下半套字幕。
    """
    from datetime import datetime, timezone
    from ..db import SubtitleClip
    if body.replace_kind is not None and body.replace_kind not in _SUB_KINDS:
        raise HTTPException(status_code=400,
                            detail=f"replace_kind 只能是 {'/'.join(_SUB_KINDS)}")
    bad = [c.kind for c in body.clips if c.kind not in _SUB_KINDS]
    if bad:
        raise HTTPException(status_code=400,
                            detail=f"kind 只能是 {'/'.join(_SUB_KINDS)}，收到 {bad[0]}")

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with get_session() as session:
        if not session.get(Project, body.project_id):
            raise HTTPException(status_code=404, detail="project not found")
        deleted = 0
        if body.replace_kind:
            deleted = (session.query(SubtitleClip)
                       .filter(SubtitleClip.project_id == body.project_id,
                               SubtitleClip.kind == body.replace_kind)
                       .delete(synchronize_session=False))
        made = 0
        for c in body.clips:
            if not (c.text or "").strip():
                continue            # 空文本跳过而不是报错：整批不该被一条空段废掉
            session.add(SubtitleClip(
                id=uuid.uuid4().hex[:12], project_id=body.project_id,
                text=c.text.strip(), kind=c.kind,
                start_shot_order=_clamp_anchor(session, body.project_id,
                                               c.start_shot_order),
                start_offset_sec=max(0.0, c.start_offset_sec),
                duration=max(0.1, c.duration),
                style=json.dumps(c.style, ensure_ascii=False) if c.style else None,
                created_at=now,
            ))
            made += 1
        session.commit()
    return {"ok": True, "created": made, "deleted": deleted,
            "skipped_empty": len(body.clips) - made}


@router.patch("/subtitle-clips/{clip_id}")
def patch_subtitle_clip(clip_id: str, body: SubtitleClipPatch) -> dict:
    from ..db import SubtitleClip
    with get_session() as session:
        s = access.req_subtitle_clip(session, clip_id)
        if body.text is not None:
            if not body.text.strip():
                raise HTTPException(status_code=422, detail="text 不能为空")
            s.text = body.text.strip()
        if body.kind is not None:
            if body.kind not in _SUB_KINDS:
                raise HTTPException(status_code=400, detail=f"kind 只能是 {'/'.join(_SUB_KINDS)}")
            s.kind = body.kind
        if body.start_shot_order is not None:
            s.start_shot_order = _clamp_anchor(session, s.project_id,
                                               body.start_shot_order)
        if body.start_offset_sec is not None:
            s.start_offset_sec = max(0.0, body.start_offset_sec)
        if body.duration is not None:
            s.duration = max(0.1, body.duration)
        if body.style is not None:
            s.style = json.dumps(body.style, ensure_ascii=False)
        session.commit()
        return {"ok": True, **_sub_out(s)}


@router.delete("/subtitle-clips/{clip_id}")
def delete_subtitle_clip(clip_id: str) -> dict:
    from ..db import SubtitleClip
    with get_session() as session:
        s = access.req_subtitle_clip(session, clip_id)
        session.delete(s)
        session.commit()
    return {"ok": True}


class SubtitleStyleIn(BaseModel):
    #: 整套样式（字号/颜色/描边/底框/位置/字体/边距）。传 null 或 {} 表示清除。
    style: Optional[dict] = None


class AiLabelIn(BaseModel):
    #: AI 生成标识（右下角小字）的整套配置。
    #: 传 null / {} 表示清除（= 关闭）。见 jianying._ai_label 的默认值。
    ai_label: Optional[dict] = None


@router.get("/projects/{project_id}/ai-label")
def get_project_ai_label(project_id: str) -> dict:
    """项目级 AI 生成标识（「内容由AI生成」右下角小字）。

    返回**合并了默认值**之后的配置 + `active` 表示导出时会不会真的生成那条轨。
    只返回原始存储内容的话，前端得自己再算一遍"空文案算不算开"——
    两处各算一遍必然漂移，而那正是"界面上开着、导出却没有"的来源。
    """
    from .jianying import _AI_LABEL_DEFAULT, _ai_label

    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        raw = profile_of(proj).get("ai_label")
        cfg = dict(_AI_LABEL_DEFAULT)
        if isinstance(raw, dict):
            cfg.update({k: v for k, v in raw.items() if k in cfg})
        # `active` 是**导出时的真实判据**（默认关、空文案算关），
        # 直接问同一个函数，不在前端再实现一遍
        return {"ai_label": cfg, "active": _ai_label(proj) is not None}


@router.put("/projects/{project_id}/ai-label")
@access.requires(access.ROLE_MANAGER)
def set_project_ai_label(project_id: str, body: AiLabelIn) -> dict:
    """写项目级 AI 生成标识。存 `default_profile.ai_label`，不加列、不用迁移。

    只改这一个键，其余（video_model / resolution / subtitle_style）原样保留
    —— 整份覆盖会把生成参数抹掉（与 subtitle-style 端点同款注意）。
    """
    from .jianying import _AI_LABEL_DEFAULT, _ai_label

    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        prof = profile_of(proj)
        if body.ai_label:
            # 只收认识的键：样式是前端写入的自由 JSON，多一个字段不该污染档案
            prof["ai_label"] = {k: v for k, v in body.ai_label.items()
                                if k in _AI_LABEL_DEFAULT}
        else:
            prof.pop("ai_label", None)
        proj.default_profile = json.dumps(prof, ensure_ascii=False) if prof else None
        session.commit()
        return {"ok": True, "ai_label": prof.get("ai_label"),
                "active": _ai_label(proj) is not None}


@router.get("/projects/{project_id}/subtitle-style")
def get_project_subtitle_style(project_id: str) -> dict:
    """项目级默认字幕样式。

    为什么需要项目级而不只是逐条样式：烧录是把**一个** SRT 用**一套**
    force_style 烧进画面，ffmpeg 的 subtitles 滤镜没有"逐条不同样式"这回事
    （那要生成 ASS 并逐条写 Style，属另一档工程）。所以导出时必须有一个
    确定的"这个项目的字幕长什么样"，而不是随便取某一条的 style 去代表全体。

    逐条 style 仍然保留，它决定的是**编辑器里的预览**与将来 ASS 导出。
    """
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        st = profile_of(proj).get("subtitle_style")
        return {"style": st if isinstance(st, dict) else None}


@router.put("/projects/{project_id}/subtitle-style")
@access.requires(access.ROLE_MANAGER)
def set_project_subtitle_style(project_id: str, body: SubtitleStyleIn) -> dict:
    """写项目级默认字幕样式。

    存进 default_profile 这个既有 JSON 列，**不加新列、不用 migration**。
    只改 subtitle_style 这一个键，其余键（video_model / resolution 等）
    原样读回再写出——直接覆盖整个 profile 会把生成参数抹掉。

    ⚠️ default_profile 在 db.py 里声明成 String(64)，而这里写进去的 JSON
    远超 64 字符。SQLite 不校验 VARCHAR 长度所以没事（既有的 custom_settings
    也早就这么存了），但若将来换成 Postgres/MySQL，这一列必须先改成 Text，
    否则会直接报错或被截断成坏 JSON。
    """
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        prof = profile_of(proj)
        if body.style:
            prof["subtitle_style"] = body.style
        else:
            prof.pop("subtitle_style", None)
        proj.default_profile = json.dumps(prof, ensure_ascii=False) if prof else None
        session.commit()
        return {"ok": True, "style": prof.get("subtitle_style")}


def effective_shot_sec(sh) -> float:
    """镜头在成片里**实际占用**的秒数 —— 与导出口径必须一致。

    三个因素，缺一个就会让下游时间码整体漂移：
      · clip_dur_sec：TB-01 分割后的取片窗口，优先于 duration_sec
      · speed：TB-03 变速（transform_meta.speed），2 倍速时占用时间减半
      · 缺省 5s：与前端 shotDuration / 导出兜底保持一致

    实现已收敛到 `shot_timing.shot_output_sec`（2026-10-23）。此前这里写着
    "导出侧的权威写法在 media.py：`_sec = clip_dur / _spd`"，但 `media.py`
    里 `speed` 出现 **0 次**，剪映导出也从未传过 `speed=` —— 也就是说这份字幕
    时间码一直按变速算，而真正出去的草稿按原速算，两边谁都不对。
    现在两边调同一个函数，不再各写一份 `max(0.25, min(4.0, …))`。

    SRT 生成原来只累加 duration_sec，与任何一边都不一致 —— 只要项目里有一个
    被分割或变速过的镜头，它之后**所有**字幕的时间码就整体偏掉，越往后偏得
    越多，而用户只会觉得"字幕对不上口型"，无从判断原因（B16）。
    """
    from ..shot_timing import shot_output_sec
    return shot_output_sec(sh)


@router.get("/projects/{project_id}/subtitles.srt")
def export_subtitles_srt(project_id: str) -> dict:
    """把字幕段导出为 SRT 文本（导出时烧录用）。

    时间轴上字幕锚定的是"第几个镜头 + 镜内偏移"，SRT 要的是绝对时间码，
    所以这里按镜头顺序累加时长换算——与导出拼接的口径必须一致：
    只算未停用镜头，时长走 effective_shot_sec()（含取片窗口与变速）。
    """
    from ..db import SubtitleClip

    def _ts(sec: float) -> str:
        ms = int(round(sec * 1000))
        h, ms = divmod(ms, 3600_000)
        m, ms = divmod(ms, 60_000)
        s, ms = divmod(ms, 1000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

    with get_session() as session:
        shots = (session.query(Shot)
                 .filter(Shot.project_id == project_id, Shot.disabled == 0)
                 .order_by(Shot.order).all())
        offsets: dict[int, float] = {}
        acc = 0.0
        for sh in shots:
            offsets[sh.order] = acc
            # 与导出口径一致：取片窗口 + 变速都要算进去
            acc += effective_shot_sec(sh)

        rows = (session.query(SubtitleClip)
                .filter(SubtitleClip.project_id == project_id)
                .order_by(SubtitleClip.start_shot_order,
                          SubtitleClip.start_offset_sec).all())
        #: 锚点镜号 → 镜头。字幕的偏移是**源秒**，SRT 要的是成片秒，差一个 speed。
        #: 与导出剪映调的是同一个函数（`subtitle_place`），两处不许各算一份
        #: —— 2026-10-24 用户报"字幕时间位置全错"就是导出侧漏了这一步。
        #: `time_base='source'` 的字幕（Muse 逐字字幕）按来源镜头找、经取片窗口换算，见 `subtitle_place`。
        sh_by_order = {sh.order: sh for sh in shots}
        sh_by_id = {sh.id: sh for sh in shots}
        placed = []
        for c in rows:
            if c.start_shot_order not in offsets and not c.source_shot_id:
                continue          # 锚定镜头被删/停用 → 该字幕无处安放，跳过
            got = subtitle_place(c, sh_by_id, sh_by_order)
            if got is not None and got[0] in offsets:
                placed.append((got, c))
        lines, n = [], 0
        for (order, off_sec, cue_sec), c in sorted(placed, key=lambda x: (x[0][0], x[0][1], x[1].id)):
            start = offsets[order] + off_sec
            n += 1
            lines.append(f"{n}\n{_ts(start)} --> {_ts(start + cue_sec)}\n"
                         f"{c.text}\n")
        return {"srt": "\n".join(lines), "count": n, "total_sec": acc}
