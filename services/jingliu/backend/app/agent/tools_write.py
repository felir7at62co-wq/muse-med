"""写工具：改数据，**不花钱或花小钱**（文本类）。

与 `tools_gen.py` 的分界：这里的工具**不提交图片/视频生成任务**。
它们的共同点是「立刻改一行数据」或「提交一个纯文本 job」。

⚠️ 所有工具都必须经过 `executor.execute_tool`（它负责权限/审批/审计），
本模块不自己判断权限。
"""
from __future__ import annotations

import json
import logging
from typing import Literal

from ..db import Asset, AssetStage, Project, Shot, get_session
from ..shot_timing import (episode_total_sec, shot_output_sec,
                           shot_override_ceiling)
from .executor import ToolCtx, ToolDenied
from .registry import engine_tool, submit_idempotent

logger = logging.getLogger("fw.agent.tools.write")


def _episode_total(session, project_id: str, episode: int | None) -> float:
    """整集（或全片）在成片里的总时长。口径见 `shot_timing.episode_total_sec`。"""
    q = session.query(Shot).filter(Shot.project_id == project_id)
    if episode is not None:
        q = q.filter(Shot.episode == int(episode))
    return episode_total_sec(q.all())



@engine_tool(
    name="patch_shot",
    risk="write",
    role="editor",
    description="改单镜的拆解字段（剧本段落 / 出场角色 / 场景 / 道具 / 时长 / 与上一镜的衔接）。不调模型、不花钱。写进去的角色/场景/道具若在要素页还没有，会自动建好资产行（不出图，出图用 run_asset_fill），结果的 assets_created 列出新建了哪些。link_to_prev：true = 与上一镜连续（同一场戏接着演），false = 换场/转场。duration_sec 是**下次生成**的目标时长，不剪已出的片（剪片用 cut_shot_range / patch_shot_timeline 的取片窗口，压时长用变速）。改完会把镜头标为 stale：它身上已有的镜头脚本是按旧拆解写的，**不会自动重写**——由你重写后用 set_shot_prompt(lock=true) 写入并锁定，stale 随之清除。",
)
async def patch_shot(ctx: ToolCtx, shot_id: str,
                     script_ref: str | None = None,
                     characters: list[str] | None = None,
                     location: str | None = None,
                     props: list[str] | None = None,
                     duration_sec: float | None = None,
                     link_to_prev: bool | None = None) -> dict:
    from .. import shot_edit
    from .. import stale as stale_mod

    try:
        link = shot_edit.link_of(link_to_prev)
    except shot_edit.EditError as e:
        return e.as_result()

    changed: list[str] = []
    with get_session() as s:
        sh = s.get(Shot, shot_id)
        if not sh or sh.project_id != ctx.project_id:
            return {"ok": False, "error": "镜头不存在或不属于本项目"}
        if script_ref is not None:
            v = script_ref.strip()
            if v and v != sh.script_ref:
                sh.script_ref = v
                changed.append("script_ref")
        if characters is not None:
            sh.characters = json.dumps([c for c in characters if c], ensure_ascii=False)
            changed.append("characters")
        if location is not None:
            sh.location = location.strip() or None
            changed.append("location")
        if props is not None:
            sh.props = json.dumps([p for p in props if p], ensure_ascii=False)
            changed.append("props")
        if link is not None and link != sh.link_to_prev:
            sh.link_to_prev = link
            changed.append("link_to_prev")
        warnings: list[str] = []
        if duration_sec is not None:
            want = float(duration_sec)
            got, warnings = _clamp_agent_duration(s, sh, want)
            sh.duration_sec = got
            changed.append("duration_sec")
        if changed:
            stale_mod.mark_stale(sh, "reprompt")
        # 镜头上写了名字、资产表里却没有 → 补建资产行（与拆解同一份规则）。
        # 不补的话，绕过拆解逐镜建剧的项目要素页是空的，出片也注入不了参考图
        # （2026-11-03 生产「西北婚约125」：11 镜有提示词、0 个资产）。
        from ..asset_seed import ensure_assets
        created = ensure_assets(
            s, sh.project_id,
            characters=characters or (),
            locations=[location] if location else (),
            props=props or ())
        s.commit()
        # 改了 location / link_to_prev → 连续段切分可能变（2026-10-22）
        if {"location", "link_to_prev"} & set(changed):
            from ..continuity import invalidate_run_cache
            invalidate_run_cache(sh.project_id)
    out = {"ok": True, "shot_id": shot_id, "changed": changed,
           "stale": bool(changed),
           "note": ("已标为过期（stale）：这一镜已有的镜头脚本是按旧拆解写的，"
                    "重写后用 set_shot_prompt(lock=true) 写入并锁定，stale 随之清除"
                    if changed else "没有字段变化")}
    if duration_sec is not None:
        out["duration_sec"] = got
    if warnings:
        out["warnings"] = warnings
    if created:
        out["assets_created"] = created
    return out


def _clamp_agent_duration(s, sh, want: float) -> tuple[float, list[str]]:
    """agent 改时长的钳制：**只硬钳平台物理上限，台词侧不设限**。

    上限必须硬钳：超过模型单镜上限的数字会被厂商静默截断，而时间轴仍按
    下发值排——画面早停、后面全部错位，且不报错（`shot_seconds_cap` 头注释）。
    这是物理约束，不是判断。

    台词侧**什么都不做**（2026-10-24 用户裁定）。此前这里按平台常数 3.1 字/秒
    算一个"台词下限"，低于它就回一条警告。问题是：

      · 拿 74 个**已正常出片**的带台词镜头反查，这条线把 40 个（54%）判成"念不完"
        —— 而它们全都出片成功；3.1 恰好是这批镜头的**中位数**，拿中位数当下限，
        必然判掉一半。
      · 实测跨度 1.80~4.76 字/秒，项目之间也不一样，单个常数不可能对。

    用户的裁定是「工具可以多，限制一定要少设」。所以这里只保留物理上限，
    把"这个时长够不够念完"交还给模型——它读得到 `dialogue_chars` 和本项目的
    `measured_cps`，比一个平台常数更有资格判断。
    """
    from .shot_facts import model_cap_sec

    warns: list[str] = []
    val = max(1.0, want)
    cap = model_cap_sec(sh.project_id, s)
    if cap and val > cap:
        warns.append(f"当前视频模型单镜最长 {cap:.1f}s，已按 {cap:.1f}s 写入；"
                     f"内容装不下就用 split_shot 拆开")
        val = cap
    return round(val, 1), warns


def _current_prompt(sh) -> tuple[str, dict, bool]:
    ov = json.loads(sh.profile_override) if sh.profile_override else {}
    manual = sh.prompt_state == "manual" or bool(ov.get("prompt"))
    return (ov.get("prompt") or sh.gen_prompt or ""), ov, manual


def _write_prompt(sh, ov: dict, text: str, *, lock: bool, was_manual: bool) -> str:
    """把新稿写回镜头，返回 prompt_state。set_shot_prompt / edit_shot_prompt 共用。"""
    from .. import stale as stale_mod
    sh.gen_prompt = text
    if lock or was_manual:
        # 手改稿上只能继续是手改稿：出片只认 override.prompt，
        # 只改 gen_prompt 等于这次修改出片时完全不生效（且不报错）。
        sh.prompt_state = "manual"
        ov["prompt"] = text
        sh.profile_override = json.dumps(ov, ensure_ascii=False)
        # 锁定稿是写稿的人对着**当前**拆解与资产写定的 → 「脚本基于旧拆解」这件事
        # 到此了结，过期标记一并清掉（2026-11-19）。此前这里不清：改过拆解的镜头
        # 重写并锁定之后仍挂着「已过期」，调用方无从知道哪些镜头真的还没重写。
        stale_mod.clear_stale(sh)
        return "manual"
    # 底稿（未锁定）：只是存一份草稿，**出片不会用它**（出片只认锁定稿）。
    # reprompt 降到 regen（稿子已按新拆解写过，只是还没锁定、片子也还是旧的）；
    # rebreak 不动——切分错了，稿子再对也没用。
    sh.prompt_state = "draft"
    if sh.stale:
        sh.stale_reason = stale_mod.after_reprompt(sh.stale_reason)
    return "draft"


_NOTE_LOCKED = "已写入并锁定：出片时原样发送；这一镜的过期标记（stale）已清除"
_NOTE_DRAFT = ("只存了未锁定的底稿：**出片不会用它**（出片只认锁定的镜头脚本）；"
               "确认后用 lock=true 再写一次以锁定")
_SCENE_GATE_HINT = ("镜头脚本要对着场景图写：先用 run_asset_fill(kinds=[\"location\"]) 或 "
                    "run_asset_generate 把这些场景的图出好（get_episode_readiness 看进度），再锁定。"
                    "确属特殊情况（这一镜不需要场景图）传 allow_missing_scene_assets=true")


def _flag(value) -> bool:
    """严格解读「放行」类开关（见 `shot_edit.flag`）：字符串 "false" 不算真。"""
    from ..shot_edit import flag
    return flag(value)


def _scene_gate(s, sh, cache: dict | None = None) -> dict | None:
    """锁定镜头脚本前的闸门：这一镜的场景资产没有可用的图 → 返回一条说明，否则 None。

    判据与 `get_episode_readiness` 同一个函数（`readiness.scene_image_status`）。
    镜头没写场景时不拦：没有可对着写的场景，不在这条规则之内。
    """
    from ..readiness import SCENE_REASON_CN, scene_image_status

    st = scene_image_status(s, sh, cache=cache)
    if st["has_image"] is not False:
        return None
    return {"shot_id": sh.id, "order": sh.order, "location": st["location"],
            "scene": st["scene"], "reason": st["reason"],
            "reason_text": SCENE_REASON_CN.get(st["reason"] or "", "场景资产没有可用的图")}


def _scene_gate_error(missing: list[dict]) -> str:
    scenes = list(dict.fromkeys(m["scene"] or m["location"] or "" for m in missing))
    shown = "、".join(f"「{x}」" for x in scenes[:8]) + ("…" if len(scenes) > 8 else "")
    return (f"{len(missing)} 个镜头的场景资产还没有可用的图（{shown}），镜头脚本没有锁定。"
            "先把场景图出好再锁定；确属特殊情况传 allow_missing_scene_assets=true")


@engine_tool(
    name="revise_asset_prompt",
    risk="generate",
    role="editor",
    costs=True,
    description="按**意图**改某个资产的生图提示词（角色/场景/道具）。instruction 用一句话说清要改什么，例如「衣服换成米色羊毛大衣」「背景去掉霓虹灯」。返回 before/after 对照。按一次文本操作计费。改前建议先 preview_prompt 看一眼现在的稿子。⚠️ 改的是资产本身的稿；角色有造型时出片用的是造型的图，造型不读这份稿——要改造型的出图，把改好的稿传给 run_asset_generate(stage_id=…, prompt=…)，只改着装用 upsert_stage 的 description。",
)
async def revise_asset_prompt(ctx: ToolCtx, asset_id: str, instruction: str,
                              save: bool = True) -> dict:
    from ..prompt_revise import revise_asset_prompt as _revise

    with get_session() as s:
        a = s.get(Asset, asset_id)
        if not a or a.project_id != ctx.project_id:
            return {"ok": False, "error": "资产不存在或不属于本项目"}
    return await _revise(asset_id, instruction, save=save)


@engine_tool(
    name="edit_shot_prompt",
    risk="write",
    role="editor",
    description="按原文片段修改某镜的视频提示词：edits = [{old: 原文里的一段（原样复制）, new: 换成什么}]，"
                "其余部分保持不动。适合只动其中几句的情况；new 留空即删掉那一段。"
                "一镜的多处修改可以一次传完。旧稿记在结果 previous_prompt 里。",
)
async def edit_shot_prompt(ctx: ToolCtx, shot_id: str, edits: list[dict],
                           reason: str = "") -> dict:
    from ..prompt_sanitize import strip_editor_chrome

    if not edits:
        return {"ok": False, "error": "edits 为空"}
    with get_session() as s:
        sh = s.get(Shot, shot_id)
        if not sh or sh.project_id != ctx.project_id:
            return {"ok": False, "error": "镜头不存在或不属于本项目"}
        before, ov, was_manual = _current_prompt(sh)
        if not before.strip():
            return {"ok": False, "error": "这一镜还没有提示词，没有可改的原文"}
        text = before
        for i, e in enumerate(edits):
            old = (e or {}).get("old") or ""
            new = strip_editor_chrome((e or {}).get("new") or "")
            n = text.count(old) if old else 0
            if n != 1:
                return {"ok": False, "error":
                        f"第 {i + 1} 处修改的 old 在当前提示词里出现了 {n} 次，不知道该换哪一处。"
                        "请从 read_shots 返回的原文里原样复制，并多带几个字使它唯一。"}
            text = text.replace(old, new, 1)
        state = _write_prompt(sh, ov, text.strip(), lock=False, was_manual=was_manual)
        s.commit()
    return {"ok": True, "shot_id": shot_id, "edits": len(edits), "prompt_state": state,
            "reason": reason or None, "previous_prompt": before,
            "note": "已局部修改底稿；它还没有锁定，出片不会用它——确认后用 set_shot_prompt(lock=true) 锁定"
                    if state == "draft" else "已修改锁定的镜头脚本；出片时原样发送"}


@engine_tool(
    name="set_shot_prompt",
    risk="write",
    role="editor",
    description="整条写入某镜的镜头脚本（视频提示词）。镜流不再自己写镜头脚本：**出片只认锁定的那一稿**。\n"
                "lock=true：写入并锁定（置为 manual），出片时原样发送，同时清掉这一镜的 stale；"
                "lock=false：只存一份未锁定的底稿，出片不会用它。\n"
                "⚠️ 镜头脚本要对着场景图写，所以锁定前这一镜的**场景资产必须已经有图**"
                "（get_episode_readiness 能看到）：没有就拒绝并返回 missing_scene_assets；"
                "确属特殊情况（这一镜不需要场景图）传 allow_missing_scene_assets=true。\n"
                "旧稿记在结果 previous_prompt 里。\n"
                "「引用写法：在提示词里写 @角色名 / @场景名 / @道具名 引用它的参考图，写 @角色名的音色 引用该角色音色；出片时自动换成模型认的 图片N / 音频N 编号。只有本镜实际送出的素材能被引用：要引用本镜还没送的角色或场景，先 set_ref_overrides 加进来（道具用 patch_shot 的 props），音色先 set_shot_voices 挂上。」",
)
async def set_shot_prompt(ctx: ToolCtx, shot_id: str, prompt: str,
                          lock: bool = False,
                          allow_missing_scene_assets: bool = False) -> dict:
    from ..prompt_sanitize import strip_editor_chrome

    text = strip_editor_chrome(prompt or "").strip()
    if not text:
        return {"ok": False, "error": "提示词不能为空"}
    with get_session() as s:
        sh = s.get(Shot, shot_id)
        if not sh or sh.project_id != ctx.project_id:
            return {"ok": False, "error": "镜头不存在或不属于本项目"}
        if lock and not _flag(allow_missing_scene_assets):
            miss = _scene_gate(s, sh)
            if miss:
                return {"ok": False, "code": "scene_assets_missing",
                        "error": _scene_gate_error([miss]),
                        "missing_scene_assets": [miss], "hint": _SCENE_GATE_HINT}
        previous, ov, was_manual = _current_prompt(sh)
        state = _write_prompt(sh, ov, text, lock=lock, was_manual=was_manual)
        still_stale = bool(sh.stale)
        s.commit()
    return {"ok": True, "shot_id": shot_id, "prompt_state": state,
            "was_manual": was_manual, "previous_prompt": previous or None,
            "stale": still_stale,
            "note": (_NOTE_LOCKED if state == "manual" else _NOTE_DRAFT)}


#: 批量写提示词一次最多多少条。超了让模型分批：单次结果太长会挤掉上下文，出错也难定位。
_BATCH_MAX = 200
#: 批量结果里每条旧稿最多带回多少字（全文太长会挤爆上下文；单条工具会带全文）。
_BATCH_PREVIOUS_CHARS = 300


def _clip(text: str | None) -> str | None:
    if not text:
        return None
    return text if len(text) <= _BATCH_PREVIOUS_CHARS else text[:_BATCH_PREVIOUS_CHARS] + "…"


@engine_tool(
    name="set_shot_prompts",
    risk="write",
    role="editor",
    description="批量整条写入多镜的镜头脚本（视频提示词；一次最多 200 镜，不花钱）。镜流不再自己写镜头脚本，"
                "一集的脚本就这样写：先 get_episode_readiness 确认场景图齐了，read_shots 读剧本原文，逐镜写好，再一次传进来。\n"
                "items = [{shot_id, prompt}]。lock=true：写入并锁定，出片时原样发送，同时清掉这些镜头的 stale"
                "（**出片只认锁定稿**，正式稿都用这个）；lock=false：只存未锁定的底稿，出片不会用它。\n"
                "⚠️ lock=true 时，场景资产还没有图的镜头会被拒绝（那几条 ok=false，并汇总在 missing_scene_assets 里），"
                "其余照常写入；确属特殊情况传 allow_missing_scene_assets=true。\n"
                "逐条独立：某一条失败不影响其余，结果里逐条列出。旧稿截取前 300 字带回。\n"
                "「引用写法：在提示词里写 @角色名 / @场景名 / @道具名 引用它的参考图，写 @角色名的音色 引用该角色音色；出片时自动换成模型认的 图片N / 音频N 编号。只有本镜实际送出的素材能被引用：要引用本镜还没送的角色或场景，先 set_ref_overrides 加进来（道具用 patch_shot 的 props），音色先 set_shot_voices 挂上。」",
)
async def set_shot_prompts(ctx: ToolCtx, items: list[dict], lock: bool = False,
                           allow_missing_scene_assets: bool = False) -> dict:
    from ..prompt_sanitize import strip_editor_chrome

    if not items:
        return {"ok": False, "error": "items 为空"}
    if len(items) > _BATCH_MAX:
        return {"ok": False, "error": f"一次最多 {_BATCH_MAX} 条，这次 {len(items)} 条，请分批"}
    results = []
    missing: list[dict] = []
    with get_session() as s:
        gate_cache: dict = {}
        for it in items:
            sid = str((it or {}).get("shot_id") or "")
            text = strip_editor_chrome((it or {}).get("prompt") or "").strip()
            if not sid or not text:
                results.append({"shot_id": sid or None, "ok": False, "error": "缺 shot_id 或 prompt"})
                continue
            sh = s.get(Shot, sid)
            if not sh or sh.project_id != ctx.project_id:
                results.append({"shot_id": sid, "ok": False, "error": "镜头不存在或不属于本项目"})
                continue
            if lock and not _flag(allow_missing_scene_assets):
                miss = _scene_gate(s, sh, cache=gate_cache)
                if miss:
                    missing.append(miss)
                    results.append({"shot_id": sid, "ok": False,
                                    "code": "scene_assets_missing",
                                    "error": _scene_gate_error([miss])})
                    continue
            previous, ov, was_manual = _current_prompt(sh)
            state = _write_prompt(sh, ov, text, lock=lock, was_manual=was_manual)
            results.append({"shot_id": sid, "ok": True, "prompt_state": state,
                            "previous_prompt": _clip(previous)})
        s.commit()
    done = sum(1 for r in results if r["ok"])
    out = {"ok": done > 0, "written": done, "failed": len(results) - done, "results": results,
           "note": (_NOTE_LOCKED if lock else _NOTE_DRAFT)}
    if missing:
        out["code"] = "scene_assets_missing"
        out["rejected"] = len(missing)
        out["missing_scene_assets"] = missing
        out["hint"] = _SCENE_GATE_HINT
        if not done:
            out["error"] = _scene_gate_error(missing)
    return out


def _asset_of(s, ctx: ToolCtx, it: dict):
    """按 asset_id，或按 kind + name 找本项目的资产（墓碑不算）。"""
    aid = str((it or {}).get("asset_id") or "")
    if aid:
        a = s.get(Asset, aid)
        return a if a is not None and a.project_id == ctx.project_id and not a.deleted_at else None
    name = str((it or {}).get("name") or "").strip()
    kind = str((it or {}).get("kind") or "").strip()
    if not name:
        return None
    q = s.query(Asset).filter(Asset.project_id == ctx.project_id, Asset.name == name,
                              Asset.deleted_at.is_(None))
    if kind:
        q = q.filter(Asset.kind == kind)
    rows = q.all()
    return rows[0] if len(rows) == 1 else None


@engine_tool(
    name="set_asset_prompts",
    risk="write",
    role="editor",
    description="批量**原样写入**资产（角色/场景/道具）的生图提示词整段终稿（一次最多 200 个，不花钱）。"
                "用户要按**自己的提示词框架**写资产图提示词时用它：先 preview_prompt 看现在的稿，"
                "写好后一次传进来；之后 run_asset_generate（不带 stage_id）生成该资产的图就用这段原文，"
                "run_asset_fill 批量补图**不读**它。\n"
                "items = [{asset_id, prompt}]，或用 {kind, name, prompt} 定位（kind: character/location/custom）。"
                "reset=true 的条目 = 撤销用户稿、交还系统自动拼装（不用传 prompt）。\n"
                "⚠️ 角色有造型时，出片用的是**造型的图**，而造型不读这里的整段稿：要让造型按你的稿出图，"
                "调 run_asset_generate(stage_id=…, prompt=整段稿)；只改着装用 upsert_stage 的 description。"
                "写到有造型的角色上时，结果里会带 warning 和各套造型的 stage_id。逐条独立，旧稿截取前 300 字带回。",
)
async def set_asset_prompts(ctx: ToolCtx, items: list[dict]) -> dict:
    from ..db import final_prompt_of
    from ..prompt_sanitize import strip_editor_chrome

    if not items:
        return {"ok": False, "error": "items 为空"}
    if len(items) > _BATCH_MAX:
        return {"ok": False, "error": f"一次最多 {_BATCH_MAX} 条，这次 {len(items)} 条，请分批"}
    results = []
    with get_session() as s:
        for it in items:
            a = _asset_of(s, ctx, it)
            label = (it or {}).get("asset_id") or (it or {}).get("name")
            if a is None:
                results.append({"asset": label, "ok": False,
                                "error": "资产不存在、不属于本项目，或同名不止一个（请改用 asset_id）"})
                continue
            previous = final_prompt_of(a)
            if (it or {}).get("reset") is True:
                a.prompt = None
                results.append({"asset_id": a.id, "name": a.name, "ok": True, "reset": True,
                                "previous_prompt": _clip(previous)})
                continue
            text = strip_editor_chrome((it or {}).get("prompt") or "").strip()
            if not text:
                results.append({"asset_id": a.id, "name": a.name, "ok": False, "error": "prompt 为空"})
                continue
            # 存量行（拆列之前）没有 desc_auto 时，`prompt` 列两义并存：读侧按形状判断，
            # 短于 400 字、没有模板句的稿会被当成「描述」而**静默不生效**。
            # 先把旧的描述挪进 desc_auto（它本来就是描述），让 prompt 只承担「用户终稿」这一义。
            if not (a.desc_auto or "").strip():
                old = (a.prompt or "").strip()
                a.desc_auto = old if old and final_prompt_of(a) is None else (a.desc_auto or a.name)
            a.prompt = text
            if final_prompt_of(a) != text:
                results.append({"asset_id": a.id, "name": a.name, "ok": False,
                                "error": "写入后读回不一致，未生效（请联系管理员）"})
                continue
            results.append({"asset_id": a.id, "name": a.name, "kind": a.kind, "ok": True,
                            "previous_prompt": _clip(previous)})
        s.commit()
    done = sum(1 for r in results if r["ok"])
    # 角色的图在出片时读的是造型：只改了角色本身的稿，造型重生成时并不会用它
    from .. import stage_gate
    with get_session() as s2:
        for r in results:
            if r.get("ok") and r.get("kind") == "character":
                sts = stage_gate.alive_stages(s2, ctx.project_id, r["name"])
                if sts:
                    r["stages"] = [{"stage_id": st.id, "stage_name": st.stage_name} for st in sts]
                    r["warning"] = (f"「{r['name']}」有 {len(sts)} 套造型，出片用的是造型的图。这段稿只存在角色上，"
                                    "补图和造型重生成都不会读它：要让造型按这段稿出图，"
                                    "调 run_asset_generate(stage_id=…, prompt=这段稿)")
    return {"ok": done > 0, "written": done, "failed": len(results) - done, "results": results,
            "note": "之后单独生成这些资产（run_asset_generate、不带 stage_id）就用写入的原文；"
                    "run_asset_fill 补图不读它；已经生成的图不会自动重画"}


@engine_tool(
    name="set_shot_override",
    risk="write",
    role="editor",
    description="设置单镜的生成参数覆盖：视频模型 model_id、生成模式 generation_mode（full_reference 全能参考 / t2va 纯文本）；clear 列出要清掉的键。只影响这一镜之后的生成。改本镜送哪些角色/场景参考图用 set_ref_overrides，改提示词用 set_shot_prompt / edit_shot_prompt。",
)
async def set_shot_override(ctx: ToolCtx, shot_id: str,
                            model_id: str | None = None,
                            generation_mode: str | None = None,
                            clear: list[str] | None = None) -> dict:
    # 首帧 / 首尾帧 / 尾帧三种模式与「指定首帧图」已于 2026-11-20 下线：要指定开头或
    # 结尾画面，用 set_ref_overrides / 参考图把那张图加进本镜。
    from ..providers.base import GENERATION_MODES
    if generation_mode is not None and generation_mode not in GENERATION_MODES:
        return {"ok": False,
                "error": f"不支持的生成模式 {generation_mode}；可选：{'、'.join(GENERATION_MODES)}"
                         "（首帧 / 首尾帧 / 尾帧模式已下线，要指定开头或结尾画面请把图作为参考图加进本镜）"}
    with get_session() as s:
        sh = s.get(Shot, shot_id)
        if not sh or sh.project_id != ctx.project_id:
            return {"ok": False, "error": "镜头不存在或不属于本项目"}
        ov = json.loads(sh.profile_override) if sh.profile_override else {}
        touched: list[str] = []
        for k, v in (("model_id", model_id),
                     ("generation_mode", generation_mode)):
            if v is not None:
                ov[k] = v
                touched.append(k)
        for k in (clear or []):
            ov.pop(k, None)
            touched.append(f"-{k}")
        # ⚠️ 不要动 ov["prompt"]：那是用户手写的提示词，与生成参数是两件事。
        sh.profile_override = json.dumps(ov, ensure_ascii=False) if ov else None
        s.commit()
    return {"ok": True, "shot_id": shot_id, "changed": touched, "override": ov}


@engine_tool(
    name="set_ref_overrides",
    risk="write",
    role="editor",
    description="人工增删某镜要注入的参考图角色/场景（压过 AI 判定）。"
                "add/remove 是角色名；add_loc/remove_loc 是场景名。",
)
async def set_ref_overrides(ctx: ToolCtx, shot_id: str,
                            add: list[str] | None = None,
                            remove: list[str] | None = None,
                            add_loc: list[str] | None = None,
                            remove_loc: list[str] | None = None) -> dict:
    with get_session() as s:
        sh = s.get(Shot, shot_id)
        if not sh or sh.project_id != ctx.project_id:
            return {"ok": False, "error": "镜头不存在或不属于本项目"}
        ov = json.loads(sh.ref_overrides) if sh.ref_overrides else {}
        for k, v in (("add", add), ("remove", remove),
                     ("add_loc", add_loc), ("remove_loc", remove_loc)):
            if v is not None:
                ov[k] = [x for x in v if x]
        sh.ref_overrides = json.dumps(ov, ensure_ascii=False) if ov else None
        sh.refs_stale = 1
        s.commit()
    return {"ok": True, "shot_id": shot_id, "ref_overrides": ov,
            "note": "参考图集合已改，重新生成才会生效"}


#: 单镜最多挂几段参考音频。seedance 官方上限 3（`max_reference_audios`），
#: 其它通道更少的由出片时 `_merge_ref_audios` 再按通道上限截断。
_VOICE_CAP = 3


@engine_tool(
    name="set_shot_voices",
    risk="write",
    role="editor",
    description="给某镜挂上**说话角色的音色**（替换本镜已挂的角色音色；临时参考音频保留）。"
                "characters = 这一镜**真正开口**的角色名，按台词分量从重到轻，最多 3 个。"
                "谁开口要你读 read_shots 的剧本原文自己判断（speakers 只是解析参考）。"
                "返回每个角色的「音频N」编号与引用写法 `@角色名的音色`——"
                "再用 edit_shot_prompt 把它写到对应台词处（如：林七雨说：{…}，音色参考@林七雨的音色），"
                "否则音频虽然送进去了，模型不知道该把它用在谁身上。"
                "传空列表 = 清掉本镜挂的角色音色。",
)
async def set_shot_voices(ctx: ToolCtx, shot_id: str,
                          characters: list[str]) -> dict:
    from .shot_facts import VOICE_TOKEN, ProjectVoices

    want = []
    for c in (characters or []):
        c = (c or "").strip()
        if c and c not in want:
            want.append(c)
    with get_session() as s:
        sh = s.get(Shot, shot_id)
        if not sh or sh.project_id != ctx.project_id:
            return {"ok": False, "error": "镜头不存在或不属于本项目"}
        voices = ProjectVoices(s, sh.project_id)
        ov = json.loads(sh.profile_override) if sh.profile_override else {}
        old = [u for u in (ov.get("ref_audios") or []) if isinstance(u, str) and u.strip()]
        # 临时参考音频（不属于任何角色）保留在后面：那是用户自己在镜头里传的，
        # agent 换说话人不该顺手把它删掉。
        temp = [u for u in old if u not in voices.by_url]

        picked: list[tuple[str, str]] = []
        missing: list[dict] = []
        for name in want:
            canon = voices.canonical(name)
            url = voices.by_name.get(canon)
            if not url:
                missing.append({"name": name,
                                "reason": ("该角色还没有上传音色" if canon in voices.names
                                           else "资产库里没有这个角色")})
                continue
            if any(u == url for _, u in picked):
                continue
            picked.append((canon, url))
        dropped = picked[_VOICE_CAP:]
        picked = picked[:_VOICE_CAP]
        urls = [u for _, u in picked]
        urls += [u for u in temp if u not in urls][:max(0, _VOICE_CAP - len(urls))]
        if urls:
            ov["ref_audios"] = urls
        else:
            ov.pop("ref_audios", None)
        sh.profile_override = json.dumps(ov, ensure_ascii=False) if ov else None
        s.commit()

    mapping = [{"character": n, "audio_no": i + 1,
                "token": VOICE_TOKEN.format(name=n)} for i, (n, _) in enumerate(picked)]
    out = {"ok": True, "shot_id": shot_id, "voices": mapping,
           "kept_temp_audios": len([u for u in urls if u in temp])}
    if missing:
        out["missing"] = missing
    if dropped:
        out["dropped"] = [n for n, _ in dropped]
        out.setdefault("warnings", []).append(
            f"单镜最多 {_VOICE_CAP} 段音色，已舍弃：" + "、".join(n for n, _ in dropped))
    out["note"] = ("音色已挂上。下一步：把上面的 token 写进提示词对应台词处"
                   "（edit_shot_prompt），出片时会转成「音频N」。"
                   "注意：本镜若没有任何参考图/首帧（纯文生视频），seedance 不接受音频，"
                   "出片时会跳过音色并在版本记录里写明原因。") if mapping else \
                  "本镜已不挂任何角色音色（出片时仍会自动注入戏份最重的说话人音色）"
    return out


@engine_tool(
    name="adopt_version",
    risk="write",
    role="editor",
    description="把某镜切到指定历史版本（撤销换片的唯一手段）。",
)
async def adopt_version(ctx: ToolCtx, shot_id: str, version_no: int) -> dict:
    """切到历史版本：**直接调网页的同一个路由函数**（2026-10-30 改）。

    原先这里自己改 `video_url` / `adopted_version` 两列，与网页 `POST /shots/{id}/adopt`
    漂移了三处：不清取片窗口（旧窗口是相对上一个素材的坐标，成片会出黑帧）、
    不补/不换缩略图、不置 `status=adopted`；而且 commit 后读已脱离 session 的
    ORM 对象，每次都抛 DetachedInstanceError —— 这个工具从来没有成功过。
    """
    from fastapi import HTTPException

    from ..routers.shots import AdoptIn, adopt_shot_version

    with get_session() as s:
        sh = s.get(Shot, shot_id)
        if not sh or sh.project_id != ctx.project_id:
            return {"ok": False, "error": "镜头不存在或不属于本项目"}
    try:
        return await adopt_shot_version(shot_id, AdoptIn(version_no=int(version_no)))
    except HTTPException as e:
        return {"ok": False, "error": str(e.detail)}


@engine_tool(
    name="patch_shot_timeline",
    risk="write",
    role="editor",
    description="时间轴轻剪辑：改生成目标时长（duration_sec，下次出片才生效，不剪已出的片）/ 启停用 / 设置取片窗口（clip_in_sec + clip_dur_sec）"
                "/ 变速（speed，1.0=原速，>1 变快、<1 变慢）。"
                "变速**不重新生成**，只改播放速度：2 倍速时这一镜在成片里占一半时间，"
                "后面的镜头、字幕、音效会自动前移。",
)
async def patch_shot_timeline(ctx: ToolCtx, shot_id: str,
                              duration_sec: float | None = None,
                              disabled: bool | None = None,
                              clip_in_sec: float | None = None,
                              clip_dur_sec: float | None = None,
                              clear_clip: bool = False,
                              speed: float | None = None) -> dict:
    """改时长/窗口/变速。

    ## 钳制交给 HTTP 路由那一份，这里不自己再来一套（2026-10-24）

    此前 agent 侧各写了一份 `max(0.5, duration_sec)` / `max(0.5, clip_dur_sec)`，
    而 `routers/shots.patch_shot_timeline` 用的是 `max(1.0, min(ceil, …))` 与
    `max(0.1, min(ceil, …))`。同一个字段两套下限，agent 能把时长设成 0.5s
    （用户手动拖是设不出来的），导出的时间轴上就出现一个半秒的碎片。

    现在数值一律走 `_clamp_agent_duration` / 与路由相同的下限，来源只有一处。
    """
    with get_session() as s:
        sh = s.get(Shot, shot_id)
        if not sh or sh.project_id != ctx.project_id:
            return {"ok": False, "error": "镜头不存在或不属于本项目"}
        changed: list[str] = []
        warns: list[str] = []
        if duration_sec is not None:
            # 上限跟这一镜实际生效的模型走（镜头可单独换模型），下限 1.0 与
            # `routers/shots` 的 duration_sec 分支一致 —— 那是**生成目标**，
            # 不是取片窗口，窗口另有 0.1 的下限。
            sh.duration_sec, w = _clamp_agent_duration(s, sh, float(duration_sec))
            warns += w
            changed.append("duration_sec")
        if disabled is not None:
            sh.disabled = 1 if disabled else 0
            changed.append("disabled")
        if clear_clip:
            sh.clip_in_sec = None
            sh.clip_dur_sec = None
            changed += ["clip_in_sec", "clip_dur_sec"]
        elif clip_in_sec is not None or clip_dur_sec is not None:
            # 窗口是"在已有素材上取片"，下限 0.1（与路由同口径）：库里真实存在
            # 0.75s / 0.99s 的分割碎片，floor 到 0.5 会把它们拉长。
            if clip_in_sec is not None:
                sh.clip_in_sec = max(0.0, float(clip_in_sec))
                changed.append("clip_in_sec")
            if clip_dur_sec is not None:
                ceil2 = shot_override_ceiling(s, sh)
                sh.clip_dur_sec = float(max(0.1, min(float(ceil2),
                                                     float(clip_dur_sec))))
                sh.duration_sec = sh.clip_dur_sec     # ← 不变式，见 routers/shots
                changed.append("clip_dur_sec")

        if speed is not None:
            # 变速存在 `transform_meta.speed` 里，与裁剪/调色/擦字幕共用同一个 JSON。
            # **必须读-改-写**：整块覆盖会把 lut / desub / crop 一起抹掉，
            # 而用户看不到任何报错，只发现"调色没了"。
            from ..shot_timing import SPEED_MAX, SPEED_MIN, clamp_speed
            meta = {}
            try:
                meta = json.loads(sh.transform_meta) if sh.transform_meta else {}
            except (ValueError, TypeError):
                meta = {}
            if not isinstance(meta, dict):
                meta = {}
            raw = float(speed)
            spd = clamp_speed(raw)
            if raw != spd:
                clipped = (f"超出 [{SPEED_MIN}, {SPEED_MAX}]，已钳到 {spd}")
            else:
                clipped = None
            if spd == 1.0:
                meta.pop("speed", None)      # 原速 = 没有这一项，别留个 1.0 在库里
            else:
                meta["speed"] = spd
            sh.transform_meta = (json.dumps(meta, ensure_ascii=False)
                                 if meta else None)
            changed.append("speed")
            if clipped:
                changed.append(f"（{clipped}）")
        s.commit()
    return {"ok": True, "shot_id": shot_id, "changed": changed}


@engine_tool(
    name="set_shots_speed",
    risk="write",
    role="editor",
    description="批量变速：给一组镜头设同一个播放速度（1.0=原速，>1 变快）。"
                "用于「把这一集压进 100 秒」这类需求——先用 analyze_episode_duration 看"
                "现在还差多少，再挑镜头加速。**改完时长立刻生效**（不需重新出片），"
                "返回改后的整集总时长。",
)
async def set_shots_speed(ctx: ToolCtx, project_id: str,
                          speeds: dict[str, float] | None = None,
                          shot_ids: list[str] | None = None,
                          speed: float | None = None,
                          episode: int | None = None) -> dict:
    """两种用法：`speeds={shot_id: 倍数}` 逐镜给，或 `shot_ids=[...] + speed=` 统一给。

    ## 为什么不按"目标总时长"自动分配

    自动分配要决定"哪一镜加速多少"，那是对内容的判断（哪个是空镜、哪句台词
    快了会听不清）。把它做成黑盒会让用户拿到一个他无法解释的时间轴。
    这里只提供"说到做到"的执行面，判断留给模型，判断依据由
    `analyze_episode_duration` 给全。
    """
    from ..shot_timing import SPEED_MAX, SPEED_MIN, clamp_speed

    plan: dict[str, float] = {}
    if speeds:
        plan.update({str(k): v for k, v in speeds.items()})
    if shot_ids:
        if speed is None:
            return {"ok": False, "error": "给了 shot_ids 就必须同时给 speed"}
        for sid in shot_ids:
            plan[str(sid)] = speed
    if not plan:
        return {"ok": False,
                "error": "没有要改的镜头：给 speeds={shot_id: 倍数} 或 shot_ids + speed"}

    changed, skipped = [], []
    with get_session() as s:
        for sid, raw in plan.items():
            sh = s.get(Shot, sid)
            if not sh or sh.project_id != project_id:
                skipped.append({"shot_id": sid, "why": "不存在或不属于本项目"})
                continue
            try:
                target = clamp_speed(float(raw))
            except (TypeError, ValueError):
                skipped.append({"shot_id": sid, "why": f"speed 不是数字: {raw!r}"})
                continue
            meta = {}
            try:
                meta = json.loads(sh.transform_meta) if sh.transform_meta else {}
            except (ValueError, TypeError):
                meta = {}
            if not isinstance(meta, dict):
                meta = {}
            if target == 1.0:
                meta.pop("speed", None)
            else:
                meta["speed"] = target
            sh.transform_meta = json.dumps(meta, ensure_ascii=False) if meta else None
            changed.append({"shot_id": sid, "order": sh.order,
                            "speed": target,
                            "output_sec": round(shot_output_sec(sh), 2)})
        s.commit()
        total = _episode_total(s, project_id, episode)

    return {"ok": True, "changed": len(changed), "shots": changed,
            "skipped": skipped,
            "speed_range": [SPEED_MIN, SPEED_MAX],
            "episode_total_sec": total,
            "note": "变速是播放速度，不会重新出片；字幕/音效/相邻镜头会自动跟着前移。"}



@engine_tool(
    name="split_shot",
    risk="write",
    role="editor",
    description="把一镜拆开。两种拆法，**二选一**，都不调模型、不花钱：\n"
                "① 按剧本拆（改拆解）：parts = [{script_ref, duration_sec?}, …]（至少两段，按先后顺序）。"
                "第 1 段留在原镜头上（它已有的镜头脚本是针对整段写的 → 标 stale，要重写并锁定），"
                "其余每段各成一个新镜头、紧跟其后，继承原镜的集号/角色/场景/道具，没有镜头脚本。"
                "duration_sec 不给就按该段文字估。\n"
                "② 按时间切已出的片（时间轴剪辑）：at_sec = 镜内第几秒（**源秒**）。前后两段共用同一条视频、"
                "各记一段取片窗口，剧本与镜头脚本不变。只想删掉中间一段时用 cut_shot_range，不要自己手动切两次。",
)
async def split_shot(ctx: ToolCtx, shot_id: str, at_sec: float | None = None,
                     parts: list[dict] | None = None) -> dict:
    """两种语义共用一个名字（2026-11-19）。

    `at_sec` 是原有的时间轴切分（`routers.shots.split_shot`：切的是**已出片的视频**）；
    `parts` 是新增的剧本层拆分（`shot_edit.split_shot_script`：改的是**拆解**）。
    没有另起一个工具名：对模型来说两者都是"把这一镜拆开"，起两个名字它会挑错；
    用参数区分，描述里把后果说清楚。
    """
    if parts is not None and at_sec is not None:
        return {"ok": False, "error": "at_sec（按时间切已出的片）与 parts（按剧本拆）只能给一个"}
    if parts is None and at_sec is None:
        return {"ok": False, "error": "给 parts=[{script_ref, duration_sec?}, …]（按剧本拆），"
                                      "或 at_sec（按时间切已出的片）"}
    # 路由函数只校验"调用者能进那个镜头所在的项目"，不校验它属于**本次调用**的
    # 项目 —— 档位是按本项目判的，这里不比对就会拿 A 项目的档去改 B 项目。
    with get_session() as s:
        sh = s.get(Shot, shot_id)
        if not sh or sh.project_id != ctx.project_id:
            return {"ok": False, "error": f"镜头不存在: {shot_id}"}
        if parts is not None:
            from .. import shot_edit
            try:
                out = shot_edit.split_shot_script(s, ctx.project_id, shot_id, parts)
            except shot_edit.EditError as e:
                s.rollback()
                return e.as_result()
            s.commit()
            from ..continuity import invalidate_run_cache
            invalidate_run_cache(ctx.project_id)
            return out

    from fastapi import HTTPException

    from ..routers.shots import ShotSplitIn, split_shot as _split
    try:
        r = _split(shot_id, ShotSplitIn(at_sec=float(at_sec)))
    except HTTPException as e:
        return {"ok": False, "error": str(e.detail)}
    return {"ok": True, "mode": "time", **(r or {})}


@engine_tool(
    name="cut_shot_range",
    risk="write",
    role="editor",
    description="**剪掉一镜中间的一段**（真正的删，不是提速）。"
                "from_sec/to_sec 是**成片秒**（屏幕上看到的第几秒，已算进变速）。"
                "例：一镜 12 秒里第 3~6 秒只是人物在走路，cut_shot_range(3, 6) 就把它删掉，"
                "剩下 9 秒。这是压缩时长时**优先**该用的手段 —— 删掉没信息的画面"
                "既不失真也不变声，比提速好。内部会切成三段并停用中间那段。",
)
async def cut_shot_range(ctx: ToolCtx, shot_id: str,
                         from_sec: float, to_sec: float) -> dict:
    """删掉一镜中间的 `[from_sec, to_sec)`，返回三段的新镜号。

    ## 为什么要有这个工具（2026-10-24 用户要求）

    用户原话：「agent 有没有剪辑（删除）片段的能力？不能粗暴的只靠加速控制时间」。

    查下来：能力**有**，但要三步手工拼（切两刀 + 停用中间），而且没写进提示词，
    所以 agent 实际上只会用提速。它压缩时长时的做法是「全片提到 1.7 倍」——
    用户看到的是「有些片段加速竟高达 1.8 倍」，台词全部变尖、语速失真。

    提速和删片段解决的是**完全不同**的问题：
      · 提速 = 内容都要、但嫌它慢；
      · 删片段 = 这段本来就没信息（人物走路、空镜、重复动作），根本不该占时间。
    后者才是短剧压时长的主要手段。把这两件事在提示词里讲清楚，比加限制有用。

    ## `from_sec` / `to_sec` 为什么是成片秒

    模型看的是预览里的画面，它数的是"第 3 秒那个动作"。而这一镜可能已经是
    1.7 倍速 —— 成片第 3 秒对应源文件第 5.1 秒。所以这里收成片秒，
    内部乘回 speed 再交给 `split_shot`（那个工具的 `at_sec` 是源秒）。

    对外只暴露一种时间基准，模型不会记混；内部这一个换算点集中在这里。

    ## 做法：切两刀，中间那段停用

    不新造"区间删除"的存储形态 —— 停用是既有语义（`disabled=1`），
    导出、时长统计、字幕过滤都已经正确处理它（导出时停用镜头整段不进时间轴，
    锚在它上面的字幕/音频也一并跳过）。所以切成三段 + 停中间那段就够了，
    而且用户随时能在界面上把那段"恢复"回来。

    ⚠️ **两刀的先后不能反**：先切后点（`to_sec`），再切前点（`from_sec`）。
    反过来先切前点会让后半段的源窗口整体左移，第二刀的坐标就不对了。
    """
    from ..routers.shots import ShotSplitIn, split_shot as _split
    from ..shot_timing import shot_output_sec, shot_speed

    with get_session() as s:
        sh = s.get(Shot, shot_id)
        if not sh or sh.project_id != ctx.project_id:
            return {"ok": False, "error": "镜头不存在或不属于本项目"}
        if sh.disabled:
            return {"ok": False, "error": "这一镜已停用，没有可剪的画面"}
        out_sec = shot_output_sec(sh)
        spd = shot_speed(sh)

    a, b = float(from_sec), float(to_sec)
    if not (0 <= a < b):
        return {"ok": False, "error": f"要求 0 ≤ from_sec < to_sec，收到 {a} / {b}"}
    if b > out_sec + 0.05:
        return {"ok": False,
                "error": f"to_sec={b} 超出这一镜的成片时长 {out_sec:.2f}s"}
    # ⚠️ 边距判据要用**源秒**：`split_shot` 拒绝的是"离窗口边缘不足 0.5 **源秒**"。
    # 拿成片秒去比，慢镜头（speed<1）下 0.5 成片秒只有 0.25 源秒 —— 这里放过去、
    # 那边拒掉，用户看到的是一个莫名其妙的 422。
    if a * spd < 0.5 or (out_sec - b) * spd < 0.5:
        return {"ok": False,
                "error": ("剪掉的区间紧贴开头或结尾。那种情况不要用本工具："
                          f"用 patch_shot_timeline(clip_in_sec=…, clip_dur_sec=…) "
                          f"直接改取片窗口（本镜成片 {out_sec:.2f}s、{spd} 倍速）。"
                          "本工具是给「删掉中间一段」用的。")}

    # ---- 第一刀：切在 to_sec（成片秒 → 源秒）----
    try:
        r1 = _split(shot_id, ShotSplitIn(at_sec=round(b * spd, 3)))
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"第一次切分失败：{e}"}

    # ---- 第二刀：切在 from_sec。切完 order 会重排，要用返回的 head_shot_id ----
    head_id = r1.get("head_shot_id")
    try:
        r2 = _split(head_id, ShotSplitIn(at_sec=round(a * spd, 3)))
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"第二次切分失败（第一刀已生效）：{e}",
                "first_split": r1}

    # ---- 停用中间那段：第二刀的 tail 就是被删的区间 ----
    mid_id = r2.get("tail_shot_id")
    with get_session() as s:
        mid = s.get(Shot, mid_id) if mid_id else None
        if not mid:
            return {"ok": False, "error": "切分成功但找不到中间那段",
                    "first_split": r1, "second_split": r2}
        mid.disabled = 1
        s.commit()
        mid_order = mid.order

    # 剩下的两段：第二刀的 head（前段）与第一刀的 tail（后段）
    keep_orders = sorted({r2.get("head_order"), r1.get("tail_order")} - {None})
    return {
        "ok": True,
        "removed": {"order": mid_order, "sec": round(b - a, 2)},
        "kept_orders": keep_orders,
        "note": (f"已删掉第 {a}~{b} 秒（共 {round(b - a, 2)} 秒），中间那段被**停用**"
                 "——**原片一点没动**，恢复用 restore_cut 就行，随时可以退回来。"
                 "⚠️ 删之前锚在这个镜头上的字幕/音频不会自动挪："
                 "它们仍挂在原来的镜号上，偏移可能落到被停用的那一段里。"
                 "剪完请跑 list_subtitle_clips / list_audio_clips 核对一遍。"),
    }


@engine_tool(
    name="restore_cut",
    risk="write",
    role="editor",
    description="**撤销一次剪辑**，把被删掉的那段放回来。两种用法，都安全、都只是"
                "在还原用户本来就有的原片："
                "① 只回一段：restore_cut(shot_id=被停用的那一段) —— 立刻恢复它的画面；"
                "② 恢复成完整一镜：restore_cut(head_shot_id=前段, tail_shot_id=后段) —— "
                "把两段合回原来那一个镜头（切点回到 0，时长变回原样）。"
                "cut_shot_range 切出三段，所以彻底还原通常要调两次："
                "先 1+2 合、再和 3 合。每次返回的 shot_id 就是下一次的 head。",
)
async def restore_cut(ctx: ToolCtx, shot_id: str | None = None,
                      head_shot_id: str | None = None,
                      tail_shot_id: str | None = None) -> dict:
    """撤销剪辑。**原片从来没有被复制或删除过**，这里只是把镜头行的窗口拼回去。

    ## 为什么必须有这个工具（2026-10-24 用户问）

    用户原话：「剪辑过后用户想要最初的原片怎么办？剪错了 agent 还能不能拿到
    原片重新剪？」

    答案是：**原片一直都在**。`cut_shot_range` 不复制、不删除任何视频文件，
    它只是把同一个 `video_url` 拆成三行，各自记一段取片窗口
    （`clip_in_sec` / `clip_dur_sec`），并把中间那行标成 `disabled=1`。
    磁盘上那条 mp4 从头到尾没被动过 —— 所以"要回原片"根本不是恢复文件，
    而是把镜头行重新拼起来。

    但此前 **agent 侧没有任何还原工具**：`unsplit_shot` 只有 HTTP 端点，
    没注册成工具。所以 agent 剪错了就只能继续往前改（再切一刀把删掉的补回来，
    而 `split_shot` 根本切不出"恢复"这个操作）—— 等于不可逆。
    对一个会自己决策的东西，给了删除却不给撤销是不能接受的。

    ## 两条路，各有各的语义

    ① `shot_id`（单段）：把 `disabled` 清掉。适用于"我只是多剪了一刀，
       现在想把那一段放回去"，段落的划分保留，画面立刻回来。
    ② `head_shot_id` + `tail_shot_id`：调 `unsplit_shot` 把相邻两段合成一行，
       取片窗口首尾相接、时长相加。**这是真正的"变回原来那个镜头"**，
       连镜号都收回去。`unsplit_shot` 自带严格校验（相邻、同源 url、
       窗口连续、后半段没有独立版本），任何一条不满足都会 409 而不是乱合 ——
       那是好事，说明这段时间里有人动过它，硬合会吞掉那些改动。
    """
    if not shot_id and not (head_shot_id and tail_shot_id):
        return {"ok": False,
                "error": "给 shot_id（把那一段放回来），"
                         "或 head_shot_id + tail_shot_id（把两段合成一镜）"}

    # ---- ① 单段：重新启用 ----
    if shot_id and not head_shot_id:
        with get_session() as s:
            sh = s.get(Shot, shot_id)
            if not sh or sh.project_id != ctx.project_id:
                return {"ok": False, "error": "镜头不存在或不属于本项目"}
            if not sh.disabled:
                return {"ok": True, "already": True, "order": sh.order,
                        "note": "这一段本来就是启用状态，没动它"}
            sh.disabled = 0
            order = sh.order
            s.commit()
        return {"ok": True, "restored": "segment", "order": order,
                "note": (f"第 {order} 段已重新启用，画面回来了。"
                         "如果还想让它和前后合成原来那一镜，"
                         "再用 restore_cut(head_shot_id=…, tail_shot_id=…)")}

    # ---- ② 两段合一 ----
    from ..routers.shots import ShotUnsplitIn, unsplit_shot as _unsplit

    with get_session() as s:
        head = s.get(Shot, head_shot_id)
        if not head or head.project_id != ctx.project_id:
            return {"ok": False, "error": "前段不存在或不属于本项目"}
        # `unsplit_shot` 只校验"同项目"，不校验归属到调用者；这里替它补上，
        # 否则 agent 可以借着本项目的一个 id 去改别人项目的镜头。
        tail = s.get(Shot, tail_shot_id)
        if not tail or tail.project_id != ctx.project_id:
            return {"ok": False, "error": "后段不存在或不属于本项目"}
    try:
        r = _unsplit(head_shot_id, ShotUnsplitIn(tail_shot_id=tail_shot_id))
    except Exception as e:  # noqa: BLE001
        # 409 的具体文案已经写清楚了原因（"后半段已被重新生成"等），
        # 原样透出给模型，它才知道该换哪条路，而不是笼统报"失败"。
        return {"ok": False, "error": getattr(e, "detail", str(e))}
    return {"ok": True, "restored": "merged", **(r or {}),
            "note": "两段已合成一镜，切点收回。若还有第三段，"
                    "用返回的 shot_id 当 head 再来一次。"}


@engine_tool(
    name="insert_shot",
    risk="write",
    role="editor",
    description="在某一镜之后插入一个 AI 镜头（补拍、漏拆的一镜、占位），不调模型、不花钱。"
                "after_order 是**全剧镜号**：新镜头紧跟在那一镜之后（0 = 插到全剧最前）。"
                "可以一次把拆解字段写全：script_ref（这一镜的剧本原文）、characters、location、props、"
                "link_to_prev（true = 与上一镜连续，false = 换场/转场；不给时与上一镜场景相同算连续）、"
                "duration_sec（不给：有 script_ref 就按文字估，否则 5 秒）。"
                "episode 不给就跟随插入位置前一镜的集号；要插成某一集的第一镜时显式传 episode。"
                "写进去的角色/场景/道具若在要素页还没有，会自动建好资产行（不出图）。"
                "新镜头没有镜头脚本：之后用 set_shot_prompt(lock=true) 写入并锁定才能出片。"
                "要一次写一整集的镜头用 write_episode_shots。label 只是给镜头起的展示名。",
)
async def insert_shot(ctx: ToolCtx, project_id: str, after_order: int,
                      episode: int | None = None,
                      duration_sec: float | None = None,
                      label: str | None = None,
                      special_name: str | None = None,
                      script_ref: str = "",
                      characters: list[str] | None = None,
                      location: str | None = None,
                      props: list[str] | None = None,
                      link_to_prev: bool | None = None) -> dict:
    """插入一行**普通 AI 镜头**。

    ## 位置交给 `POST /v2/shots/insert` 那一份（2026-11-19）

    此前这里自己排位置：`from ..shots_order import renumber_from` —— 而那个模块
    **从来不存在**，import 被 `except Exception: pass` 吞掉，于是新镜头恒落到
    **全剧最后**（集号却继承自 after_order 那一镜），`episode` 参数也没人读。
    现在位置与集号都走网页用的同一个路由函数（`routers.shotflow.insert_blank_shot`：
    整体重排、order 保持连续整数），这里只补它不做的三件事：
      · 锚点与造型区间按**镜头身份**搬回去（那条路由不搬；不搬的话插入点之后的
        旁白/字幕/造型整体错位，见 `shot_timing.snapshot_anchors`）；
      · 把拆解字段写到新行上，并按 `patch_shot` 的同一份规则补建资产行；
      · 集号与位置对不上时当场拒绝，不让一集的镜头散落到别的集中间。

    ⚠️ 不设 `is_special`（2026-11-03）。原先「带了 special_name 就是外部素材」：
    模型给镜头起个名字（「125-01 通话邀约」）是很自然的事，结果整集镜头都成了
    外部素材 —— 出片时全被过滤，点生成一秒就报「成功」却什么也没生成
    （生产西北婚约 125/126）。外部素材镜头必须自带成片，入口是
    `POST /shots/special`（要求 video_url），agent 没有理由造一个没有成片的外部素材。
    `special_name` 只为兼容旧调用保留，与 `label` 同义，只作展示名。
    """
    from fastapi import HTTPException

    from .. import shot_edit
    from ..asset_seed import ensure_assets
    from ..routers.shotflow import InsertShotIn, insert_blank_shot
    from ..shot_timing import (remap_anchors_by_identity, remap_stage_ranges_by_identity,
                               snapshot_anchors, snapshot_stage_ranges)

    ref = (script_ref or "").strip()
    chars = shot_edit.clean_names(characters)
    prop_names = shot_edit.clean_names(props)
    loc = shot_edit.clean_location(location)
    name = ((label or special_name or "").strip()[:255] or None)
    warnings: list[str] = []
    try:
        link = shot_edit.link_of(link_to_prev)
        after = int(after_order or 0)
        ep = int(episode) if episode is not None else None
    except shot_edit.EditError as e:
        return e.as_result()
    except (TypeError, ValueError):
        return {"ok": False, "error": "after_order / episode 必须是整数"}
    if ep is not None and ep < 1:
        return {"ok": False, "error": "episode 从 1 起"}

    with get_session() as s:
        shots = (s.query(Shot).filter(Shot.project_id == project_id)
                 .order_by(Shot.order).all())
        # 新镜头的前后邻居（与路由同一口径：after_order 找不到就接在全剧末尾）
        pos = 0
        if after > 0:
            pos = next((i + 1 for i, x in enumerate(shots) if x.order == after), len(shots))
        prev = shots[pos - 1] if pos > 0 else None
        nxt = shots[pos] if pos < len(shots) else None
        if ep is not None:
            lo = int(prev.episode or 1) if prev is not None else None
            hi = int(nxt.episode or 1) if nxt is not None else None
            if (lo is not None and ep < lo) or (hi is not None and ep > hi):
                where = (f"第 {lo} 集" if lo == hi or hi is None else
                         f"第 {hi} 集开头" if lo is None else f"第 {lo} 集与第 {hi} 集之间")
                return {"ok": False,
                        "error": f"after_order={after} 的位置在{where}，放不进第 {ep} 集的镜头："
                                 "集号要与插入位置一致（用 list_shots 看各集的镜号范围）",
                        "prev_episode": lo, "next_episode": hi}
        if link is None:
            link = (shot_edit.CONTINUOUS
                    if (loc and prev is not None and (prev.location or "").strip() == loc)
                    else shot_edit.TRANSITION) if (ref or loc) else None
        try:
            dur = shot_edit.settle_duration(
                s, project_id,
                duration_sec if duration_sec is not None else (None if ref else 5.0),
                ref, chars, shot_edit.model_cap(s, project_id), "这一镜", warnings)
        except shot_edit.EditError as e:
            return e.as_result()
        # ⚠️ 快照必须在路由改 order 之前取
        snap = snapshot_anchors(s, project_id)
        snap_st = snapshot_stage_ranges(s, project_id)

    try:
        r = insert_blank_shot(InsertShotIn(
            project_id=project_id, after_order=(after if after > 0 else None),
            episode=ep, script_ref=ref, duration_sec=dur))
    except HTTPException as e:
        return {"ok": False, "error": str(e.detail)}

    with get_session() as s:
        sh = s.get(Shot, r["id"])
        # 路由给空剧本填的是「（空白镜头，待填写）」占位；agent 侧保持空串
        # （它会接着用 patch_shot 填，占位文字留着反而会被当成剧本）。
        sh.script_ref = ref
        sh.characters = json.dumps(chars, ensure_ascii=False)
        if props is not None:
            sh.props = json.dumps(prop_names, ensure_ascii=False)
        sh.location = loc
        if link is not None:
            sh.link_to_prev = link
        sh.special_name = name
        sh.is_special = 0
        created = ensure_assets(s, project_id, characters=chars,
                                locations=[loc] if loc else (), props=prop_names)
        remap_anchors_by_identity(s, project_id, snap)
        remap_stage_ranges_by_identity(s, project_id, snap_st)
        s.commit()
        out = {"ok": True, "shot_id": sh.id, "order": sh.order, "episode": sh.episode,
               "duration_sec": sh.duration_sec,
               "note": "新镜头还没有镜头脚本；它后面的镜头镜号都 +1 了"}
    from ..continuity import invalidate_run_cache
    invalidate_run_cache(project_id)
    if created:
        out["assets_created"] = created
    if warnings:
        out["warnings"] = warnings
    return out


# ---------------------------------------------------------------------------
# 拆解的结构编辑：整集写入 / 删除 / 移动 / 合并（2026-11-19，全部不调模型、不花钱）
#
# 镜流的 AI 拆解（run_breakdown）保留为可选的机器初稿，但「机器是死的」——
# 特殊情况要能直接改。业务逻辑在 `app/shot_edit.py`，这里只是薄壳。
# 会丢掉**已生成画面**的那几种用法（force=true）才需要用户点头，其余直接执行。
# ---------------------------------------------------------------------------

def _forced(what: str):
    """`force=true` 时要人点头：连已经出过首帧/视频的镜头一起丢，找不回来。

    返回 `ToolSpec.confirm` 用的判据；命中时直接给出确认卡片上的那句话
    （`policy.confirm_text`），不命中返回 False。
    """
    def _check(args: dict):
        from ..shot_edit import flag
        if not flag((args or {}).get("force")):
            return False
        return what.format(**{"episode": (args or {}).get("episode", "这"),
                              "n": len((args or {}).get("shot_ids") or [])})
    return _check


@engine_tool(
    name="write_episode_shots",
    risk="write",
    role="editor",
    # force 会连同已出的首帧/视频一起删掉这一集的镜头（硬删、无版本），只有它需要用户点头
    confirm=_forced("会删掉第 {episode} 集现有的全部镜头，**包括已经出好的首帧和视频**（找不回来），"
                    "再按新的拆解重建。确定吗？"),
    description="按**你自己做的拆解**批量写入一集的镜头行（不调模型、不花钱；一次最多 300 镜）。"
                "不想用 run_breakdown 的机器拆解、或要整集重排时用它。\n"
                "shots 按先后顺序给，每条 {script_ref（必填，这一镜对应的剧本原文，原样照抄）, duration_sec?, "
                "characters?[], location?, props?[], link_to_prev?（true = 与上一镜连续 / false = 换场；"
                "不给时与上一镜场景名相同算连续）, label?（展示名）}。duration_sec 不给就按文字估。\n"
                "mode=\"replace\"（默认）：替换这一集现有的全部镜头；现有镜头里有已出过首帧或视频的就拒绝"
                "（返回 shots_with_media），确实要推倒重来再传 force=true（**会删掉那些画面，需要用户确认**）。"
                "mode=\"append\"：接在这一集最后一镜之后。\n"
                "角色/场景/道具会自动建好资产行（不出图，与 patch_shot 同一规则）。"
                "**不写任何镜头脚本**：之后先补齐场景与角色的图（get_episode_readiness），"
                "再用 set_shot_prompts(lock=true) 写入并锁定。只改个别镜头用 patch_shot / insert_shot / "
                "split_shot / merge_shots / delete_shots / move_shot。",
)
async def write_episode_shots(ctx: ToolCtx, project_id: str, episode: int,
                              shots: list[dict],
                              mode: Literal["replace", "append"] = "replace",
                              force: bool = False) -> dict:
    from .. import shot_edit
    from ..routers.shots import _breakdown_lock

    # 与机器拆解落库共用一把锁：两边都在整集地删/建镜头并重排 order，
    # 交错执行会把镜号排乱（见 routers.shots.do_breakdown 的落库段）。
    async with _breakdown_lock(project_id):
        with get_session() as s:
            if s.get(Project, project_id) is None:
                return {"ok": False, "error": "项目不存在"}
            try:
                out = shot_edit.write_episode_shots(
                    s, project_id, episode, shots, mode=mode, force=shot_edit.flag(force))
            except shot_edit.EditError as e:
                s.rollback()
                return e.as_result()
            s.commit()
    from ..continuity import invalidate_run_cache
    invalidate_run_cache(project_id)
    return out


@engine_tool(
    name="delete_shots",
    risk="write",
    role="editor",
    confirm=_forced("会删掉这 {n} 个镜头，**包括其中已经出好的首帧和视频**（找不回来）。确定吗？"),
    description="删掉一批镜头行（硬删，不调模型、不花钱；一次最多 300 镜），其余镜头的镜号收拢为连续。"
                "拆解里多拆的、重复的镜头用它。已经出过首帧或视频的镜头默认不删（返回 shots_with_media）："
                "只是这一版不用它，用 patch_shot_timeline(disabled=true) 停用（随时能恢复）；"
                "确实要删再传 force=true（**画面找不回来，需要用户确认**）。"
                "有一个 id 不存在就整批不删。删完后面镜头的镜号都变了。",
)
async def delete_shots(ctx: ToolCtx, shot_ids: list[str], force: bool = False) -> dict:
    from .. import shot_edit

    with get_session() as s:
        try:
            out = shot_edit.delete_shots(s, ctx.project_id, shot_ids,
                                         force=shot_edit.flag(force))
        except shot_edit.EditError as e:
            s.rollback()
            return e.as_result()
        s.commit()
    from ..continuity import invalidate_run_cache
    invalidate_run_cache(ctx.project_id)
    return out


@engine_tool(
    name="move_shot",
    risk="write",
    role="editor",
    description="把一个镜头挪到另一个位置（不调模型、不花钱）：放到全剧镜号 after_order 那一镜之后"
                "（0 = 挪到全剧最前）。其余镜头的镜号随之重排，字幕/音频/造型范围跟着镜头走。"
                "集号：缺省跟随 after_order 那一镜（挪到另一集的镜头后面 = 归入那一集）；"
                "要放成某一集的第一镜时显式传 episode。镜头的剧本与镜头脚本不变。",
)
async def move_shot(ctx: ToolCtx, shot_id: str, after_order: int,
                    episode: int | None = None) -> dict:
    """调序走网页拖拽用的同一个路由函数（`PATCH /shots/{id}/timeline` 的 `to_order`）：
    锚点与造型区间的按身份搬迁都在那里，这里只把「放到某镜之后」换算成目标位置，
    并处理跨集（路由不管集号）。"""
    from fastapi import HTTPException

    from ..routers.shots import ShotTimelineIn, patch_shot_timeline as _patch

    try:
        after = int(after_order or 0)
        ep_arg = int(episode) if episode is not None else None
    except (TypeError, ValueError):
        return {"ok": False, "error": "after_order / episode 必须是整数"}
    with get_session() as s:
        sh = s.get(Shot, shot_id)
        if not sh or sh.project_id != ctx.project_id:
            return {"ok": False, "error": "镜头不存在或不属于本项目"}
        others = (s.query(Shot)
                  .filter(Shot.project_id == ctx.project_id, Shot.id != shot_id)
                  .order_by(Shot.order).all())
        old_order, old_ep = sh.order, int(sh.episode or 1)
        if after == old_order:
            return {"ok": False, "error": "after_order 就是这一镜自己：要放到哪一镜之后？"}
        anchor = None
        tgt = 1
        if after > 0:
            idx = next((i for i, x in enumerate(others) if x.order == after), None)
            if idx is None:
                return {"ok": False,
                        "error": f"没有镜号为 {after} 的镜头（用 list_shots 看当前镜号）"}
            anchor = others[idx]
            tgt = idx + 2                       # 1-based：紧跟在 anchor 之后
        nxt = others[tgt - 1] if tgt - 1 < len(others) else None
        new_ep = ep_arg if ep_arg is not None else (
            int(anchor.episode or 1) if anchor is not None else
            int(nxt.episode or 1) if nxt is not None else old_ep)
        lo = int(anchor.episode or 1) if anchor is not None else None
        hi = int(nxt.episode or 1) if nxt is not None else None
        # 只校验**显式给的**集号：缺省跟随前一镜，本来就与位置一致
        if ep_arg is not None and ((lo is not None and new_ep < lo)
                                   or (hi is not None and new_ep > hi)):
            return {"ok": False,
                    "error": f"那个位置前一镜是第 {lo} 集、后一镜是第 {hi} 集，放不进第 {new_ep} 集的镜头",
                    "prev_episode": lo, "next_episode": hi}
    try:
        r = _patch(shot_id, ShotTimelineIn(to_order=tgt))
    except HTTPException as e:
        return {"ok": False, "error": str(e.detail)}
    if new_ep != old_ep:
        with get_session() as s:
            sh = s.get(Shot, shot_id)
            sh.episode = new_ep
            s.commit()
    from ..continuity import invalidate_run_cache
    invalidate_run_cache(ctx.project_id)
    out = {"ok": True, "shot_id": shot_id, "order": r.get("order"),
           "previous_order": old_order, "episode": new_ep,
           "note": "其余镜头的镜号已随之重排，再操作前用 list_shots 重新取"}
    if new_ep != old_ep:
        out["previous_episode"] = old_ep
    return out


@engine_tool(
    name="merge_shots",
    risk="write",
    role="editor",
    confirm=_forced("会把这 {n} 个镜头并成一镜，被并掉的镜头**连同已经出好的首帧和视频**一起删除"
                    "（找不回来）。确定吗？"),
    description="把同一集里**相邻**的几镜并成一镜（改拆解；不调模型、不花钱）：剧本原文按镜头顺序接起来，"
                "角色与道具取并集，时长相加（超过模型单镜上限会被钳住并提示）。"
                "留下的是其中最靠前的那一镜（它已有的镜头脚本只对应第一段 → 标 stale，要重写并锁定），其余删掉。"
                "要并掉的镜头里有已出过首帧或视频的就拒绝（返回 shots_with_media），"
                "确实要并再传 force=true（**那些画面找不回来，需要用户确认**）。"
                "注意：把按时间切开的两段片合回去是 restore_cut，不是这个。",
)
async def merge_shots(ctx: ToolCtx, shot_ids: list[str], force: bool = False) -> dict:
    from .. import shot_edit

    with get_session() as s:
        try:
            out = shot_edit.merge_shots(s, ctx.project_id, shot_ids,
                                        force=shot_edit.flag(force))
        except shot_edit.EditError as e:
            s.rollback()
            return e.as_result()
        s.commit()
    from ..continuity import invalidate_run_cache
    invalidate_run_cache(ctx.project_id)
    return out


@engine_tool(
    name="upsert_stage",
    risk="write",
    role="editor",
    description="建或改造型（某个角色在第几集到第几集、可细到哪几镜，穿哪套衣服）。shot_from/shot_to 用**全剧镜号**，不是本集镜号；不填 = 整集。**一个镜头只归一套造型**：新建或改了范围的这套接管它的范围，与之重叠的旧造型自动让出（被切开的后段仍用原来那张图），结果的 adjusted 里逐条说明——写之前把会被挤掉的范围告诉用户。用户只是说「这张图某角色第 X–Y 集才用」时用 add_episode_look；给造型换图用 set_asset_images（指定 stage_id）。造型不再按场景生效。",
)
async def upsert_stage(ctx: ToolCtx, project_id: str, character_name: str,
                       stage_name: str, ep_from: int = 1, ep_to: int = 999,
                       shot_from: int | None = None,
                       shot_to: int | None = None,
                       description: str | None = None,
                       stage_id: str | None = None) -> dict:
    import uuid

    from fastapi import HTTPException

    from .. import stage_gate
    from ..asset_image_write import last_episode
    from ..routers.stage_scene import _check_stage_ranges

    with get_session() as s:
        # 与网页「新增/修改造型」同一套校验（之前这里一条都没有：能建出挂在不存在角色下、
        # 与别的造型区间冲突、永远不会生效的造型，也会改到已删除的造型上）
        if not (s.query(Asset).filter(Asset.project_id == project_id, Asset.kind == "character",
                                      Asset.name == character_name, Asset.deleted_at.is_(None)).first()):
            return {"ok": False, "error": f"找不到角色「{character_name}」（名字要与资产表一致）"}
        st = None
        if stage_id:
            st = s.get(AssetStage, stage_id)
            if st and st.project_id != project_id:
                return {"ok": False, "error": "阶段不属于本项目"}
            if st and st.deleted_at:
                return {"ok": False, "error": "这套造型已被删除，先恢复再改"}
        if st is None:
            st = (stage_gate.alive(s.query(AssetStage)
                  .filter(AssetStage.project_id == project_id,
                          AssetStage.character_name == character_name,
                          AssetStage.stage_name == stage_name)).first())
        ep_to = min(int(ep_to), last_episode(s, project_id))
        created = False
        if st is None:
            st = AssetStage(id=uuid.uuid4().hex[:12], project_id=project_id,
                            character_name=character_name, stage_name=stage_name,
                            ep_from=int(ep_from), ep_to=int(ep_to),
                            status="draft")
            s.add(st)
            created = True
        st.character_name = character_name
        st.stage_name = stage_name
        st.ep_from = int(ep_from)
        st.ep_to = int(ep_to)
        st.shot_from = shot_from
        st.shot_to = shot_to
        if description is not None:
            st.description = description.strip() or None
        try:
            _check_stage_ranges(s, st)
        except HTTPException as e:
            s.rollback()
            return {"ok": False, "error": str(e.detail)}
        from ..stage_coverage import claim
        try:
            notes = claim(s, st)
        except ValueError as e:
            s.rollback()
            return {"ok": False, "error": str(e)}
        s.commit()
        return {"ok": True, "stage_id": st.id, "created": created,
                "ep": [st.ep_from, st.ep_to],
                "shot_range": [st.shot_from, st.shot_to],
                "adjusted": notes,
                "note": "shot 范围是全剧镜号；不填 = 整集。一镜只归一套造型：与它重叠的旧造型已让出，见 adjusted"}


@engine_tool(
    name="rename_asset",
    risk="write",
    role="editor",
    description="给资产改名。**会连带迁移**所有引用它的镜头/阶段/别名（不会让引用失联）。",
)
async def rename_asset(ctx: ToolCtx, asset_id: str, new_name: str) -> dict:
    from ..asset_rename import rename_asset_everywhere

    with get_session() as s:
        a = s.get(Asset, asset_id)
        if not a or a.project_id != ctx.project_id:
            return {"ok": False, "error": "资产不存在或不属于本项目"}
        old = a.name
        if old == new_name.strip():
            return {"ok": True, "changed": False, "note": "名字没变"}
        moved = rename_asset_everywhere(s, a.project_id, a.kind, old, new_name.strip())
        s.commit()
    return {"ok": True, "old": old, "new": new_name.strip(), "migrated": moved}


@engine_tool(
    name="delete_asset",
    risk="write",
    role="editor",
    description="删除资产（打墓碑，可 restore 恢复）。删掉后它不再被注入参考图。",
)
async def delete_asset(ctx: ToolCtx, asset_id: str) -> dict:
    from datetime import datetime, timezone

    with get_session() as s:
        a = s.get(Asset, asset_id)
        if not a or a.project_id != ctx.project_id:
            return {"ok": False, "error": "资产不存在或不属于本项目"}
        if a.deleted_at:
            return {"ok": True, "asset_id": asset_id, "already_deleted": True}
        a.deleted_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        s.commit()
    return {"ok": True, "asset_id": asset_id, "note": "已打墓碑，可用 restore_asset 恢复"}


@engine_tool(
    name="restore_asset",
    risk="write",
    role="editor",
    description="恢复一个被删除的资产。",
)
async def restore_asset(ctx: ToolCtx, asset_id: str) -> dict:
    with get_session() as s:
        a = s.get(Asset, asset_id)
        if not a or a.project_id != ctx.project_id:
            return {"ok": False, "error": "资产不存在或不属于本项目"}
        a.deleted_at = None
        s.commit()
    return {"ok": True, "asset_id": asset_id}


def _merge_drops(p: dict, drop_stage_ids: list[str] | None) -> tuple[list[str] | None, str | None]:
    """造型区间冲突怎么裁：显式给了就用；没给且系统能给建议就按建议；否则必须问用户。"""
    st = p.get("stages") or {}
    if drop_stage_ids is not None or not st.get("conflicts"):
        return drop_stage_ids, None
    if st.get("auto_ok"):
        return list(st.get("auto_drop_stage_ids") or []), None
    return None, ("造型区间有冲突、系统给不出唯一建议，需要用户逐个裁决："
                  + "；".join(f"{c['a']['label']} vs {c['b']['label']}"
                             for c in (st.get("conflicts") or [])[:5]))


def _merge_confirm(args: dict) -> str:
    """确认卡片那句话：把谁并进谁、会丢掉哪几套造型、哪些恢复不了。"""
    from .. import asset_merge

    ids = list(args.get("asset_ids") or [])
    with get_session() as s:
        pid = next((a.project_id for a in (s.get(Asset, i) for i in ids) if a), None)
        p = asset_merge.plan(s, pid, ids) if pid else {"ok": False}
    if not p.get("ok"):
        return "合并资产（预演未通过，执行时会被拒）"
    keep = p["keep"]
    if args.get("keep_id"):
        alln = [keep] + list(p.get("drops") or [])
        keep = next((x for x in alln if x["id"] == args["keep_id"]), keep)
    drops = [x for x in [p["keep"]] + list(p.get("drops") or []) if x["id"] != keep["id"]]
    txt = ("把 " + "、".join(f"「{d['name']}」" for d in drops)
           + f" 合并进「{keep['name']}」")
    st = p.get("stages") or {}
    drop_ids, _ = _merge_drops(p, args.get("drop_stage_ids"))
    if drop_ids:
        labels = {x["id"]: x["label"] for c in st.get("conflicts") or [] for x in (c["a"], c["b"])}
        txt += "，丢掉冲突的造型 " + "、".join(labels.get(i, i) for i in drop_ids[:5])
    return (txt + "。被并的行会被删除（可恢复），但造型改名与场景别名重指不会随恢复撤销")


@engine_tool(
    name="merge_assets",
    risk="write",
    role="editor",
    confirm=_merge_confirm,
    description="把同一实体的多个资产合并成一个（例如「王总」「老王」并进「王建国」）。"
                "**先用 preview_asset_merge 看预演、把清单列给用户确认后再调**；"
                "执行前系统还会弹确认卡片。keep_id = 留哪一行（不填按系统规则选）；"
                "drop_stage_ids = 角色造型区间冲突时丢掉哪几套（不填按系统建议）。"
                "一次只合并一组（同一个实体）。",
)
async def merge_assets(ctx: ToolCtx, asset_ids: list[str], keep_id: str | None = None,
                       drop_stage_ids: list[str] | None = None) -> dict:
    from .. import asset_merge

    with get_session() as s:
        bad = [i for i in asset_ids
               if not (a := s.get(Asset, i)) or a.project_id != ctx.project_id]
        if bad:
            return {"ok": False, "error": f"这些资产不存在或不属于本项目：{bad}"}
        p = asset_merge.plan(s, ctx.project_id, list(asset_ids))
        if not p.get("ok"):
            return {"ok": False, "error": "；".join(p.get("blockers") or ["无法合并"])}
        drops, problem = _merge_drops(p, drop_stage_ids)
        if problem:
            return {"ok": False, "error": problem, "conflicts": (p.get("stages") or {}).get("conflicts")}
        try:
            out = asset_merge.apply_merge(s, ctx.project_id, list(asset_ids),
                                          keep_id=keep_id, drop_stage_ids=drops)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        s.commit()
    return {"ok": True, **(out if isinstance(out, dict) else {})}


@engine_tool(
    name="import_assets_by_filename",
    risk="write",
    role="editor",
    description="按图片文件名批量导入资产图。level=1（默认）：文件名 = 资产名，"
                "确定性匹配；level=2：文件名**包含**资产名（\"男3-正面.png\" → 男3）"
                "或按词全覆盖（\"秦墨_特写.png\" → 秦墨）。"
                "⚠️ level=2 的模糊命中**不会直接写**，返回 status='confirm' 与候选，"
                "必须问用户是哪一张，再用 decided={文件名: asset_id} 调一次才落库。"
                "角色只有一套造型时图写进那套造型（出片用的就是它），有多套时写角色的通用定妆图并列出各套。"
                "**绝不猜**：对不上就是 unmatched，原样列给用户。",
)
async def import_assets_by_filename(ctx: ToolCtx, project_id: str,
                                    items: list[dict],
                                    level: int = 1,
                                    decided: dict | None = None) -> dict:
    """items = [{"filename": "男3.png", "url": "/fw/media/uploads/xxx.png"}]。

    ## 三级匹配（§12.1）

    ```
    第 1 级  文件名 = 资产名        确定性，零成本          ← 原有
    第 2 级  文件名里含资产名      只给候选，用户确认后才写  ← 本参数 level=2
    第 3 级  图上的字 = 资产名     走 read_asset_names_from_images（agent 侧）
    ```

    第 2 级刻意**不做**模糊的"相似度"（编辑距离、拼音）：40 张图里错挂一张，
    用户很难发现，而"没对上"他会立刻看见并重新命名。宁可 unmatched。

    ## 为什么 level=2 还要用户确认（2026-11-04 用户裁定）

    「男主礼服.png」既可能是「男主」，也可能是另一个叫「男方礼服」的资产——
    代码只能猜，猜错的代价是把图挂到别人脸上。所以模糊命中返回
    `status='confirm'` + `candidates`，**不落库**；把候选原样报给用户，
    用户点明是哪张后，再用 `decided={"男主礼服.png": "资产id"}` 调一次。

    ## 判名口径

    ⚠️ 归一逻辑**复用路由里那个 `_name_key`**，不另写一份：
    它是"文件名 → 资产名"的唯一口径（只剥已知图片扩展名，
    因为资产名自己可能带点，如「V2.0 造型」）。抄一份必然漂移，
    漂移的表现是"批量导入说对上了、实际挂到了别的资产"。
    """
    from ..asset_image_write import ImageWriteError, import_by_filename

    try:
        out = import_by_filename(project_id, items, level=level, decided=decided or {})
    except ImageWriteError as e:
        return {"ok": False, "error": str(e)}
    out["level"] = level
    if out["counts"].get("confirm"):
        out["hint"] = (
            "有 %d 张只是**猜**的匹配（status=confirm），还没有写入任何东西。"
            "把每张的 candidates 原样念给用户，让他点名是哪一张，"
            "然后带 decided={文件名: asset_id} 再调用一次这个工具。" % out["counts"]["confirm"])
    elif level == 1 and out["counts"].get("unmatched"):
        out["hint"] = ("有 %d 张按文件名对不上。可以先用 level=2 再试一次"
                       "（文件名包含资产名，会给出候选让你问用户），"
                       "仍对不上的再看图读名，或问用户这张是谁后用 set_asset_images。"
                       % out["counts"]["unmatched"])
    return out


@engine_tool(
    name="set_asset_images",
    risk="write",
    role="editor",
    description="把图写到**指定**的资产或造型上（用户说了「这张是林晓」「这是医院走廊」，而文件名对不上时用）。"
                "items = [{url, asset_id 或 name（同名多类时带 kind）, stage_id 或 stage_name（可选，只对角色）}]；"
                "url 用 upload_media 上传后拿到的地址。指定了造型就写那套；没指定时："
                "角色只有一套造型 → 写进那套，有多套 → 写角色的通用定妆图并列出各套（让用户选再指定 stage_id）。"
                "旧图留在版本记录里能找回。**只在确定是谁时写**：用户说了名字、或文件名/图上的字对得上；"
                "只凭长相判断的，先问用户「这张是不是某某？」，确认后再写。一次最多 200 张，不花钱。",
)
async def set_asset_images(ctx: ToolCtx, project_id: str, items: list[dict]) -> dict:
    from ..asset_image_write import ImageWriteError, set_images

    try:
        return set_images(project_id, items)
    except ImageWriteError as e:
        return {"ok": False, "error": str(e)}


# ---------------------------------------------------------------------------
# 站位图（2026-11-21）：登记 / 绑定 / 解除 / 删除。规则与数据都在 `app/blocking_images.py`。
# 这里不判断「该不该用站位图」—— 那是调用方（客户端 Agent 的技能）的事。
# ---------------------------------------------------------------------------

_BLOCKING_HOW = ("在绑定的镜头提示词里写 @站位图名字 引用它（出片时转成 图片N）；"
                 "绑定、解除、换图之后要重新出片才生效。它排在自动带上的角色 / 场景图后面，"
                 "参考图总数超过视频模型上限时排在最后的不会被带上")


def _blocking_write(project_id: str, run) -> dict:
    """开会话跑一次站位图写操作并提交；参数或状态不对时什么都不改，返回 `ok=false` 与原因。"""
    from .. import blocking_images

    with get_session() as s:
        try:
            if s.get(Project, project_id) is None:
                raise blocking_images.BlockingError("项目不存在")
            out = run(s)
        except blocking_images.BlockingError as e:
            s.rollback()
            return {"ok": False, "error": str(e)}
        s.commit()
    return out


@engine_tool(
    name="set_blocking_image",
    risk="write",
    role="editor",
    description="登记或更新一张**站位图**：一场戏里各角色站在哪、朝哪的全景参考图，由你自己生成"
                "（参考图用已确认的角色图和场景图），什么时候需要也由你判断，系统不会自动生成。"
                "新登记：image_url = 镜流里的图片地址，location = 所属场景名，name 不填按场景自动起；"
                "prompt 记下生成它用的提示词。更新：带 blocking_id（或已有的 name），只改给了的项，"
                "换图、改名会同步到已绑定的镜头。可以同时把它绑到镜头上："
                "shot_ids，或 episode + shot_from + shot_to（本集镜号，shot_to 不填 = 只一镜）。"
                "名字不能与角色 / 场景 / 道具同名。不花钱。",
)
async def set_blocking_image(ctx: ToolCtx, project_id: str, image_url: str = "", name: str = "",
                             location: str | None = None, prompt: str | None = None,
                             blocking_id: str = "", shot_ids: list[str] | None = None,
                             episode: int | None = None, shot_from: int | None = None,
                             shot_to: int | None = None) -> dict:
    from .. import blocking_images as bi

    def run(s) -> dict:
        shots = bi.select_shots(s, project_id, shot_ids=shot_ids, episode=episode,
                                shot_from=shot_from, shot_to=shot_to)
        row, info = bi.save(s, project_id, blocking_id=blocking_id, name=name,
                            image_url=image_url, location=location, prompt=prompt)
        s.flush()
        if shots:
            info.update(bi.bind(s, row, shots))
            s.flush()
        return {"ok": True, **info, "blocking_image": bi.describe(s, row), "note": _BLOCKING_HOW}

    return _blocking_write(project_id, run)


@engine_tool(
    name="bind_blocking_image",
    risk="write",
    role="editor",
    description="把一张已登记的站位图绑到镜头上，作为这些镜头出视频时的参考图。"
                "blocking_id 或 name 指明哪一张；镜头用 shot_ids，或 episode + shot_from + shot_to"
                "（本集镜号，shot_to 不填 = 只一镜），两种可以同时给。已经绑着的不重复绑。不花钱。",
)
async def bind_blocking_image(ctx: ToolCtx, project_id: str, blocking_id: str = "", name: str = "",
                              shot_ids: list[str] | None = None, episode: int | None = None,
                              shot_from: int | None = None, shot_to: int | None = None) -> dict:
    from .. import blocking_images as bi

    def run(s) -> dict:
        row = bi.find(s, project_id, blocking_id=blocking_id, name=name)
        if not bi.has_selector(shot_ids, episode, shot_from, shot_to):
            raise bi.BlockingError("要给 shot_ids，或 episode + shot_from（+ shot_to），指明绑到哪些镜头")
        shots = bi.select_shots(s, project_id, shot_ids=shot_ids, episode=episode,
                                shot_from=shot_from, shot_to=shot_to)
        out = bi.bind(s, row, shots)
        s.flush()
        return {"ok": True, **out, "blocking_image": bi.describe(s, row), "note": _BLOCKING_HOW}

    return _blocking_write(project_id, run)


@engine_tool(
    name="unbind_blocking_image",
    risk="write",
    role="editor",
    description="把站位图从镜头上解除：这些镜头出视频时不再带它。blocking_id 或 name 指明哪一张；"
                "镜头用 shot_ids，或 episode + shot_from + shot_to（本集镜号）；"
                "**都不给 = 从所有绑着它的镜头上解除**。站位图本身保留。不花钱。",
)
async def unbind_blocking_image(ctx: ToolCtx, project_id: str, blocking_id: str = "",
                                name: str = "", shot_ids: list[str] | None = None,
                                episode: int | None = None, shot_from: int | None = None,
                                shot_to: int | None = None) -> dict:
    from .. import blocking_images as bi

    def run(s) -> dict:
        row = bi.find(s, project_id, blocking_id=blocking_id, name=name)
        shots = None
        if bi.has_selector(shot_ids, episode, shot_from, shot_to):
            shots = bi.select_shots(s, project_id, shot_ids=shot_ids, episode=episode,
                                    shot_from=shot_from, shot_to=shot_to)
        out = bi.unbind(s, row, shots)
        s.flush()
        return {"ok": True, **out, "blocking_image": bi.describe(s, row),
                "note": "已出过片的镜头要重新出片才会不带它；提示词里还写着 @这张站位图 的地方要一并改掉"}

    return _blocking_write(project_id, run)


@engine_tool(
    name="delete_blocking_image",
    risk="write",
    role="editor",
    description="删掉一张站位图，并从所有绑着它的镜头上解除。blocking_id 或 name 指明哪一张。"
                "这一步不删图片文件；不再被任何地方用到的图，之后清理缓存时会被回收。不花钱。",
)
async def delete_blocking_image(ctx: ToolCtx, project_id: str, blocking_id: str = "",
                                name: str = "") -> dict:
    from .. import blocking_images as bi

    def run(s) -> dict:
        row = bi.find(s, project_id, blocking_id=blocking_id, name=name)
        gone = {"id": row.id, "name": row.name, "image_url": row.image_url}
        return {"ok": True, **bi.remove(s, row), "blocking_image": gone}

    return _blocking_write(project_id, run)


@engine_tool(
    name="add_episode_look",
    risk="write",
    role="editor",
    description="给角色加一套**只在第 ep_from–ep_to 集用**的造型，可同时给图（用户说「这张图林晓第 5–8 集才用」：先 upload_media 拿 url，再调这个）。stage_name 是这套造型的名字（例如「病号服」，用户没说就按图的内容起一个并告诉他）。一个镜头只归一套造型：这几集归新造型，原本覆盖它们的造型自动让出、其余集照旧，结果的 adjusted 里说明改了哪几套。只到第 N 集为止时 ep_to 填 N；一直用到最后填 999（按全剧最后一集算）。不花钱。",
)
async def add_episode_look(ctx: ToolCtx, project_id: str, character_name: str, stage_name: str,
                           ep_from: int, ep_to: int, image_url: str = "", description: str = "") -> dict:
    from ..asset_image_write import ImageWriteError, add_episode_look as _add

    try:
        return _add(project_id, character_name, stage_name, ep_from, ep_to,
                    image_url=(image_url or "").strip() or None, description=description or None)
    except ImageWriteError as e:
        return {"ok": False, "error": str(e)}


# ---------------------------------------------------------------------------
# 文本类 job（花小钱：0.5 元/次操作）
#
# ⚠️ 这里原有 `run_reprompt`（让镜流按当前资产重写镜头提示词），2026-11-19 删除：
# 镜头脚本改由 Muse 撰写并锁定，对应的 `reprompt` 任务也已下线（POST /v2/jobs 回 410）。
# ---------------------------------------------------------------------------

@engine_tool(
    name="run_costume_scan",
    risk="generate",
    costs=True,
    long_running=True,
    role="editor",
    description="全剧服装识别（只识别不生成，花文本钱）。识别后会建出造型阶段行。",
)
async def run_costume_scan(ctx: ToolCtx, project_id: str) -> dict:
    return await submit_idempotent(
        ctx, kind="costume_scan", payload={"project_id": project_id},
        tool_call_id=ctx.tool_call_id or "costume_scan", tool="run_costume_scan")


@engine_tool(
    name="set_character_profile",
    risk="write",
    role="editor",
    description="改角色的**人物档案**（它是什么、性别、年龄段、一句身份）。通用定妆图、造型图的提示词和逐镜视频提示词都按它写，"
                "档案错了提示词就跟着错——例如把一只猫当成人（造型图出成真人、逐镜写成「双手撑地」）。"
                "form：人 / 动物 / 非人（机器人、妖怪、玩偶等）；form 不是「人」时 species 写它具体是什么"
                "（如「狸花猫幼猫」）。gender：女 / 男 / 未知（动物写雌雄对应的 女/男）；"
                "age：幼儿 / 儿童 / 少年 / 青年 / 中年 / 老年 / 未知（动物幼崽用 幼儿）。"
                "brief 一句话身份气质（≤60 字）。改后：此后新拼的通用定妆图/造型图提示词与逐镜提示词都按新档案；"
                "已经写死的稿（set_asset_prompts 写的、锁定的镜头稿）不会自动变，已生成的图也不会重画。"
                "改完让镜头脚本跟上：受影响的镜头由你重写后用 set_shot_prompts(lock=true) 写回。不花钱。",
)
async def set_character_profile(ctx: ToolCtx, name: str, form: str = "人", species: str = "",
                                 gender: str = "未知", age: str = "未知", brief: str = "") -> dict:
    from ..character_brief import _AGE_LABEL, _NONHUMAN_FORMS

    form, gender, age = (form or "人").strip(), (gender or "未知").strip(), (age or "未知").strip()
    if form not in ("人", *_NONHUMAN_FORMS):
        return {"ok": False, "error": "form 只能是 人 / 动物 / 非人"}
    if gender not in ("女", "男", "未知"):
        return {"ok": False, "error": "gender 只能是 女 / 男 / 未知"}
    if age not in (*_AGE_LABEL, "未知"):
        return {"ok": False, "error": "age 只能是 幼儿 / 儿童 / 少年 / 青年 / 中年 / 老年 / 未知"}
    species = (species or "").strip()[:30]
    if form != "人" and not species:
        return {"ok": False, "error": "不是人的角色要写 species（它具体是什么，如「狸花猫幼猫」）"}
    with get_session() as s:
        a = _asset_of(s, ctx, {"name": name, "kind": "character"})
        if a is None:
            return {"ok": False, "error": f"找不到角色「{name}」（名字要与资产表一致）"}
        try:
            before = json.loads(a.brief_json) if a.brief_json else None
        except (ValueError, TypeError):
            before = None
        new = {"gender": gender, "age": age, "brief": (brief or "").strip()[:60], "source": "user"}
        if form != "人":
            new.update(form=form, species=species)
        a.brief_json = json.dumps(new, ensure_ascii=False)
        if form != "人" and a.profile_json:
            # 人的骨相五官档案对非人角色只会把它往人脸上拉；拼提示词时也会跳过，这里一并清掉免得界面上还显示
            a.profile_json = None
        s.commit()
    return {"ok": True, "name": name, "profile": {k: v for k, v in new.items() if k != "source"},
            "before": {k: v for k, v in (before or {}).items() if k != "source"} or None,
            "note": "之后新拼的通用定妆图/造型图提示词与逐镜提示词按这份档案。要重画：造型图用 run_asset_generate 传 stage_id，通用定妆图不传；"
                    "已经写好且锁定的镜头稿不会自动改，需要的话再改写那些镜头"}


@engine_tool(
    name="run_profile_fill",
    risk="generate",
    costs=True,
    long_running=True,
    role="editor",
    description="给**还没有形象档案**的角色补生成档案（五官、骨相、发色、气质这类长相细节）。已有的一个不动；人物档案里标了动物/非人的角色跳过。⚠️ 和「人物档案」不是一回事：角色是什么（人还是猫）、性别、年龄段错了，用 set_character_profile 改，不要用这个。",
)
async def run_profile_fill(ctx: ToolCtx, project_id: str) -> dict:
    return await submit_idempotent(
        ctx, kind="profile_fill", payload={"project_id": project_id},
        tool_call_id=ctx.tool_call_id or "profile_fill", tool="run_profile_fill")


@engine_tool(
    name="run_desub_scan",
    risk="generate",
    costs=True,
    long_running=True,
    role="editor",
    description="检测画面里的烧录字幕（只标记不擦除，不花视频钱）。"
                "检测结果要先给用户看过再决定擦哪些。",
)
async def run_desub_scan(ctx: ToolCtx, project_id: str,
                         episode: int | None = None) -> dict:
    payload: dict = {"project_id": project_id}
    if episode is not None:
        payload["episode"] = int(episode)
    return await submit_idempotent(
        ctx, kind="desub_scan", payload=payload,
        tool_call_id=ctx.tool_call_id or "desub_scan", tool="run_desub_scan")


@engine_tool(
    name="run_auto_subtitles",
    risk="generate",
    costs=True,
    long_running=True,
    role="editor",
    description="从**实际发声的音轨**转写生成字幕（Paraformer，带句级/字级时间戳）。"
                "replace=true 会先清掉旧字幕。",
)
async def run_auto_subtitles(ctx: ToolCtx, project_id: str,
                             replace: bool = False) -> dict:
    return await submit_idempotent(
        ctx, kind="auto_subtitles",
        payload={"project_id": project_id, "replace": bool(replace)},
        tool_call_id=ctx.tool_call_id or "auto_subtitles",
        tool="run_auto_subtitles")


# ---------------------------------------------------------------------------
# 配乐计划（不花钱：只建 AudioClip 行）
# ---------------------------------------------------------------------------

@engine_tool(
    name="apply_bgm_plan",
    risk="write",
    role="editor",
    description="把配乐计划落成音轨段。segments = [{from_shot, to_shot, mood, "
                "intensity, bgm_id, volume, fade_in, fade_out, reason}]。"
                "from_shot/to_shot 用**全剧镜号**。会先清掉旧的 music 段。",
)
async def apply_bgm_plan(ctx: ToolCtx, project_id: str,
                         segments: list[dict],
                         replace: bool = True) -> dict:
    """校验计划 → 建 `AudioClip(kind="music")` 行。

    ## 为什么镜号要在这里校验

    计划由模型给，而模型很容易把"本集第 3 镜"当成 `order=3`（实际可能是 23）。
    落库前必须用真实镜头表把它规整掉，否则配乐会贴到完全错误的画面上，
    而且**不会有任何报错** —— 用户只会觉得"配乐怪怪的"。

    校验逻辑在 `bgm.validate_plan`（与 `list_bgm` 的检索口径同源）。
    """
    import uuid
    from datetime import datetime, timezone

    from ..bgm import validate_plan
    from ..db import AudioClip

    with get_session() as s:
        shots = (s.query(Shot).filter(Shot.project_id == project_id,
                                      Shot.disabled == 0)
                 .order_by(Shot.order).all())
        shot_rows = [{"order": x.order, "episode": x.episode,
                      "duration_sec": x.duration_sec} for x in shots]
        total = sum(float(x.duration_sec or 5.0) for x in shots)

    plan = validate_plan({"segments": segments}, shots=shot_rows,
                         total_sec=total)
    if not plan.get("ok"):
        return {"ok": False, "error": plan.get("error")}

    made = []
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with get_session() as s:
        if replace:
            olds = (s.query(AudioClip)
                    .filter(AudioClip.project_id == project_id,
                            AudioClip.kind == "music").all())
            for o in olds:
                s.delete(o)
        for seg in plan["segments"]:
            cid = uuid.uuid4().hex[:12]
            s.add(AudioClip(
                id=cid, project_id=project_id, kind="music",
                text=seg.get("reason") or None,
                url=seg["url"],
                duration=float(seg.get("duration") or 0.0) or 0.0,
                start_shot_order=int(seg["from_shot"]),
                start_offset_sec=0.0,
                volume=float(seg["volume"]),
                fade_in_sec=float(seg["fade_in"]),
                fade_out_sec=float(seg["fade_out"]),
                status="done",
                created_at=now))
            made.append({"id": cid, **seg})
        s.commit()

    return {"ok": True, "created": len(made), "segments": made,
            "warnings": plan.get("warnings") or [],
            "note": "配乐轨已写入；导出剪映时会成为独立的「配乐」轨"}


# ---------------------------------------------------------------------------
# 音效计划（不花钱：只建 AudioClip 行）
# ---------------------------------------------------------------------------

@engine_tool(
    name="apply_sfx_plan",
    risk="write",
    role="editor",
    description="把音效计划落成音轨段。segments = [{shot, sfx_id, offset_sec, "
                "duration, volume, reason}]。shot 用**全剧镜号**，offset_sec 是镜内偏移秒。"
                "会先清掉旧的 sfx 段。sfx_id 必须先由 list_sfx 查出来。",
)
async def apply_sfx_plan(ctx: ToolCtx, project_id: str,
                         segments: list[dict],
                         replace: bool = True) -> dict:
    """校验计划 → 建 `AudioClip(kind="sfx")` 行。

    ## 与配乐的两个差别

    ① **逐点落**，不是逐区间：音效是一个"事件点"（关门、脚步、phone 响），
       由 `shot + offset_sec` 定位，长度取素材本身或用户指定的时长。
    ② **同一镜可以叠多条**：一句台词中间可以有关门 + 脚步 + 环境音。
       配乐段之间不许重叠（见 `bgm.validate_plan` 的顺延逻辑），音效没有这个限制
       —— 它们本来就该重叠。

    ## 为什么必须校验镜号与 sfx_id

    理由同 `apply_bgm_plan`：模型极易把"本集第 3 镜"当成 order=3（实际可能是 23），
    而错位的音效**不会有任何报错**，用户只会觉得"声音怪怪的"。
    `list_sfx` 查不到的 id 也一律跳过 —— 宁可少一条，也不要落一条点了 404 的段。
    """
    import uuid
    from datetime import datetime, timezone

    from ..db import AudioClip
    from ..sfx import find_by_id

    if not segments:
        return {"ok": False, "error": "segments 为空"}

    with get_session() as s:
        shots = (s.query(Shot).filter(Shot.project_id == project_id,
                                      Shot.disabled == 0).all())
        by_order = {int(x.order): x for x in shots}
    if not by_order:
        return {"ok": False, "error": "项目没有可用镜头（都已停用或还没拆镜）"}

    made, skipped = [], []
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with get_session() as s:
        if replace:
            for old in (s.query(AudioClip)
                        .filter(AudioClip.project_id == project_id,
                                AudioClip.kind == "sfx").all()):
                s.delete(old)
        for i, raw in enumerate(segments):
            if not isinstance(raw, dict):
                continue
            try:
                order = int(raw.get("shot"))
            except (TypeError, ValueError):
                skipped.append({"seg": raw, "why": "shot 不是整数（要全剧镜号）"})
                continue
            sh = by_order.get(order)
            if sh is None:
                skipped.append({"seg": raw, "why": f"镜号 {order} 不存在或已停用"})
                continue
            item = find_by_id(str(raw.get("sfx_id") or "").strip())
            if item is None:
                skipped.append({"seg": raw, "why": f"sfx_id={raw.get('sfx_id')} 不在音效库"})
                continue

            # 时长：显式给的优先，否则用素材自身长度。夹在**本镜剩余的输出时长**内
            # —— 一条 5 秒的环境音挂在只剩 1 秒的镜头上，会盖到下一镜去。
            #
            # ⚠️ 用 `shot_output_sec` 而不是 `duration_sec`：变速过的镜头在时间轴上
            # 只占 duration/speed 那么久。拿原始时长当边界，2 倍速的镜头上会允许
            # 一条两倍于画面的音效落进来，实际溢出到下一镜。
            shot_len = shot_output_sec(sh)
            try:
                dur = float(raw.get("duration") or 0) or float(item.get("duration") or 0)
            except (TypeError, ValueError):
                dur = float(item.get("duration") or 0)
            off = max(0.0, float(raw.get("offset_sec") or 0.0))
            src_dur = float(item.get("duration") or 0)
            was = dur
            if shot_len > 0:
                dur = min(dur, max(0.1, shot_len - off))
            if dur <= 0:
                skipped.append({"seg": raw, "why": "时长算出来是 0"})
                continue
            # 被夹短了要如实记下来：这条音效在成片里**只播到一半**。
            # 「音效太长怎么办」的正确回答是**截断**（配一个 0.6 秒的关门动作时
            # 放进 5 秒的关门声，后面 4 秒是空的房间音），不是加速——加速会让
            # 关门声变成一声脆响，跟画面里的动作对不上。
            cut = round(was - dur, 3) if dur < was - 0.01 else 0.0
            try:
                vol = float(raw.get("volume"))
            except (TypeError, ValueError):
                vol = 0.6
            vol = min(1.0, max(0.02, vol))

            cid = uuid.uuid4().hex[:12]
            s.add(AudioClip(
                id=cid, project_id=project_id, kind="sfx",
                text=str(raw.get("reason") or "")[:200] or item.get("name"),
                url=item["url"], duration=round(dur, 3),
                start_shot_order=order, start_offset_sec=round(off, 3),
                volume=round(vol, 3),
                # 截断的音效在源文件里是从中间切断的，波形没有回零；导出侧
                # （`routers/jianying.py`）会给它补 60ms 收尾淡化，这里显式
                # 写 0 而不是 NULL，是因为 NULL 在那里表示"用户没设过"。
                fade_in_sec=0.0, fade_out_sec=(0.06 if cut else 0.0),
                status="done", created_at=now))
            row = {"id": cid, "shot": order, "name": item.get("name"),
                   "offset_sec": round(off, 3), "duration": round(dur, 3),
                   # 回显档位：让模型在落完之后能自己复核"这条是 bed 却只剩 0.4 秒
                   # 是不是放错了"，而不是落完就忘。
                   "usage": item.get("usage")}
            # `bed` 被夹到 1 秒以内 = 一条"缓慢渐入、铺满整段"的铺底音被切成了
            # 一声脆响。这是**真的用错**，值得说一句。
            #
            # ⚠️ 不要拿 `hit` 的时长来判：hit 素材本身就有 1.0~1.9 秒，
            # 按默认时长（不填 duration）落下来必然"超过 1 秒"，那是它的正常长度
            # 而不是错用 —— 第一版就是这么写的，每条 hit 都会触发一次假警报。
            if item.get("usage") == "bed" and dur < 1.0:
                row["hint"] = ("这是「铺满整段」的铺底类，只剩不到 1 秒会变成一声脆响；"
                               "要么把 offset_sec 往前挪，要么改用 hit/accent")
            if cut:
                row["trimmed_sec"] = cut
                row["note"] = (f"素材 {src_dur:.1f}s 比本镜剩余时长长，"
                               f"截掉了 {cut:.1f}s（不加速：加速会让音色变形）")
            made.append(row)
        s.commit()

    if not made:
        return {"ok": False,
                "error": "；".join(x["why"] for x in skipped[:5]) or "没有一条可用的音效",
                "skipped": skipped}
    return {"ok": True, "created": len(made), "segments": made, "skipped": skipped,
            "note": "音效轨已写入；导出剪映时会成为独立的「音效」轨（不影响镜头原声）"}


# ---------------------------------------------------------------------------
# 字幕计划（不花钱：只建 SubtitleClip 行）
# ---------------------------------------------------------------------------

@engine_tool(
    name="apply_subtitle_plan",
    risk="write",
    role="editor",
    description="手工落字幕段。**一般不要用** —— run_auto_subtitles 从音轨转写出来的"
                "字幕带有真实时间码，是唯一和口型对得上的来源。"
                "这个工具只用于**修正个别句子**，或项目里确实没有音轨可转写时。"
                "clips = [{text, start_shot_order, start_offset_sec, duration}]。"
                "text 直接写人话（标点会被自动洗掉、过长的会被自动拆条），"
                "不要把剧本原文整段塞进来。",
)
async def apply_subtitle_plan(ctx: ToolCtx, project_id: str,
                              clips: list[dict],
                              replace: bool = False) -> dict:
    """落字幕段。文本与 ASR 路径走**同一套清洗**（2026-10-24 修）。

    ## 为什么要洗（用户报障）

    「字幕里还有标点符号」。

    根因不是 ASR —— `subtitle_jobs._split_cue` 早就把标点洗掉了。是这里：
    agent 拿**剧本原文**（`三斤二两，抹零，二十八。\\n凤啊，你这刀法比你爹当`）
    调这个工具，而它当时把 text 原样写库。于是：
      · 标点全留在画面上；
      · `\\n` 也留着，在剪映里变成硬换行；
      · 更糟的是它用 `replace=true` **把 ASR 已经对齐好的 29 条字幕整个覆盖**
        —— 那些字幕有真实时间码，换成剧本原文后就只剩"按字数估的"时长。

    现在文本一律过 `_split_cue`（与 ASR 同一个函数）：洗标点、按 `_CUE_MAX_CHARS`
    拆条、在给定的 duration 内按字数分摊。**时长仍然以调用方给的为准**，
    不重新做声学对齐 —— 那件事只有 ASR 能做。
    """
    import uuid
    from datetime import datetime, timezone

    from ..db import SubtitleClip
    from ..subtitle_jobs import _split_cue

    if not clips:
        return {"ok": False, "error": "clips 为空"}

    with get_session() as s:
        orders = {r[0] for r in (s.query(Shot.order)
                                 .filter(Shot.project_id == project_id).all())}
        if replace:
            for old in (s.query(SubtitleClip)
                        .filter(SubtitleClip.project_id == project_id).all()):
                s.delete(old)
        made = 0
        skipped = []
        #: 被拆成多条的入参会被计数，最后如实告诉模型"你给的 12 条变成了 15 条"。
        split_n = 0
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        for c in clips:
            txt = str((c or {}).get("text") or "").strip()
            try:
                order = int(c.get("start_shot_order"))
            except (TypeError, ValueError):
                skipped.append({"clip": c, "why": "start_shot_order 不是整数"})
                continue
            if not txt:
                continue
            if order not in orders:
                skipped.append({"clip": c, "why": f"镜号 {order} 不存在"})
                continue
            dur = float(c.get("duration") or 2.0)
            if dur <= 0:
                skipped.append({"clip": c, "why": "duration 必须 > 0"})
                continue
            off0 = max(0.0, float(c.get("start_offset_sec") or 0.0))
            # 洗标点 + 过长拆条，与 ASR 同一个函数（见 docstring）。
            # `_split_cue` 返回的偏移是**相对传入 start**的，所以要把 off0 加回去。
            cues = _split_cue(txt, off0, dur) or [(txt, off0, dur)]
            if len(cues) > 1:
                split_n += 1
            for piece, st, pdur in cues:
                s.add(SubtitleClip(
                    id=uuid.uuid4().hex[:12], project_id=project_id,
                    text=piece, kind=str(c.get("kind") or "subtitle"),
                    start_shot_order=order,
                    start_offset_sec=max(0.0, st),
                    duration=max(0.1, pdur), style=None, created_at=now))
                made += 1
        s.commit()

    out: dict = {"ok": True, "created": made, "skipped": skipped,
                 "note": "字幕轨已写入；导出剪映时会成为独立的「台词字幕」轨"
                         "（标点已洗掉、过长的已按 20 字拆条，与自动字幕同一套规则）"}
    if split_n:
        out["split_clips"] = split_n
    return out


# ---------------------------------------------------------------------------
# 字幕样式（不花钱：只改 Project.default_profile 里的一个键）
# ---------------------------------------------------------------------------

@engine_tool(
    name="set_subtitle_style",
    risk="write",
    role="manager",
    description="设置项目级字幕样式（字号 / 颜色 / 描边 / 加粗 / 位置 / 距边 / 字体）。"
                "只改传进来的键，其余保留；不传任何键 = 恢复默认。"
                "写进 Project.default_profile.subtitle_style，导出剪映时生效。"
                "fontSize 的单位是**1920 基准像素**（竖屏成片上的实际字号），"
                "位置只能是 bottom/top/center。",
)
async def set_subtitle_style(ctx: ToolCtx, project_id: str,
                             font_size: float | None = None,
                             color: str | None = None,
                             bold: bool | None = None,
                             stroke_width: float | None = None,
                             position: str | None = None,
                             margin_v: float | None = None,
                             font_family: str | None = None,
                             reset: bool = False) -> dict:
    """写项目级字幕样式。

    ## 为什么要在 agent 这边补这个工具

    端点早就有了（`PUT /v2/projects/{id}/subtitle-style`），但 agent 没有对应
    工具。用户说「字幕居中、字号 10、位置 -1868」时，agent 只能回一句
    "不能通过现有工具写入导出设置" —— 而其中**字号和位置是能做的**，
    只有"位置 -1868"这种像素坐标需要用户确认坐标系。

    ## 参数名用蛇形、不直接透传前端字段

    前端存的是 camelCase（`fontSize` / `strokeWidth` / `marginV`），
    那是 `desktop/src/lib/subtitleStyle.ts` 的契约。模型看到的是这层 snake_case
    参数，由本函数映射过去 —— 让模型去记 camelCase 只会多一类拼写错误。

    ## 越界值夹住而不是拒绝

    字号 0 或 9999 都是用户手误，不是恶意。夹到 [8, 200]，其余照写。
    `position` 只认三个值，认不出的**保持原值不动**并回报 ——
    静默改成 bottom 会让用户以为设置了顶部。
    """
    import json

    from ..db import profile_of

    with get_session() as s:
        proj = s.get(Project, project_id)
        if not proj:
            return {"ok": False, "error": f"项目不存在: {project_id}"}
        prof = profile_of(proj)
        old = prof.get("subtitle_style") if isinstance(prof.get("subtitle_style"), dict) else {}

        if reset:
            prof.pop("subtitle_style", None)
            proj.default_profile = json.dumps(prof, ensure_ascii=False) if prof else None
            s.commit()
            return {"ok": True, "style": None, "note": "已恢复默认字幕样式"}

        st = dict(old)
        warnings: list[str] = []

        if font_size is not None:
            try:
                px = float(font_size)
            except (TypeError, ValueError):
                px = 48.0
            clamped = min(200.0, max(8.0, px))
            if clamped != px:
                warnings.append(f"字号 {px:g} 超出可用范围，已改为 {clamped:g}")
            st["fontSize"] = clamped
        if color is not None:
            st["color"] = str(color)
        if bold is not None:
            st["bold"] = bool(bold)
        if stroke_width is not None:
            try:
                st["strokeWidth"] = min(20.0, max(0.0, float(stroke_width)))
            except (TypeError, ValueError):
                warnings.append("strokeWidth 不是数字，已忽略")
        if margin_v is not None:
            try:
                # 1920 基准下画布半高 960；再大就等于越过中线了
                st["marginV"] = min(960.0, max(0.0, float(margin_v)))
            except (TypeError, ValueError):
                warnings.append("marginV 不是数字，已忽略")
        if position is not None:
            pos = str(position).strip().lower()
            if pos in ("bottom", "top", "center"):
                st["position"] = pos
            else:
                warnings.append(f"position={position!r} 不认识（只能是 bottom/top/center），保持原值")
        if font_family is not None:
            st["fontFamily"] = str(font_family)

        if st:
            prof["subtitle_style"] = st
        else:
            prof.pop("subtitle_style", None)
        proj.default_profile = json.dumps(prof, ensure_ascii=False) if prof else None
        s.commit()

    out = {"ok": True, "style": st or None,
           "note": "字幕样式已保存；导出剪映草稿时生效（已在导出过的草稿需要重新导出）"}
    if warnings:
        out["warnings"] = warnings
    return out


@engine_tool(
    name="set_ai_label",
    risk="write",
    role="manager",
    description="设置/关闭成片右下角的 AI 生成标识（例如「内容由AI生成」）。"
                "enabled=False 关闭。写进 Project.default_profile.ai_label，"
                "导出剪映草稿时生成一条覆盖全片的独立文字轨。"
                "fontSize 单位是 1920 基准像素（默认 30，上限 60）；"
                "marginX/marginY 是距右边缘/下边缘的像素（默认 48 / 64）。",
)
async def set_ai_label(ctx: ToolCtx, project_id: str,
                       enabled: bool = True,
                       text: str | None = None,
                       font_size: float | None = None,
                       color: str | None = None,
                       opacity: float | None = None,
                       margin_x: float | None = None,
                       margin_y: float | None = None) -> dict:
    """写项目的 AI 角标配置。

    ## 为什么要有这个工具

    2026-10-23 用户要求「屏幕右下角固定一行小字：内容由AI生成」，而系统里
    **完全没有这个功能** —— agent 只能回"仍需补加"，然后交一份缺标识的成片。
    对短剧投放来说这不是小事：AI 生成内容不标标识有合规风险。

    ## 只改传进来的键

    与 `set_subtitle_style` 同款：不传的键保持原值。关闭用 `enabled=False`
    而不是删配置 —— 用户下次想开时文案/字号还在。
    """
    import json

    from ..db import profile_of

    with get_session() as s:
        proj = s.get(Project, project_id)
        if not proj:
            return {"ok": False, "error": f"项目不存在: {project_id}"}
        prof = profile_of(proj)
        old = prof.get("ai_label") if isinstance(prof.get("ai_label"), dict) else {}

        cfg = dict(old)
        cfg["enabled"] = bool(enabled)
        warnings: list[str] = []

        if text is not None:
            t = str(text).strip()
            if not t:
                warnings.append("text 为空，角标不会生成（等于关闭）")
            cfg["text"] = t
        if font_size is not None:
            try:
                px = float(font_size)
            except (TypeError, ValueError):
                px = 30.0
            clamped = min(60.0, max(12.0, px))
            if clamped != px:
                warnings.append(f"字号 {px:g} 超出角标可用范围（12~60），已改为 {clamped:g}")
            cfg["fontSize"] = clamped
        if color is not None:
            cfg["color"] = str(color)
        if opacity is not None:
            try:
                cfg["opacity"] = min(1.0, max(0.0, float(opacity)))
            except (TypeError, ValueError):
                warnings.append("opacity 不是数字，已忽略")
        for key, val in (("marginX", margin_x), ("marginY", margin_y)):
            if val is not None:
                try:
                    cfg[key] = min(960.0, max(0.0, float(val)))
                except (TypeError, ValueError):
                    warnings.append(f"{key} 不是数字，已忽略")

        prof["ai_label"] = cfg
        proj.default_profile = json.dumps(prof, ensure_ascii=False)
        s.commit()

    out = {"ok": True, "ai_label": cfg,
           "note": ("角标已开启；导出剪映草稿时会生成一条覆盖全片的独立文字轨"
                    if cfg.get("enabled") and (cfg.get("text") or "").strip()
                    else "角标已关闭，导出时不会生成这条轨")}
    if warnings:
        out["warnings"] = warnings
    return out


# ---------------------------------------------------------------------------
# 建项目（账号级）

#: 同一个人、同名项目在这么多秒内再建一次，视为同一次请求的重试，直接回已建的那个。
#: 模型在超时/断线后常会把同一个调用再发一遍；不拦的话列表里会多出一串同名空项目。
_CREATE_DEDUP_SEC = 120


#: 建项目时可选的参考模式。首尾帧、尾帧要每镜单独给图，只在单镜上设（set_shot_overrides）。
#: 不传按全能参考：生产上绝大多数项目用它，也是旧预设（快速验证/一致性/高品质）的默认路线；
#: 不写这一项的话项目落成「自动判定」，没有参考图的镜头会退成纯文本生成。
#: 原先还有 `i2va`（首帧），随首帧路线 2026-11-20 下线而删除。
PROJECT_GENERATION_MODES = ("full_reference", "t2va")


@engine_tool(
    name="create_project",
    risk="write",
    # viewer 档 + 账号级：建项目不属于任何已有项目，任何登录用户都能建（与网页
    # POST /projects 同一口径）。建出来的项目归调用者所有（owner）。
    role="viewer",
    tags=["account"],
    description="新建一个镜流项目（免费）。title 必填；base_aspect 画幅（默认 9:16，"
                "可选 9:16/16:9/3:4/4:3/1:1/21:9）；production_mode 生产模式"
                "（drama 真人剧 / narration 解说剧 / anime 动漫剧，默认 drama）；"
                "art_style 画风 key（留空 = 该模式默认档；可选值见返回的 styles）；"
                "resolution 分辨率（480p/720p/1080p/2k，默认 720p）；"
                "generation_mode 参考模式（full_reference 全能参考：定妆图、场景图作人物与风格参考，推荐，也是默认；"
                "t2va 纯文本：不用参考图，人物最容易变脸）；"
                "video_model 视频模型、image_model 生图模型（可选值先用 list_models 查；留空 = 系统默认）。"
                "**建之前把八项设置逐一跟用户确认**：片名、画幅、生产模式、画风、分辨率、参考模式、视频模型、生图模型；"
                "问模型前先调 list_models 拿可选值，列给用户选（不同模型单价不同）。"
                "用户没提到的项要主动问（可以列出可选值和推荐），不要替用户填默认值；"
                "画幅建好后改不了，尤其要问清。"
                "建完返回 project_id，下一步通常是 import_script 写入剧本，再 run_breakdown 拆镜。",
)
async def create_project(ctx: ToolCtx, title: str, base_aspect: str = "9:16",
                         production_mode: str = "drama", art_style: str = "",
                         resolution: str = "720p", generation_mode: str = "full_reference",
                         video_model: str = "", image_model: str = "") -> dict:
    """建项目。落库走 `routers.project.create_project_record`，与网页端点同一份实现。"""
    from datetime import datetime, timedelta, timezone

    from ..routers.project import ProjectCreate, create_project_record
    from ..routes_v2 import list_production_modes

    name = (title or "").strip()
    if not name:
        return {"ok": False, "error": "片名不能为空"}
    if len(name) > 80:
        return {"ok": False, "error": f"片名太长（{len(name)} 字，上限 80）"}
    if not ctx.user_id:
        # 建出 owner_id=NULL 的项目 = 只有管理员看得见，建的人自己找不到。
        return {"ok": False, "error": "这一轮没有登录者身份，不能建项目"}

    catalog = list_production_modes()
    modes = catalog["modes"]
    mode = (production_mode or "drama").strip()
    if mode not in modes:
        return {"ok": False, "error": f"未知生产模式 {mode}；可选：{', '.join(modes)}"}
    if modes[mode].get("enabled") is False:
        # 网页上这类模式列出但点不动；这里同样不放行。
        return {"ok": False, "error": f"生产模式「{modes[mode].get('label', mode)}」尚未开放"}
    styles = modes[mode].get("styles") or []
    style = (art_style or "").strip() or None
    if style is not None and style not in {s["key"] for s in styles}:
        return {"ok": False, "error": f"画风 {style} 不属于该模式",
                "styles": [{"key": s["key"], "label": s.get("label")} for s in styles]}
    if resolution not in catalog["resolutions"]:
        return {"ok": False, "error": f"不支持的分辨率 {resolution}；可选：{', '.join(catalog['resolutions'])}"}
    gen_mode = (generation_mode or "").strip() or "full_reference"
    if gen_mode not in PROJECT_GENERATION_MODES:
        return {"ok": False, "error": f"不支持的参考模式 {gen_mode}；可选：{', '.join(PROJECT_GENERATION_MODES)}"}
    models, bad = _check_models(video_model, image_model, resolution=resolution)
    if bad:
        return {"ok": False, "error": bad}

    # 重试去重：同一个人 + 同名 + 刚建过 → 回那一个，不再建。
    since = (datetime.now(timezone.utc) - timedelta(seconds=_CREATE_DEDUP_SEC)).isoformat(timespec="seconds")
    with get_session() as s:
        dup = (s.query(Project)
               .filter(Project.owner_id == int(ctx.user_id), Project.title == name,
                       Project.deleted_at.is_(None), Project.created_at >= since)
               .order_by(Project.created_at.desc()).first())
        if dup is not None:
            return {"ok": True, "project_id": dup.id, "title": dup.title,
                    "already_created": True,
                    "note": f"{_CREATE_DEDUP_SEC} 秒内刚建过同名项目，返回的是那一个，没有重复新建"}

    try:
        out = create_project_record(
            ProjectCreate(title=name, base_aspect=base_aspect, production_mode=mode,
                          art_style=style,
                          custom_settings={"resolution": resolution, "generation_mode": gen_mode, **models}),
            owner_id=int(ctx.user_id))
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    label = {s["key"]: s.get("label") for s in styles}
    return {"ok": True, "project_id": out.id, "title": out.title,
            "base_aspect": out.base_aspect, "production_mode": mode,
            "art_style": out.effective_style, "art_style_label": label.get(out.effective_style),
            "resolution": resolution, "generation_mode": gen_mode, **models,
            "next": "项目还是空的：先 import_script 写入剧本，再 run_breakdown 拆镜"}


def _video_models() -> dict[str, dict]:
    from ..providers.registry import registry
    return {v["model_id"]: v for v in registry.list_video() if v.get("enabled", True)}


def _image_models() -> dict[str, dict]:
    from ..providers.image import IMAGE_MODELS
    # 只在生图页可用的（Midjourney：固定四张、不接参考图）不能当项目的资产图模型
    return {m["id"]: m for m in IMAGE_MODELS if not m.get("image_page_only")}


def _check_models(video_model: str, image_model: str, *, resolution: str | None = None) -> tuple[dict, str | None]:
    """校验并整理模型选择，返回（要写进 default_profile 的键, 错误）。空串 = 不设。"""
    out: dict = {}
    vm, im = (video_model or "").strip(), (image_model or "").strip()
    if vm:
        vids = _video_models()
        if vm not in vids:
            return {}, f"没有视频模型 {vm}；可选：{', '.join(vids)}（用 list_models 查）"
        res = vids[vm].get("supported_resolutions") or []
        if resolution and res and resolution not in res:
            return {}, f"视频模型 {vm} 不支持 {resolution}；它支持：{', '.join(res)}"
        out["video_model"] = vm
    if im:
        imgs = _image_models()
        if im not in imgs:
            return {}, f"没有生图模型 {im}；可选：{', '.join(imgs)}（用 list_models 查）"
        out["image_model"] = im
    return out, None


@engine_tool(
    name="list_models",
    risk="read",
    role="viewer",
    tags=["account"],
    description="列出可选的**视频模型**与**生图模型**（id、名字、哪个是系统默认、视频模型支持的分辨率与画幅）。"
                "用户说「用 seedance2.5 / gpt-image2」时先查这里拿准确的 id。不花钱。",
)
async def list_models(ctx: ToolCtx) -> dict:
    from ..config import get_settings
    st = get_settings()
    return {"ok": True,
            "video_models": [{"id": k, "default": k == st.video_model,
                              "resolutions": v.get("supported_resolutions"),
                              "aspect_ratios": v.get("aspect_ratios"),
                              "max_reference_images": v.get("max_reference_images"),
                              "reference_audio": bool(v.get("supports_reference_audio"))}
                             for k, v in _video_models().items()],
            "image_models": [{"id": k, "name": v.get("label"), "default": k == st.image_model}
                             for k, v in _image_models().items()],
            "note": "default=true 是用户不选时的系统默认"}


@engine_tool(
    name="set_project_models",
    risk="write",
    role="manager",
    description="改项目默认的视频模型 / 生图模型 / 分辨率（只改传进来的那几项；模型可选值与各视频模型支持的分辨率用 list_models 查，"
                "分辨率是 480p / 720p / 1080p / 2k）。只影响此后新生成的图与视频，已生成的不变；"
                "不同模型、不同分辨率单价不同，改前告诉用户。",
)
async def set_project_models(ctx: ToolCtx, project_id: str, video_model: str = "",
                             image_model: str = "", resolution: str = "") -> dict:
    from ..jobs import _resolve_project_resolution
    from ..db import profile_of
    from ..shot_timing import RESOLUTION_TIERS

    res = (resolution or "").strip().lower()
    if not (video_model or "").strip() and not (image_model or "").strip() and not res:
        return {"ok": False, "error": "video_model、image_model、resolution 至少传一个"}
    if res and res not in RESOLUTION_TIERS:
        return {"ok": False, "error": f"不支持的分辨率 {resolution}；可选：{', '.join(RESOLUTION_TIERS)}"}
    with get_session() as s:
        proj = s.get(Project, ctx.project_id)
        if proj is None:
            return {"ok": False, "error": "项目不存在"}
        prof = profile_of(proj)
        models, bad = _check_models(video_model, image_model,
                                    resolution=res or _resolve_project_resolution(proj))
        if bad:
            return {"ok": False, "error": bad}
        if res:
            # 只改分辨率时，用项目现在的视频模型核对它支持不支持；模型不在目录里（旧型号）就不拦
            cur = (models.get("video_model") or str(prof.get("video_model") or "")).strip()
            supported = (_video_models().get(cur) or {}).get("supported_resolutions") or []
            if supported and res not in supported:
                return {"ok": False, "error": f"项目的视频模型 {cur} 不支持 {res}；它支持：{', '.join(supported)}"}
            models["resolution"] = res
        before = {k: prof.get(k) for k in models}
        prof.update(models)
        # 只改传进来的键，其余（subtitle_style / image_model_by_kind…）原样写回
        proj.default_profile = json.dumps(prof, ensure_ascii=False)
        s.commit()
    return {"ok": True, "changed": models, "before": before,
            "note": "此后新生成的图与视频按新设置；已生成的不变"}


@engine_tool(
    name="list_voice_library",
    risk="read",
    role="viewer",
    tags=["account"],
    description="列出镜流音色库里的现成音色（id、名字、性别、年龄、风格、url）。音色库可能是空的——"
                "那就让用户上传自己的音频（upload_media 拿 url）。不花钱。",
)
async def list_voice_library(ctx: ToolCtx) -> dict:
    from ..routers.voice import voice_library
    return {"ok": True, **voice_library()}


def _voice_url_ok(url: str) -> bool:
    """只认本平台存过的音频地址（上传素材 / 音色库），不收任意外链。"""
    return url.startswith(("/fw/media/", "/fwp/media/", "/media/"))


@engine_tool(
    name="set_character_voices",
    risk="write",
    role="editor",
    description="给**角色**设音色（真人剧出片时，开口的角色按这段音色说话）。"
                "items = [{asset_id 或 name, voice_url}]；voice_url 用 upload_media 上传本机音频得到的 url，"
                "或 list_voice_library 里的 url；voice_url 传空串 = 清除该角色的音色。一次最多 200 个，不花钱。"
                "设好后，出片时戏份最重的开口角色会自动带上音色；要在某镜点名用谁的音色，用 set_shot_voices。",
)
async def set_character_voices(ctx: ToolCtx, items: list[dict]) -> dict:
    if not items:
        return {"ok": False, "error": "items 为空"}
    if len(items) > _BATCH_MAX:
        return {"ok": False, "error": f"一次最多 {_BATCH_MAX} 条，请分批"}
    results = []
    with get_session() as s:
        for it in items:
            a = _asset_of(s, ctx, {**(it or {}), "kind": "character"})
            label = (it or {}).get("asset_id") or (it or {}).get("name")
            if a is None or a.kind != "character":
                results.append({"asset": label, "ok": False, "error": "找不到这个角色（或同名不止一个，请改用 asset_id）"})
                continue
            url = (it or {}).get("voice_url")
            if not isinstance(url, str):
                results.append({"asset_id": a.id, "name": a.name, "ok": False, "error": "缺 voice_url（清除请传空串）"})
                continue
            url = url.strip()
            if url and not _voice_url_ok(url):
                results.append({"asset_id": a.id, "name": a.name, "ok": False,
                                "error": "voice_url 要是镜流里的音频地址：先用 upload_media 上传本机文件"})
                continue
            previous = a.voice_url
            a.voice_url = url or None
            results.append({"asset_id": a.id, "name": a.name, "ok": True, "cleared": not url,
                            "previous_voice_url": previous})
        s.commit()
    done = sum(1 for r in results if r["ok"])
    return {"ok": done > 0, "written": done, "failed": len(results) - done, "results": results}


@engine_tool(
    name="set_narration_voice",
    risk="write",
    role="editor",
    description="设解说剧的**旁白音色**（整片旁白用这一段声音合成）。voice_url 用 upload_media 上传得到的 url "
                "或 list_voice_library 里的 url；传空串 = 清除。不花钱（合成旁白另算）。",
)
async def set_narration_voice(ctx: ToolCtx, project_id: str, voice_url: str) -> dict:
    url = (voice_url or "").strip()
    if url and not _voice_url_ok(url):
        return {"ok": False, "error": "voice_url 要是镜流里的音频地址：先用 upload_media 上传本机文件"}
    with get_session() as s:
        proj = s.get(Project, ctx.project_id)
        if proj is None:
            return {"ok": False, "error": "项目不存在"}
        previous = proj.narration_voice_url
        proj.narration_voice_url = url or None
        s.commit()
    return {"ok": True, "cleared": not url, "previous_voice_url": previous}


#: 一份飞书文档正文的字数上限（整份正文要经模型生成，太长的通常是把别的东西整段贴进来了）
_FEISHU_DOC_MAX_CHARS = 200_000


@engine_tool(
    name="create_feishu_doc",
    risk="write",
    role="viewer",
    tags=["account"],
    description="替用户新建一份**飞书云文档**，建好后文档归用户本人（在他的飞书「我的空间」里），返回链接。"
                "title 是文档标题；content 是正文（Markdown：# 标题、列表、表格、加粗、代码块都行），"
                "写什么由用户定——用户给了原文就照原文，让你整理（例如分镜表、剧本、进度汇总）就先用读工具查清楚再写。"
                "图片写不进去（会跳过）。不花钱。用户没登录过飞书账号时会失败，告诉他先用飞书扫码登录一次镜流。",
)
async def create_feishu_doc(ctx: ToolCtx, title: str, content: str) -> dict:
    import asyncio

    from .. import feishu_open
    from ..auth import KnownUser

    title = (title or "").strip()
    content = (content or "").strip()
    if not title:
        return {"ok": False, "error": "title 不能为空"}
    if len(title) > 200:
        return {"ok": False, "error": "标题最长 200 字"}
    if not content:
        return {"ok": False, "error": "content 不能为空"}
    if len(content) > _FEISHU_DOC_MAX_CHARS:
        return {"ok": False, "error": f"正文最长 {_FEISHU_DOC_MAX_CHARS} 字，这次 {len(content)} 字：请拆成几份"}
    if not feishu_open.configured():
        return {"ok": False, "error": "服务器没有配置飞书应用，暂时不能建飞书文档"}
    with get_session() as s:
        u = s.get(KnownUser, ctx.user_id) if ctx.user_id else None
        union_id = u.feishu_union_id if u else None
    if not union_id:
        return {"ok": False, "error": "不知道你的飞书账号：请用飞书扫码登录一次镜流，再让我建文档"}
    try:
        doc = await asyncio.to_thread(feishu_open.create_doc, title, content, union_id)
    except feishu_open.FeishuError as e:
        logger.warning("create_feishu_doc 失败 user=%s: %s", ctx.user_id, e)
        return {"ok": False, "error": e.user_text()}
    out = {"ok": True, "title": title, "url": doc["url"], "document_id": doc["document_id"],
           "note": "文档已在你的飞书「我的空间」里，所有者是你本人"}
    if doc["skipped_images"]:
        out["skipped_images"] = doc["skipped_images"]
        out["note"] += f"；正文里 {doc['skipped_images']} 张图片没写进去（飞书文档的图片要在文档里手动插入）"
    return out


#: 读飞书文档时一次返回的字数
_FEISHU_DOC_READ_CHARS = 20_000


def _feishu_union(ctx: ToolCtx) -> str | None:
    from ..auth import KnownUser

    with get_session() as s:
        u = s.get(KnownUser, ctx.user_id) if ctx.user_id else None
        return u.feishu_union_id if u else None


def _open_doc(ctx: ToolCtx, url: str, *, write: bool) -> str:
    """链接 → document_id，并核对**发起人本人**有权限。见 feishu_open 的说明。"""
    from .. import feishu_open

    union_id = _feishu_union(ctx)
    if not union_id:
        raise feishu_open.FeishuError(-1, "不知道你的飞书账号：请用飞书扫码登录一次镜流")
    did = feishu_open.resolve_doc(url)
    perm = feishu_open.doc_perm(did, union_id)
    if perm is None:
        raise feishu_open.FeishuError(-1, "你不是这份文档的所有者或直接协作者，不能经机器人访问它")
    if write and perm == "view":
        raise feishu_open.FeishuError(-1, "你对这份文档只有阅读权限，不能修改")
    return did


@engine_tool(
    name="read_feishu_doc",
    risk="read",
    role="viewer",
    tags=["account"],
    description="读一份飞书云文档的纯文字。只能读用户本人是所有者或直接协作者的文档；"
                "不是机器人建的文档，用户要先在文档里添加镜流应用。不花钱。",
)
async def read_feishu_doc(ctx: ToolCtx, url: str, offset: int = 0) -> dict:
    import asyncio

    from .. import feishu_open

    try:
        did = await asyncio.to_thread(_open_doc, ctx, url, write=False)
        doc = await asyncio.to_thread(feishu_open.read_doc, did)
    except feishu_open.FeishuError as e:
        return {"ok": False, "error": e.user_text()}
    offset = max(0, int(offset or 0))
    part = doc["content"][offset:offset + _FEISHU_DOC_READ_CHARS]
    end = offset + len(part)
    out = {"ok": True, "title": doc["title"], "total_chars": len(doc["content"]), "content": part}
    if end < len(doc["content"]):
        out["next_offset"] = end
    return out


@engine_tool(
    name="edit_feishu_doc",
    risk="write",
    role="viewer",
    tags=["account"],
    description="修改一份飞书云文档，用户本人要有编辑权限。append 传 content（Markdown），写到文档末尾；"
                "replace 传 find 和 replace_with，把 find 全部替换并保留原样式。"
                "返回 unmatched 大于 0 表示有几处跨了加粗等样式没改，要如实告诉用户。不花钱。",
)
async def edit_feishu_doc(ctx: ToolCtx, url: str, action: Literal["append", "replace"], content: str = "",
                          find: str = "", replace_with: str = "") -> dict:
    import asyncio

    from .. import feishu_open

    if action == "append" and not content.strip():
        return {"ok": False, "error": "append 要传 content"}
    if action == "append" and len(content) > _FEISHU_DOC_MAX_CHARS:
        return {"ok": False, "error": f"一次最多写 {_FEISHU_DOC_MAX_CHARS} 字"}
    if action == "replace" and not find:
        return {"ok": False, "error": "replace 要传 find"}
    try:
        did = await asyncio.to_thread(_open_doc, ctx, url, write=True)
        if action == "append":
            out = await asyncio.to_thread(feishu_open.append_doc, did, content)
        else:
            out = await asyncio.to_thread(feishu_open.replace_in_doc, did, find, replace_with)
    except feishu_open.FeishuError as e:
        logger.warning("edit_feishu_doc 失败 user=%s: %s", ctx.user_id, e)
        return {"ok": False, "error": e.user_text()}
    return {"ok": True, **out}


@engine_tool(
    name="remind_me",
    risk="write",
    role="viewer",
    tags=["account"],
    description="到点由飞书机器人私信提醒用户本人，用户开着或关着客户端都能收到。只在用户要求提醒时调用。"
                "text 是提醒内容。at 是到点时间（ISO，例如 2026-11-02T15:00:00+08:00），in_minutes 是几分钟后，二选一。不花钱。",
)
async def remind_me(ctx: ToolCtx, text: str, at: str = "", in_minutes: int = 0) -> dict:
    from datetime import datetime, timedelta, timezone

    from .. import reminders

    now = datetime.now(timezone.utc)
    try:
        if bool(at) == bool(in_minutes):
            raise reminders.ReminderError("at（ISO 时间，如 2026-11-02T15:00:00+08:00）和 in_minutes 要二选一")
        when = reminders.parse_time(at) if at else now + timedelta(minutes=int(in_minutes))
        return {"ok": True, "reminder": reminders.create_time(ctx.user_id, when, text, now)}
    except reminders.ReminderError as e:
        return {"ok": False, "error": str(e)}


@engine_tool(
    name="remind_when_job_done",
    risk="write",
    role="viewer",
    description="任务结束（成功、失败或取消）时由飞书机器人私信提醒用户本人，不用等着，也不用开着客户端。"
                "只在用户要求时调用。不花钱。",
)
async def remind_when_job_done(ctx: ToolCtx, project_id: str, job_id: str, text: str = "去看看结果") -> dict:
    from .. import reminders
    from .tools_read import _job_of_project

    if not _job_of_project(ctx, job_id):
        return {"ok": False, "error": f"任务不存在: {job_id}"}
    try:
        return {"ok": True, "reminder": reminders.create_job(ctx.user_id, job_id, ctx.project_id, text)}
    except reminders.ReminderError as e:
        return {"ok": False, "error": str(e)}


@engine_tool(
    name="list_reminders",
    risk="read",
    role="viewer",
    tags=["account"],
    description="列出用户本人还没发出的飞书提醒。",
)
async def list_reminders(ctx: ToolCtx) -> dict:
    from .. import reminders

    return {"ok": True, "reminders": reminders.list_pending(ctx.user_id)}


@engine_tool(
    name="cancel_reminder",
    risk="write",
    role="viewer",
    tags=["account"],
    description="取消一条还没发出的飞书提醒。",
)
async def cancel_reminder(ctx: ToolCtx, reminder_id: str) -> dict:
    from .. import reminders

    if reminders.cancel(ctx.user_id, reminder_id):
        return {"ok": True}
    return {"ok": False, "error": f"没有这条待发提醒: {reminder_id}"}
