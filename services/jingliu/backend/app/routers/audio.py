"""音频轨：TTS 旁白、配乐、音效，以及项目音频素材库。

`PUT    /v2/projects/{pid}/narration-voice`   —— 解说剧音色
`POST   /v2/projects/{pid}/narration/generate` —— 按旁白分段合成（**按时长计费**）
`GET    /v2/projects/{pid}/audio-clips` / `POST /v2/audio-clips`
`PATCH/DELETE /v2/audio-clips/{clip_id}`
`POST   /v2/shots/detach-audio`               —— 把镜头原声分离成独立音轨
`GET    /v2/projects/{pid}/audio-library`     —— 项目自有音频素材库（BGM / 音效）
`PATCH  /v2/clips/{clip_id}/audio-tag`        —— 给素材打用途标签

## 为什么从 routes_v2.py 搬出来

行数预算「只许减」（见 `routers/__init__.py`）。这一域在原文件里本就是一整块
连续代码（3242–3786），依赖的时长/锚点工具已下沉到 `shot_timing`，
与相邻的字幕域也没有共享状态，整块搬走最干净。

## 音频素材库为什么不是"平台曲库"

方案原本设想 `GET /audio-library?kind=bgm|sfx` 是一个**平台内置**曲库。
但本项目没有任何版权音乐资产，凭空返回一批曲目要么是假数据、要么是侵权外链，
两者都比"没有"更糟。因此实现为**项目自有音频素材库**：复用已有的 media_clips
（用户上传的音频），按用途打标签后分组返回。
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional
import json
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import access   # 多用户隔离：归属校验（2026-10-09）
from ..db import AudioClip, MediaClip, Project, Shot, get_session, profile_of
from ..script_import import smart_split_chapters
from ..shot_timing import _clamp_anchor, _narration_duration, _remap_anchors, shot_seconds_cap
from .. import stale as stale_mod

router = APIRouter(prefix="/v2", tags=["audio"])


# ---------- P2-4 音频轨（TTS 旁白 / 配乐，修 D5）----------
class AudioClipIn(BaseModel):
    project_id: str
    kind: str = "tts"                     # tts | music | narration
    text: Optional[str] = None            # tts / narration 必填
    url: Optional[str] = None             # music 必填（素材池音频 URL）
    duration: Optional[float] = None      # music 可传（素材池已探测）
    start_shot_order: int = 1
    start_offset_sec: float = 0.0
    voice_ref_url: Optional[str] = None   # tts 参考音色（素材池音频/视频 URL）
    #: narration 专用：锚定到哪一镜。见 create_audio_clip 的说明。
    source_shot_id: Optional[str] = None


class AudioClipPatch(BaseModel):
    start_shot_order: Optional[int] = None
    start_offset_sec: Optional[float] = None
    text: Optional[str] = None            # 改文本后 status 回 pending（需重新合成）
    #: 6.9 修剪窗口（秒）。夹持在 [0, duration] 内，见 patch_audio_clip。
    clip_in_sec: Optional[float] = None
    clip_dur_sec: Optional[float] = None
    #: 取消修剪：把上面两列一起清空（回到"整段播放"）。
    #: 必须单独一个字段 —— `clip_dur_sec: None` 在 PATCH 语义里是"不改这一列"，
    #: 表达不了"改成 NULL"。Shot 那边同样的需求同样单开了 clear_clip（1921 行），
    #: 这里照抄它，免得两个实体对同一件事有两种写法。
    clear_clip: Optional[bool] = None


class NarrationVoiceIn(BaseModel):
    #: 参考音频 URL（/fw/media/...）；传 null 表示清除
    voice_url: str | None = None


@router.put("/projects/{project_id}/narration-voice")
@access.requires(access.ROLE_MANAGER)
def set_narration_voice(project_id: str, body: NarrationVoiceIn) -> dict:
    """设置解说音色。整片共用一个解说声，所以挂项目而非角色。

    只存 URL，不做转码——TTS provider 上传参考音时会自己处理
    （视频素材抽音轨、只取前 15s）。

    ## 顺手回填已有旁白段（2026-10-28 生产事故）

    `AudioClip.voice_ref_url` 是**建段那一刻**从项目音色抄下来的快照。
    而真实使用顺序几乎总是「先切分旁白 → 发现没配音色 → 回来上传」：
    音色挂在项目上没有，已经建好的那 900 多段永远带着空值，
    点合成只会得到「未选择参考音色」，**上传几次都没用**。
    生产实测全库 2091 段旁白，`voice_ref_url` 非空 0 条、合成成功 0 条。

    所以这里保存后把本项目里**还没有音色**的旁白段一起补上。
    只补空的，不覆盖：用户给某一段单独指定过音色时，那是他的明确选择。
    """
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        proj.narration_voice_url = (body.voice_url or "").strip() or None
        n = 0
        if proj.narration_voice_url:
            from ..db import AudioClip
            rows = (session.query(AudioClip)
                    .filter(AudioClip.project_id == project_id,
                            AudioClip.kind == "narration").all())
            for a in rows:
                if not (a.voice_ref_url or "").strip():
                    a.voice_ref_url = proj.narration_voice_url
                    n += 1
        session.commit()
        return {"ok": True, "voice_url": proj.narration_voice_url,
                "clips_filled": n}


class GenNarrationIn(BaseModel):
    project_id: str
    #: 只处理这些集；空/缺省 = 全部集
    episodes: list[int] | None = None
    #: 已存在旁白时是否覆盖重建（默认否，避免误删已合成的音频）
    replace: bool = False
    #: 参考音色（整片统一一个解说声）
    voice_ref_url: str | None = None


@router.post("/projects/{project_id}/narration/generate")
def generate_narration(project_id: str, body: GenNarrationIn) -> dict:
    """解说剧：给每个镜头建它自己那段旁白。

    只建段、不合成——合成仍走既有的 tts_batch job（用户在音频面板点合成）。
    这样切分结果可以先在音频面板里逐条读一遍、改一改，再花钱去合成。

    旁白内容是**剧本原文照读**，不经 AI 改写：解说剧的定位就是
    "剧本即解说词"，任何改写都会让用户失去对文案的控制。

    ## 不变式：第 N 镜的旁白 == 第 N 镜画面所依据的那段原文

    此前的做法是把**整集正文**丢给 `split_narration` 按"剩余字数/剩余段数"
    重新切一遍，于是同一份文本存在两套互不相干的边界：画面按 AI 拆解的叙事
    节拍切，旁白按贪心装箱切。对不齐是**必然**的，不是偶发 bug——实测项目 930
    的镜 3 画面演的是原文第 380-582 字，配的旁白却是第 250-319 字。

    `script_ref` 按定义就是"这个镜头在演哪段原文"，所以直接拿它当旁白，1:1 绑定。

    读不完的镜头（拆镜提示词按"7-15 秒视频"设计，一镜可能 116 字要读 26 秒，
    而 720p 海螺 H3 一镜只够 19.1s ≈ 85 字）**拆成更多镜头**：按句界切开，
    紧随其后插入克隆镜，画面全程有运动。镜头数会增加，这是"严格一一对应"的
    直接代价（用户已明确选择此方案）。

    `script_ref` 缺失/覆盖率过低的老项目退回原来的按集切分路径，返回体里
    如实标 `mode`——不再静默走一条对齐质量完全不同的路。

    幂等：默认跳过已有旁白的镜头；replace=true 时先删掉旧的 narration 段
    （只删本函数建的 kind="narration"，不碰用户自己加的 tts/music）。
    """
    from datetime import datetime, timezone
    from ..db import AudioClip
    from ..script_import import (split_narration, strip_script_markup,
                                plan_narration_by_shot, spoken_chars)

    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        raw = proj.raw_script or ""
        if not raw.strip():
            raise HTTPException(status_code=400, detail="项目还没有剧本内容")
        # 音色优先用本次传入的，其次用项目上设定的解说音色。
        # 没有音色也照样建段——文案可以先校对，合成时才需要音色。
        voice = body.voice_ref_url or proj.narration_voice_url

        # 按**项目选定的分辨率 + 视频模型**决定单镜最长时长：解说剧应当在用户
        # 选的画质下尽可能出长镜，而不是拿固定秒数一刀切。0.5MP 能一镜 38s，
        # 2.0MP 只有 7.5s——用后者的标准去切前者，会白白多切数倍镜头。
        # 同时不能超过模型自身上限（seedance 15s / veo 8s），见 shot_seconds_cap。
        max_sec, mp = shot_seconds_cap(profile_of(proj))

        chapters = {c["order"]: c["content"] for c in smart_split_chapters(raw)}
        shots = (session.query(Shot)
                 .filter(Shot.project_id == project_id)
                 .order_by(Shot.episode, Shot.order).all())
        if not shots:
            raise HTTPException(status_code=400, detail="还没有拆出镜头，先做剧本拆解")

        # 按集分组镜头（停用镜头不参与：它不出现在成片里，给它配旁白等于浪费）
        by_ep: dict[int, list] = {}
        for s in shots:
            if s.disabled:
                continue
            by_ep.setdefault(s.episode, []).append(s)

        want_eps = set(body.episodes) if body.episodes else set(by_ep.keys())

        if body.replace:
            (session.query(AudioClip)
             .filter(AudioClip.project_id == project_id,
                     AudioClip.kind == "narration")
             .delete(synchronize_session=False))
            session.commit()

        existing = {
            r[0] for r in session.query(AudioClip.source_shot_id)
            .filter(AudioClip.project_id == project_id,
                    AudioClip.kind == "narration",
                    AudioClip.source_shot_id.isnot(None)).all()
        }

        # ---- 走哪条路：script_ref 到底覆盖了多少剧本 ----
        #
        # 分母刻意用**整本剧本**而不是"本次要生成的那几集"：集号本身就可能是错的
        # （Bug A 会把所有镜头打成 episode=1），拿错的集号去算覆盖率只会得出错的
        # 判断。而 by_shot 路径根本不依赖集号——它只看每个镜头自己的 script_ref，
        # 所以即使集号是坏的，走它也仍然对得齐。
        script_all = len(spoken_chars(raw))
        live_all = [s for ss in by_ep.values() for s in ss]
        ref_all = sum(len(spoken_chars(s.script_ref or "")) for s in live_all)
        # 0.5 是"script_ref 有没有当真填过"的判据，不是质量线：AI 拆解正常时
        # 这个比值在 0.95~1.05，未回填 script_ref 的老项目则接近 0。
        by_shot = script_all > 0 and ref_all >= script_all * 0.5

        created, skipped, no_text, added_shots = 0, 0, 0, 0
        split_shots = 0
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        #: [(镜头, 该镜旁白文本)]，两条路径都归到这个形状，落库代码只有一份
        pairs: list[tuple[Shot, str]] = []

        if by_shot:
            # ---- 阶段一：改镜头结构（读不完的镜头按句界拆成多镜）----
            live = [s for ep in sorted(by_ep) if ep in want_eps for s in by_ep[ep]]
            plans = plan_narration_by_shot([s.script_ref or "" for s in live],
                                           max_sec)
            plan_by_id = {s.id: segs for s, segs in zip(live, plans)}
            old_ids = {s.id for s in shots}
            # 克隆镜先占一个不与现有 order 冲突的临时号，下面统一重排。
            # Shot.order 非空，不能等重排时再填。
            next_order = max(s.order for s in shots) + 1

            new_seq: list[Shot] = []
            for s in shots:
                new_seq.append(s)
                segs = plan_by_id.get(s.id)
                if segs is None:      # 停用镜 / 本次不生成的集：原样留在序列里
                    continue
                if not segs:          # script_ref 为空：没有旁白可建，如实计数
                    pairs.append((s, ""))
                    continue
                if len(segs) > 1:
                    split_shots += 1
                    if (s.script_ref or "").strip() != segs[0]:
                        s.script_ref = segs[0]
                        s.duration_sec = _narration_duration(segs[0], max_sec)
                        # 画面所依据的文字变了，已出的片就不再对应它了。
                        # 不自动重生成（烧钱），只置 stale 让用户看得见。
                        # reprompt：script_ref 被改写，旧 gen_prompt 已失效，
                        # 重出片时必须从新 script_ref 重新优化（见 app/stale.py）。
                        if s.video_url:
                            stale_mod.mark_stale(s, stale_mod.REPROMPT)
                pairs.append((s, segs[0]))
                for seg in segs[1:]:
                    clone = Shot(
                        id=uuid.uuid4().hex[:12], project_id=project_id,
                        order=next_order, episode=s.episode,
                        script_ref=seg,
                        link_to_prev="continuous",
                        characters=s.characters,
                        location=s.location,
                        gen_prompt=s.gen_prompt,
                        prompt_state=s.prompt_state,
                        duration_sec=_narration_duration(seg, max_sec),
                        status="pending",
                    )
                    next_order += 1
                    session.add(clone)
                    new_seq.append(clone)
                    pairs.append((clone, seg))
                    added_shots += 1
            session.flush()   # 让克隆镜落到会话里，下面重排能拿到它们

            # 全局重排 1..N。音频/字幕锚点是普通整数 order、不是外键，
            # 不搬的话插了克隆镜之后所有旧旁白整体错位到别的镜头上。
            # mapping 只收**原有**镜头（克隆镜的临时号没有任何锚点指向它）。
            mapping: dict[int, int] = {}
            for i, s in enumerate(new_seq, start=1):
                if s.id in old_ids and s.order != i:
                    mapping[s.order] = i
                s.order = i
            _remap_anchors(session, project_id, mapping)
            session.commit()
        else:
            # ---- 兜底：老项目没有 script_ref，只能按集正文重切 ----
            # 这条路的对齐质量与 by_shot **不同**（两套边界，见函数文档），
            # 但总比没有旁白强。返回体里标了 mode，前端据此提示用户重拆一次。
            for ep, ep_shots in sorted(by_ep.items()):
                if ep not in want_eps:
                    continue
                segments = split_narration(chapters.get(ep, ""), len(ep_shots),
                                           max_sec=max_sec)
                # 段数多于镜头时**补镜头**，而不是丢文字：解说剧里旁白是硬约束
                # （读不完就是读不完），镜头数应当跟着切分走。原来用 zip() 截断，
                # 等于把读不完的剧本内容静默丢掉。
                if len(segments) > len(ep_shots):
                    tail = ep_shots[-1]
                    base_order = max(s.order for s in shots)
                    for _ in range(len(segments) - len(ep_shots)):
                        base_order += 1
                        clone = Shot(
                            id=uuid.uuid4().hex[:12], project_id=project_id,
                            order=base_order, episode=ep,
                            script_ref=tail.script_ref,
                            link_to_prev="continuous",
                            characters=tail.characters,
                            location=tail.location,
                            gen_prompt=tail.gen_prompt,
                            prompt_state=tail.prompt_state,
                            duration_sec=None,     # 由旁白时长回写
                            status="pending",
                        )
                        session.add(clone)
                        ep_shots.append(clone)
                        added_shots += 1
                    session.flush()   # 拿到 id 供下面绑定 source_shot_id
                pairs.extend(zip(ep_shots, segments))
            session.commit()

        # ---- 阶段二：旁白落库，与镜头 1:1 ----
        for shot, text in pairs:
            if shot.id in existing:
                skipped += 1
                continue
            if not (text or "").strip():
                no_text += 1
                continue
            session.add(AudioClip(
                id=uuid.uuid4().hex[:12], project_id=project_id,
                # 剥离 △/【】/(OS) 等标记符号：TTS 会**照着念**（实测 21 条
                # 旁白"原文字数/时长"标准差仅 0.303，剔标记后飙到 1.623），
                # 而字幕文本必须等于被念出来的文本才对得齐。只删符号不删字。
                kind="narration", text=strip_script_markup(text),
                url=None, duration=0.0,
                start_shot_order=shot.order, start_offset_sec=0.0,
                source_shot_id=shot.id,
                voice_ref_url=voice,
                status="pending", created_at=now,
            ))
            created += 1
        session.commit()

        # 覆盖率：本次要生成的这几集，剧本有多少字最终进了旁白。
        # 掉到 1.0 以下就意味着有文字没人念——930 那次是 0.48（整整一集消失）。
        want_chars = sum(len(spoken_chars(chapters.get(ep, "")))
                         for ep in want_eps)
        got_chars = sum(len(spoken_chars(t)) for _s, t in pairs)

    return {"created": created, "skipped_existing": skipped,
            "shots_without_text": no_text,
            # 为装下全部旁白而补建的镜头数（解说剧里旁白驱动镜头，不是反过来）
            "added_shots": added_shots,
            # 因"一镜读不完"而被拆开的原镜头数（Part C 生效后应接近 0）
            "split_shots": split_shots,
            #: by_shot = 旁白与镜头 1:1（正确路径）；
            #: by_chapter_fallback = 老项目没有 script_ref，按集正文重切
            "mode": "by_shot" if by_shot else "by_chapter_fallback",
            "coverage": round(got_chars / want_chars, 4) if want_chars else None,
            # 按项目分辨率算出的单镜上限（前端据此解释"为什么切了这么多镜"）
            "max_sec_per_clip": round(max_sec, 1),
            "megapixels": mp,
            # 旧旁白是在"符号剥离"上线**之前**建的，文本里仍含 △/【】/(OS)，
            # 音频也已经把它们念出来了。重合成要花 TTS 的钱，所以不自动重跑，
            # 只如实告知——不提示的话用户永远不会知道为什么有些旁白怪怪的。
            "legacy_markup_hint": (
                f"有 {skipped} 段旁白是此前生成的，文本里可能仍含 △/【】/(OS) 等标记"
                "并已被念进音频。如需修正请用「重新生成（覆盖）」重合成。"
                if skipped else None),
            "episodes": sorted(want_eps)}


def _audio_out(a) -> dict:
    return {"id": a.id, "kind": a.kind, "text": a.text, "url": a.url,
            "duration": a.duration, "start_shot_order": a.start_shot_order,
            "start_offset_sec": a.start_offset_sec,
            "voice_ref_url": a.voice_ref_url,
            "source_shot_id": getattr(a, "source_shot_id", None),
            # 6.9 修剪窗口。NULL 原样送出，**不要**在这里折成 0 / duration ——
            # 前端要靠 clip_dur_sec 是不是 null 来判断"这条被剪过没有"
            # （决定是否显示还原按钮）。在序列化时补默认值，那个信息就没了。
            "clip_in_sec": getattr(a, "clip_in_sec", None),
            "clip_dur_sec": getattr(a, "clip_dur_sec", None),
            "status": a.status, "error": a.error}


@router.get("/projects/{project_id}/audio-clips")
def list_audio_clips(project_id: str) -> dict:
    from ..db import AudioClip
    with get_session() as session:
        rows = (session.query(AudioClip)
                .filter(AudioClip.project_id == project_id)
                .order_by(AudioClip.start_shot_order, AudioClip.start_offset_sec).all())
        from ..providers.tts import TTSProvider
        return {"clips": [_audio_out(a) for a in rows],
                "tts_available": TTSProvider().available}


@router.post("/audio-clips")
def create_audio_clip(body: AudioClipIn) -> dict:
    """新建音频段。tts / narration：status=pending 等 job 合成；music：直接 done。

    `narration` 是 2026-10-16 放开的（此前只认 tts/music）。它存在的理由只有一个：
    拆分流偶尔会漏掉某一镜（剧本里那段没有可念的原文、或分段时被合并到邻镜），
    而**旁白是这一镜时长的唯一依据**，漏了就得让用户手工补一段，否则那一镜
    永远停在 AI 拆镜时的判定长度上。补出来的段与自动切的完全同构
    （同样带 `source_shot_id`），后续合成、回写时长、剪映分轨一视同仁。
    """
    from datetime import datetime, timezone
    from ..db import AudioClip
    from ..script_import import strip_script_markup
    #: `sfx`（2026-10-23 加）：音效段。与 music 同构 —— 都是"用户定了 url 的素材，
    #: 直接 done、不需要合成"。加它是因为 agent 没有音效工具，
    #: 而用户在需求里写「要配音效」时 agent 只能如实说"没有这个能力"。
    if body.kind not in ("tts", "music", "narration", "sfx"):
        raise HTTPException(status_code=400,
                            detail="kind 只能是 tts/music/narration/sfx")
    if body.kind in ("tts", "narration") and not (body.text or "").strip():
        raise HTTPException(status_code=422, detail=f"{body.kind} 需要 text")
    if body.kind in ("music", "sfx") and not (body.url or "").strip():
        raise HTTPException(status_code=422, detail=f"{body.kind} 需要 url")
    with get_session() as session:
        if not session.get(Project, body.project_id):
            raise HTTPException(status_code=404, detail="project not found")
        src_shot = None
        if body.kind == "narration" and body.source_shot_id:
            from ..db import Shot
            src_shot = session.get(Shot, body.source_shot_id)
            # 锚定的镜头必须属于同一个项目：否则会造出一条"旁白挂在别人项目
            # 的镜头上"的段，合成时 `_sync_shot_duration` 跑到别的项目去改时长。
            if src_shot is None or src_shot.project_id != body.project_id:
                raise HTTPException(status_code=404, detail="镜头不在这个项目里")
        a = AudioClip(
            id=uuid.uuid4().hex[:12], project_id=body.project_id, kind=body.kind,
            text=strip_script_markup(body.text or "") or None, url=body.url,
            duration=max(0.0, body.duration or 0.0),
            # 带锚定镜头时以镜头为准：手工补的旁白若还让调用方自己填 order，
            # 两边一不一致就是一条静默错位的旁白（字幕对不上声音）。
            start_shot_order=(src_shot.order if src_shot is not None else
                              _clamp_anchor(session, body.project_id,
                                            body.start_shot_order)),
            start_offset_sec=max(0.0, body.start_offset_sec),
            source_shot_id=(src_shot.id if src_shot is not None else None),
            voice_ref_url=body.voice_ref_url,
            status="done" if body.kind in ("music", "sfx") else "pending",
            created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        )
        session.add(a)
        session.commit()
        return _audio_out(a)


@router.patch("/audio-clips/{clip_id}")
def patch_audio_clip(clip_id: str, body: AudioClipPatch) -> dict:
    from ..db import AudioClip
    with get_session() as session:
        a = access.req_audio_clip(session, clip_id)
        if body.start_shot_order is not None:
            a.start_shot_order = _clamp_anchor(session, a.project_id,
                                               body.start_shot_order)
        if body.start_offset_sec is not None:
            a.start_offset_sec = max(0.0, body.start_offset_sec)
        # 6.9 修剪。顺序是承重的：先 clear、再 in、最后 dur ——
        # dur 的上界取决于 in（剪掉的头越长，剩下能播的就越短），
        # 反过来先算 dur 就会拿旧的 in 去夹持，一次同时改两头的修剪会被夹错。
        if body.clear_clip:
            a.clip_in_sec = None
            a.clip_dur_sec = None
        # 音源总长。0 表示"还没探测出来"（素材池音频、或仍在合成中），
        # 这时**不夹上界** —— 夹了就会把任何修剪都压成 0.1 秒。
        src = float(a.duration or 0.0)
        if body.clip_in_sec is not None:
            v = max(0.0, round(float(body.clip_in_sec), 2))
            a.clip_in_sec = min(v, src) if src > 0 else v
        if body.clip_dur_sec is not None:
            a.clip_dur_sec = max(0.1, round(float(body.clip_dur_sec), 2))
        # 末尾统一夹一次 `dur ≤ 总长 - 入点`，**不能**只在收到 clip_dur_sec 时夹。
        # 只推入点的那种改法（拖左边缘）本身不带 dur，可库里那个 dur 是按旧入点
        # 算的，右移入点之后它就超出音源尾巴了 —— 导出 `-ss 12 -t 10` 打在一个
        # 12 秒的文件上，取到的是空。这一步是"这条记录自身自洽"的最后一道，
        # 与"这次请求带了什么"无关，所以放在两个分支之外。
        if src > 0 and a.clip_dur_sec is not None:
            room = max(0.1, src - float(a.clip_in_sec or 0.0))
            a.clip_dur_sec = round(min(float(a.clip_dur_sec), room), 2)
        # 改文本 → status 回 pending，等下一次合成覆盖旧音频。
        #
        # ⚠️ `narration` 与 `tts` **一视同仁**（2026-10-16 放开）。此前这里只认
        # `kind == "tts"`，于是解说剧的旁白"看得到、改不了"——而旁白恰恰是最需要
        # 改的一类：它是**剧本原文照读**，剧本里一处笔误就会被念进成片。
        # 当时排除 narration 大概是担心"改了文本但旁白不重合成会声画不齐"，
        # 但那个担心由下一行 `status = "pending"` 就解决了：改完必须重合成，
        # 重合成时 `_sync_shot_duration` 会按新音频长度回写镜头时长，仍然对齐。
        if body.text is not None and a.kind in ("tts", "narration"):
            new_text = body.text.strip()
            if not new_text:
                # 空文本 = 清掉这段旁白（不是"改成空的"）。TTS 念不了空串，
                # 留着它只会在合成时报错。这与 `create_audio_clip` 拒绝空 text
                # 是同一条约束的两端。
                session.delete(a)
                session.commit()
                return {"ok": True, "deleted": True, "id": clip_id}
            if new_text != a.text:
                a.text = new_text
                a.status = "pending"  # 文本变了需重新合成（旧音频保留到重合成覆盖）
        session.commit()
        return _audio_out(a)


def _narration_target_shots(session, project_id: str, clip) -> dict:
    """这段旁白锚在哪一镜、那镜现在多长、能到多长 —— 供界面显示"会不会被钳"。"""
    from ..db import Project, Shot, profile_of
    from ..shot_timing import shot_seconds_cap
    out: dict = {"shot_id": None, "shot_order": None, "shot_duration": None,
                 "cap_sec": None, "clamped": False}
    if not getattr(clip, "source_shot_id", None):
        return out
    shot = session.get(Shot, clip.source_shot_id)
    if shot is None:
        return out
    proj = session.get(Project, shot.project_id)
    cap, _mp = shot_seconds_cap(profile_of(proj))
    out.update(shot_id=shot.id, shot_order=shot.order,
               shot_duration=shot.duration_sec, cap_sec=cap,
               # 界面要能提前警告："这段念完要 18s，而本镜最多 12s，
               # 多出来的会盖到下一镜" —— 不说的话用户看着时长没变会以为没生效
               clamped=bool(clip.duration and clip.duration + 0.4 > cap))
    return out


class NarrationTextIn(BaseModel):
    #: 新的旁白文本；空串 = 删掉这段旁白
    text: str


@router.put("/audio-clips/{clip_id}/narration-text")
def set_narration_text(clip_id: str, body: NarrationTextIn) -> dict:
    """改一段解说旁白的文本，并让它**立刻**跟着重新算镜头时长。

    为什么单开一个端点而不复用 `PATCH /audio-clips/{id}`：那个端点只把
    `status` 打回 pending、等用户再点一次合成；而旁白的文本改了之后，
    **镜头时长就已经不对了**（旁白多长画面就该多长）。让界面为了"改一句话"
    走"改文本 → 点合成 → 等 job → 再刷新"三步，中间那段声画不齐的状态
    会真实存在几分钟。这里一次请求把两件事做完。

    合成仍走 `tts_batch` job（不在这里同步跑）：TTS 单段要几十秒，
    在请求里跑会把接口挂住。返回体里的 `needs_sync` 告诉界面去提交那个 job。

    幂等：文本没变则什么都不做（不白清音频、不白标 stale）。
    """
    from ..script_import import strip_script_markup
    with get_session() as session:
        a = access.req_audio_clip(session, clip_id)
        if a.kind != "narration":
            raise HTTPException(status_code=400,
                                detail="这个端点只改解说旁白（kind=narration）")
        text = strip_script_markup(body.text or "").strip()
        if not text:
            # 删掉这段旁白：镜头时长不再由它决定，把时长还给"AI 拆镜的判定值"
            # —— 不还的话这一镜会永远停在上一段旁白撑出来的长度上。
            shot_id = a.source_shot_id
            session.delete(a)
            session.commit()
            return {"ok": True, "deleted": True, "id": clip_id,
                    "needs_sync": False, "shot_id": shot_id}
        changed = text != (a.text or "")
        if changed:
            a.text = text
            a.status = "pending"        # 必须重合成：旧音频念的是旧文本
            a.url = None                # 旧音频作废，免得"改了字但听还是旧的"
            a.duration = 0.0
            session.commit()
        info = _narration_target_shots(session, a.project_id, a)
        return {"ok": True, "id": a.id, "text": a.text,
                "changed": changed, "status": a.status,
                # 文本变了就必须重合成 → 界面据此提交 tts_batch
                "needs_sync": changed,
                "est_sec": _estimate_tts(a.text or ""),
                **info}


def _estimate_tts(text: str) -> float:
    """估算这段文本念出来要多久（不调模型、不花钱）。

    与拆镜阶段用的是**同一个** `estimate_tts_seconds` —— 两处各估一套必然漂移，
    而这里给出的数会被界面拿去和单镜上限比"会不会盖到下一镜"。
    """
    from ..script_import import estimate_tts_seconds
    try:
        return round(float(estimate_tts_seconds(text or "")), 2)
    except Exception:      # noqa: BLE001 估不出来不该让保存失败
        return 0.0


@router.delete("/audio-clips/{clip_id}")
def delete_audio_clip(clip_id: str) -> dict:
    from ..db import AudioClip
    with get_session() as session:
        a = access.req_audio_clip(session, clip_id)
        session.delete(a)
        session.commit()
    return {"ok": True}


class DetachAudioIn(BaseModel):
    project_id: str
    #: 只处理这些镜头；空/缺省 = 整个项目里所有还没剥过的、且有音轨的镜头
    shot_ids: list[str] | None = None


@router.post("/shots/detach-audio")
async def detach_shot_audio(body: DetachAudioIn) -> dict:
    """把镜头视频里的音轨剥成独立音频段，落在音频轨上可单独编辑。

    幂等：已经剥过的镜头（存在 source_shot_id 指向它的音频段）直接跳过，
    不会重复生成——否则同一镜头点两次就会有两条音频段，导出时叠加成双声。

    剥离后该镜头的**原音轨会在导出时自动静音**（依据就是这条音频段的存在，
    见 db.py AudioClip.source_shot_id），所以声音不会响两遍。
    删掉音频段则静音自动解除。
    """
    from datetime import datetime, timezone
    from ..db import AudioClip, Shot
    from ..media import extract_audio

    with get_session() as session:
        if not session.get(Project, body.project_id):
            raise HTTPException(status_code=404, detail="project not found")
        q = session.query(Shot).filter(Shot.project_id == body.project_id)
        if body.shot_ids:
            q = q.filter(Shot.id.in_(body.shot_ids))
        shots = q.order_by(Shot.order).all()
        # 已剥过的镜头集合，用于幂等跳过
        done_ids = {
            r[0] for r in session.query(AudioClip.source_shot_id)
            .filter(AudioClip.project_id == body.project_id,
                    AudioClip.source_shot_id.isnot(None)).all()
        }
        todo = [(s.id, s.order, s.video_url, s.clip_in_sec, s.clip_dur_sec)
                for s in shots
                if s.video_url and s.id not in done_ids and not s.disabled]

    created, skipped, no_audio = [], len(shots) - len(todo), 0
    for shot_id, order, video_url, cin, cdur in todo:
        got = await extract_audio(video_url, in_sec=cin, dur_sec=cdur)
        if got is None:          # 该镜头本来就没有音轨
            no_audio += 1
            continue
        url, dur = got
        with get_session() as session:
            a = AudioClip(
                id=uuid.uuid4().hex[:12], project_id=body.project_id,
                kind="shot", text=None, url=url, duration=dur,
                # 锚在自己这一镜的镜头首，偏移 0 —— 与视频天然对齐
                start_shot_order=order, start_offset_sec=0.0,
                source_shot_id=shot_id, status="done",
                created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            )
            session.add(a)
            session.commit()
            created.append(_audio_out(a))

    return {"created": created, "created_count": len(created),
            "skipped_existing": skipped, "no_audio": no_audio}




# ---------- TB-07 音频素材库（BGM / 音效）----------
#: 设计偏离说明：方案原本设想 `GET /audio-library?kind=bgm|sfx` 是一个**平台内置
#: 曲库**。但本项目没有任何版权音乐资产，凭空返回一批曲目要么是假数据、要么是
#: 侵权外链，两者都比"没有"更糟。因此这里把它实现为**项目自有音频素材库**：
#: 复用已有的 media_clips（用户上传的音频），按用途打标签后分组返回。
#: 用户从素材面板传入自己的 BGM/音效，即可在音频面板按类别取用。
_AUDIO_TAG_KEY = "fw_audio_tag:"      # 存进 MediaClip.name 前缀太脏，改用独立表更好，
#: 但为了不再加一张表，标签放在 kind 上：audio(未分类) / audio_bgm / audio_sfx。


@router.get("/projects/{project_id}/audio-library")
def audio_library(project_id: str, kind: Optional[str] = None) -> dict:
    """项目音频素材库，按用途分组（bgm / sfx / 未分类）。

    数据源是用户上传的音频（media_clips），不是内置曲库——本项目没有可分发的
    版权音乐，给假曲目不如如实呈现"你自己传了什么"。
    """
    from ..db import MediaClip
    with get_session() as session:
        q = (session.query(MediaClip)
             .filter(MediaClip.project_id == project_id,
                     MediaClip.kind.in_(("audio", "audio_bgm", "audio_sfx"))))
        rows = q.order_by(MediaClip.created_at).all()

    def _tag(c) -> str:
        return {"audio_bgm": "bgm", "audio_sfx": "sfx"}.get(c.kind, "unsorted")

    items = [{"id": c.id, "name": c.name, "url": c.url, "duration": c.duration,
              "size": c.size, "tag": _tag(c)} for c in rows]
    if kind in ("bgm", "sfx", "unsorted"):
        items = [i for i in items if i["tag"] == kind]
    return {
        "items": items,
        "counts": {
            "bgm": sum(1 for i in items if i["tag"] == "bgm"),
            "sfx": sum(1 for i in items if i["tag"] == "sfx"),
            "unsorted": sum(1 for i in items if i["tag"] == "unsorted"),
            "total": len(items),
        },
    }


class AudioTagIn(BaseModel):
    tag: str      # bgm | sfx | unsorted


@router.patch("/clips/{clip_id}/audio-tag")
def set_audio_tag(clip_id: str, body: AudioTagIn) -> dict:
    """给音频素材打用途标签（BGM / 音效 / 未分类）。"""
    from ..db import MediaClip
    mapping = {"bgm": "audio_bgm", "sfx": "audio_sfx", "unsorted": "audio"}
    if body.tag not in mapping:
        raise HTTPException(400, "tag 只能是 bgm/sfx/unsorted")
    with get_session() as session:
        c = access.req_media_clip(session, clip_id)
        if not (c.kind or "").startswith("audio"):
            raise HTTPException(400, "只有音频素材可以打用途标签")
        c.kind = mapping[body.tag]
        session.commit()
        return {"ok": True, "id": c.id, "tag": body.tag}
