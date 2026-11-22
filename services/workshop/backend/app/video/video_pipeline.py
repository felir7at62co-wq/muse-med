"""视频→剧本 端到端流水线(引擎: 豆包/方舟, TOS+Files API 整片反推)

用户上传 N 个视频文件 → 创建 1 个 script_draft → 每集(一文件=一集, 不切段):
  1. 调用豆包整片反推单集视频,拿到 {title,synopsis,characters(真名),full_text,shots}
  2. 写入 script_chapters + script_storyboards (chapter_order = i+1)
  3. 合并 characters_in_episode 到 draft.outline.characters(跨集去重)
  4. 通过 generation_logs 汇报进度,供前端日志面板展示

失败单集不拉整个任务:抛异常只标记该集 failed,允许 UI 后续重推。
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm.attributes import flag_modified

from ..db import (
    ScriptChapter,
    ScriptDraft,
    ScriptStoryboard,
    session_scope,
)
from ..stages.log_helper import save_log
from ..factory.usage import set_usage_context
# 引擎: 豆包(方舟)视频反推 — TOS + Files API 整片上传(2GB), 原画质, 无需本地降规格/切片。
# 旧 gemini_video(base64 内联, 128MB 限制, 需降帧率切片)已停用, 保留文件供参考。
from ..muse_reverse import analyze_video_file, reserve_revisions

logger = logging.getLogger("video.pipeline")


# ---------------------------------------------------------------------------
# 核心: 单集处理
# ---------------------------------------------------------------------------
async def _process_single_episode(
    draft_id: int,
    episode_order: int,
    video_source: str,
    draft_title: str,
    known_characters: list[dict],
    model: str = "",
    *,
    revision: str | None = None,
    source_kind: str = "local",  # "local"=本地文件路径 / "oss"=TOS 对象 key
    user_id: int | None = None,
) -> dict[str, Any]:
    """处理一集视频(豆包整片反推),返回识别出的角色列表。

    video_source: source_kind="local" 时为本地文件路径; ="oss" 时为 TOS 对象 key。
    失败时自动重试 1 次(常见于网络抖动/上游冷启动)。

    user_id: 计费归属。火山视频理解按 token 计费, 必须逐层透传到
    analyze_video_file 的 record_usage, 否则这条消耗就永远统计不到人。
    """
    _src_name = video_source if source_kind == "oss" else Path(video_source).name
    await save_log(draft_id, "video_analyze", f"第{episode_order}集 开始分析视频({_src_name})",
                   "log", episode_order)
    t0 = time.time()

    max_attempts = 1
    last_err: Exception | None = None
    result = None
    for attempt in range(1, max_attempts + 1):
        try:
            if source_kind == "oss":
                result = await analyze_video_file(
                    draft_title=draft_title,
                    episode_order=episode_order,
                    known_characters=known_characters,
                    oss_key=video_source, revision=revision,
                    user_id=user_id,
                    draft_id=draft_id,
                )
            else:
                result = await analyze_video_file(
                    video_path=video_source, revision=revision,
                    draft_title=draft_title,
                    episode_order=episode_order,
                    known_characters=known_characters,
                    user_id=user_id,
                    draft_id=draft_id,
                )
            if attempt > 1:
                logger.info("ep %d 在第 %d 次尝试后成功", episode_order, attempt)
            break
        except Exception as e:
            last_err = e
            logger.warning(
                "ep %d attempt %d/%d failed: %s: %s",
                episode_order, attempt, max_attempts, type(e).__name__, str(e) or repr(e),
            )
            if attempt < max_attempts:
                await save_log(
                    draft_id, "video_analyze",
                    f"第{episode_order}集 第{attempt}次尝试失败({type(e).__name__}),正在重试...",
                    "log", episode_order,
                )
                # 短暂退避,避免代理连续失败
                await asyncio.sleep(5)

    if result is None:
        # 所有尝试都失败
        err_msg = (str(last_err) if last_err else "").strip()
        err_type = type(last_err).__name__ if last_err else "Unknown"
        display = err_msg if err_msg else repr(last_err) if last_err else "(无异常信息)"
        logger.exception("ep %d analyze failed after %d attempts", episode_order, max_attempts)
        await save_log(
            draft_id, "video_analyze",
            f"第{episode_order}集 分析失败 ({err_type}): {display[:300]}",
            "error", episode_order,
            {"error_type": err_type, "error_msg": display[:600]},
        )
        if last_err:
            raise last_err
        raise RuntimeError(f"第{episode_order}集 未知失败")

    elapsed = int(time.time() - t0)
    ep_title = result.get("episode_title") or f"第{episode_order}集"
    ep_synopsis = result.get("episode_synopsis") or ""
    full_text = result.get("full_text") or ""
    shots = result.get("shots") or []
    chars = result.get("characters_in_episode") or []

    # 落库 chapter + storyboard
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id, with_for_update=True)
        outline = dict(draft.outline or {})
        pending = dict(outline.get("muse_reverse_pending") or {})
        expected = pending.pop(str(episode_order), None)
        if expected and expected != result["muse_materials"]["revision"]:
            raise RuntimeError("本集已有更新的反推任务")
        if pending:
            outline["muse_reverse_pending"] = pending
        else:
            outline.pop("muse_reverse_pending", None)
        outputs = dict(outline.get("muse_reverse") or {})
        outputs[str(episode_order)] = result["muse_materials"]
        outline["muse_reverse"] = outputs
        draft.outline = outline
        # chapter(如果已存在就覆盖)
        existing_ch = (await s.execute(
            select(ScriptChapter).where(
                ScriptChapter.draft_id == draft_id,
                ScriptChapter.chapter_order == episode_order,
            )
        )).scalar_one_or_none()
        if existing_ch:
            existing_ch.title = ep_title
            existing_ch.full_text = full_text
            existing_ch.summary = ep_synopsis
            existing_ch.word_count = len(full_text)
            existing_ch.is_stale = 0
            existing_ch.locked = 1
        else:
            s.add(ScriptChapter(
                draft_id=draft_id,
                chapter_order=episode_order,
                title=ep_title,
                full_text=full_text,
                summary=ep_synopsis,
                word_count=len(full_text),
                locked=1,
                is_stale=0,
                version=1,
            ))

        # storyboard:仅当本集真有 shots 内容时才落库;
        # 视频反推目前不返回 shots,留空让用户后续点"全部生成"用 DeepSeek 基于章节正文生成。
        if shots:
            existing_sb = (await s.execute(
                select(ScriptStoryboard).where(
                    ScriptStoryboard.draft_id == draft_id,
                    ScriptStoryboard.chapter_order == episode_order,
                )
            )).scalar_one_or_none()
            if existing_sb:
                existing_sb.shots_json = shots
                existing_sb.is_stale = 0
                flag_modified(existing_sb, "shots_json")
            else:
                s.add(ScriptStoryboard(
                    draft_id=draft_id,
                    chapter_order=episode_order,
                    shots_json=shots,
                    is_stale=0,
                    version=1,
                ))

    await save_log(
        draft_id, "video_analyze",
        f"第{episode_order}集 完成: {len(full_text)}字, {len(shots)}镜, 角色 {len(chars)} 人, 耗时 {elapsed}s",
        "done", episode_order,
        {"episode_title": ep_title, "characters_count": len(chars), "elapsed_s": elapsed},
    )
    return chars


def _merge_characters(existing: list[dict], new_chars: list[dict]) -> list[dict]:
    """按 alias 合并角色卡列表,相同 alias 合并 appearance(取更长的)"""
    by_alias: dict[str, dict] = {}
    for c in existing or []:
        if isinstance(c, dict) and c.get("alias"):
            by_alias[c["alias"]] = dict(c)
    for c in new_chars or []:
        if not isinstance(c, dict):
            continue
        alias = c.get("alias")
        if not alias:
            continue
        if alias not in by_alias:
            by_alias[alias] = dict(c)
        else:
            # 已存在 → 保留较长的外貌描述
            old = by_alias[alias]
            if len(c.get("appearance", "")) > len(old.get("appearance", "")):
                old["appearance"] = c["appearance"]
            if c.get("role") and not old.get("role"):
                old["role"] = c["role"]
    # 排序: 男1,男2,...,女1,女2,...,老1,童1,路人,旁白
    def _sort_key(c: dict) -> tuple:
        a = c.get("alias", "")
        head_order = {"男": 0, "女": 1, "老": 2, "童": 3}
        if a in ("路人",):
            return (9, 0)
        if a in ("旁白",):
            return (9, 1)
        if a and a[0] in head_order:
            import re
            m = re.search(r"\d+", a)
            return (head_order[a[0]], int(m.group(0)) if m else 999)
        return (8, 0)
    return sorted(by_alias.values(), key=_sort_key)


# ---------------------------------------------------------------------------
# 对外入口: 一次上传 N 集 → 一次任务
# ---------------------------------------------------------------------------
async def run_video_to_script_pipeline(
    draft_id: int,
    video_paths: list[str] | None = None,
    draft_title: str = "",
    model: str = "",
    concurrency: int = 1,
    cleanup_files: bool = True,
    *,
    episode_paths: dict[int, str] | None = None,
    episode_oss_keys: dict[int, str] | None = None,
    user_id: int | None = None,
    skip_existing: bool = False,
    revision: str | None = None,
) -> None:
    """一个 draft 下的多集视频并发分析(豆包整片反推),全部落库。

    数据来源三选一(优先级 episode_oss_keys > episode_paths > video_paths):
        video_paths:       顺序本地文件路径列表(upload/from-url 初次反推, order = i+1)
        episode_paths:     {order: 本地文件路径}(本地文件重试场景)
        episode_oss_keys:  {order: TOS 对象 key}(from-oss 入口, 豆包直接从 TOS 整片反推,
                           不落本地盘, 天然支持并发反推)

    skip_existing: 断点续跑用。已经有正文的集直接跳过、不重新调豆包
      (见 video_routes.resume_interrupted)。默认 False = 全量覆盖,保持原语义。
      每集反推要烧一次视频理解 token, 续跑时重算已完成的集纯属浪费;
      但**绝不能**默认开——"全部重新反推"是用户明确会点的动作。

    真名模式 + 跨集姓名沿用:
      - concurrency<=1(按集顺序串行, 推荐): 每集把"前面各集已识别的姓名+外貌+服装"作为
        已知人物表注入提示词, 本集出现同一人时沿用其姓名 → 即使某集没喊出名字也不会退化成
        "黑衣男"这类外观称呼。这是保证人物姓名跨集一致的关键, 建议默认用串行。
      - concurrency>1(并行): 各集同时反推, 后面集看不到前面集结果, 只能用初始已有角色做提示,
        跨集姓名一致性明显较弱。追求姓名准确请用串行。

    完成后:
    - draft.outline.characters 合并所有集角色(按真名去重)
    - draft.outline.video_paths 记录 {order: path}(仅本地来源, 失败集保留供重试; oss 来源不记录)
    - draft.status 全部成功置 imported

    user_id: 计费归属。既随参透传到每集的 record_usage, 也在此播种进归属上下文,
    供本流水线内部后续新增的其它 LLM 调用兜底。
    """
    # 播种归属: 本入口可能由后台协程/守护进程调用(无请求上下文), 显式盖章才不会丢人
    set_usage_context(job_id=None, user_id=user_id, source="video_pipeline")
    # 归一化为 (order, source, source_kind) 列表
    if episode_oss_keys:
        items: list[tuple[int, str, str]] = [
            (o, k, "oss") for o, k in sorted(episode_oss_keys.items())
        ]
    elif episode_paths:
        items = [(o, p, "local") for o, p in sorted(episode_paths.items())]
    else:
        items = [(i, p, "local") for i, p in enumerate(video_paths or [], start=1)]

    if not items:
        return
    if revision:
        await reserve_revisions(draft_id, [item[0] for item in items], revision)

    # 断点续跑: 已经有正文的集直接从待办里摘掉。
    # ⚠️ 必须在"写日志"之前摘, 否则日志里会出现"共 60 集"而实际只跑 3 集,
    # 用户看着进度条永远走不满, 反而以为又卡住了。
    skipped_orders: list[int] = []
    if skip_existing:
        already = await _orders_with_text(draft_id)
        if already:
            skipped_orders = sorted(o for o, _, _ in items if o in already)
            items = [(o, src, kind) for o, src, kind in items if o not in already]
            if not items:
                await save_log(
                    draft_id, "video_done",
                    f"断点续跑: {len(skipped_orders)} 集已有正文, 无需重跑",
                    "done", 0, {"skipped_orders": skipped_orders},
                )
        if skipped_orders:
            await save_log(
                draft_id, "video_ingest",
                f"断点续跑: 跳过已完成的 {len(skipped_orders)} 集"
                f"(第{skipped_orders[0]}~{skipped_orders[-1]}集), 只补剩下的 {len(items)} 集",
                "log", 0, {"skipped_orders": skipped_orders, "todo_orders": [o for o, _, _ in items]},
            )

    await save_log(
        draft_id, "video_ingest",
        f"开始视频反推剧本,共 {len(items)} 集,并发={concurrency}",
        "log", 0,
        {"video_count": len(items), "model": model, "episode_orders": [o for o, _, _ in items]},
    )

    # 只把"本地文件"来源落到 outline.video_paths(供失败重试定位); oss 来源不落盘、不记录
    local_items = [(o, src) for o, src, kind in items if kind == "local"]
    if local_items:
        await _update_outline_video_paths(draft_id, local_items)

    all_characters = await _load_outline_characters(draft_id)
    success_count = 0
    fail_count = 0
    success_orders: set[int] = set()
    failed_orders: set[int] = set()

    if concurrency <= 1:
        # 串行模式
        for order, src, kind in items:
            ok = False
            try:
                ep_chars = await _process_single_episode(
                    draft_id, order, src, draft_title, all_characters,
                    model=model, source_kind=kind, user_id=user_id, revision=revision,
                )
                all_characters = _merge_characters(all_characters, ep_chars)
                success_count += 1
                success_orders.add(order)
                ok = True
                # 每集完成后增量刷新 outline,让前端实时看到大纲/章节
                await _refresh_outline_partial(draft_id, all_characters, draft_title)
            except Exception:
                fail_count += 1
                failed_orders.add(order)
            finally:
                if ok and cleanup_files and kind == "local":
                    try:
                        os.remove(src)
                    except Exception:
                        pass
    else:
        # 并行模式: 一次性把所有集发出去(真名模式下并发不牺牲角色一致性)
        sem = asyncio.Semaphore(concurrency)
        baseline_chars = list(all_characters)

        async def _wrap(order: int, src: str, kind: str):
            nonlocal success_count, fail_count
            async with sem:
                ok = False
                try:
                    ep_chars = await _process_single_episode(
                        draft_id, order, src, draft_title, baseline_chars,
                        model=model, source_kind=kind, user_id=user_id, revision=revision,
                    )
                    success_count += 1
                    success_orders.add(order)
                    ok = True
                    return ep_chars
                except Exception:
                    fail_count += 1
                    failed_orders.add(order)
                    return []
                finally:
                    if ok and cleanup_files and kind == "local":
                        try:
                            os.remove(src)
                        except Exception:
                            pass

        results = await asyncio.gather(*[_wrap(o, src, kind) for o, src, kind in items])
        for r in results:
            all_characters = _merge_characters(all_characters, r)
        await _refresh_outline_partial(draft_id, all_characters, draft_title)

    # 更新 outline.video_paths:成功的剔除,失败的保留
    await _prune_video_paths(draft_id, success_orders)

    # 最终汇总
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if d:
            # 合并 outline
            outline = dict(d.outline or {})
            outline.setdefault("title", d.title or draft_title)
            outline["characters"] = all_characters
            # 从 chapters 里提取 episodes 概要
            chs = (await s.execute(
                select(ScriptChapter).where(ScriptChapter.draft_id == draft_id)
                .order_by(ScriptChapter.chapter_order)
            )).scalars().all()
            outline["chapters"] = [
                {
                    "order": c.chapter_order,
                    "title": c.title or f"第{c.chapter_order}集",
                    "synopsis": (c.summary or "")[:200],
                    "must_have": [],
                    "characters": [],
                    "locked": True,
                    "version": 1,
                }
                for c in chs
            ]
            outline.setdefault("synopsis", f"从视频反推的剧本,共 {len(chs)} 集")
            d.outline = outline
            # 总集数用已有章节数(避免重试场景 episode_count 被覆盖变小)
            d.episode_count = max(d.episode_count or 0, len(chs))
            d.outline_locked = 1
            # 全部成功 → imported。
            # 有失败时**不能**再一律留 video_running: 那条规则本意是"UI 提示仍有失败剧集",
            # 但后台协程此刻已经结束, 草稿卡在 video_running 就等于永远显示"生成中",
            # 用户以为还在跑、其实早停了(2026-09-15 一次部署打断 5 个草稿就是这么暴露的)。
            # 改成: 素材还在(能接着跑)→ interrupted;彻底没得跑 → failed。
            if fail_count == 0:
                d.status = "imported"
            else:
                try:
                    _left = await resume_sources(draft_id)
                except Exception:  # noqa: BLE001
                    _left = None
                d.status = "interrupted" if _left else "failed"
            flag_modified(d, "outline")

    await save_log(
        draft_id, "video_done",
        f"视频反推完成: 成功 {success_count}/{len(items)} 集, 失败 {fail_count}",
        "done" if fail_count == 0 else "error", 0,
        {
            "success": success_count,
            "failed": fail_count,
            "total": len(items),
            "success_orders": sorted(success_orders),
            "failed_orders": sorted(failed_orders),
        },
    )


async def orders_with_text(draft_id: int) -> set[int]:
    """已经有正文(非空 full_text)的集号。断点续跑据此跳过已完成的集。

    公开命名(不带下划线): main.py 的启动恢复和 video_routes 的续跑端点都要用它,
    两边都得判断"这个草稿到底还有没有没做完的集"。
    """
    async with session_scope() as s:
        rows = (await s.execute(
            select(ScriptChapter.chapter_order, ScriptChapter.full_text)
            .where(ScriptChapter.draft_id == draft_id)
        )).all()
        draft = await s.get(ScriptDraft, draft_id)
        pending = ((draft.outline or {}).get("muse_reverse_pending") or {}) if draft else {}
    return {int(o) for o, t in rows if o is not None and (t or "").strip() and str(o) not in pending}


# 旧名保留: 同模块内的流水线跳过逻辑仍按原名调用
_orders_with_text = orders_with_text


async def _characters_from_done_episodes(draft_id: int) -> list[dict]:
    """从"已完成集"的正文反推角色表, 给续跑用。

    真正可靠的来源是 outline.characters 里已合并的条目, 但它按"跑过的集"累积,
    续跑时用它是安全的; 这里是它为空时的兜底(例如 outline 被手改过)。
    """
    return await _load_outline_characters(draft_id)


async def resume_sources(draft_id: int) -> dict[int, str] | None:
    """给一个被中断的 draft 找回"还没做完那些集"的视频来源; 找不到返回 None。

    来源优先级:
      1. episode_oss_keys —— OSS/TOS 直传的新流程会把 60 个 key 按上传顺序存进 outline。
         这是唯一**保留原始顺序**的信息: source_oss_keys 是用户勾选上传的顺序,
         集号 = 在列表里的位置。
      2. video_paths —— 本地文件流程留下的 {order: path}, 只含失败集(成功的会被 prune)。

    ⚠️ 没有这个函数时, OSS 直传的 draft 一旦被中断就**永远救不回来**:
    它 outline.video_paths 是空的(不落本地盘), retry-failed 会直接 400
    "没有可重试的集", 而实际素材还原封不动躺在 TOS 里。
    """
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return None
        outline = d.outline or {}
        keys = outline.get("episode_oss_keys")
        if isinstance(keys, dict) and keys:
            out: dict[int, str] = {}
            for k, v in keys.items():
                if isinstance(v, str) and v:
                    try:
                        out[int(k)] = v
                    except (TypeError, ValueError):
                        continue
            if out:
                return out
        src_keys = outline.get("source_oss_keys")
        if isinstance(src_keys, list) and src_keys:
            # 位置 = 集号(与 from-oss 入口 episode_oss_keys 的构造方式一致)
            return {i: k for i, k in enumerate(src_keys, start=1) if isinstance(k, str) and k}
        pending = outline.get("video_paths")
        if isinstance(pending, dict) and pending:
            out2: dict[int, str] = {}
            for k, v in pending.items():
                if isinstance(v, str) and v and os.path.exists(v):
                    try:
                        out2[int(k)] = v
                    except (TypeError, ValueError):
                        continue
            if out2:
                return out2
    return None


async def _update_outline_characters(draft_id: int, characters: list[dict]) -> None:
    """把 characters 写回 draft.outline(用于每集完成后的实时更新)"""
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return
        outline = dict(d.outline or {})
        outline["characters"] = characters
        d.outline = outline
        flag_modified(d, "outline")


async def _refresh_outline_partial(draft_id: int, characters: list[dict], draft_title: str) -> None:
    """每集完成后的部分刷新:更新 characters + chapters + outline_locked,
    让前端在反推过程中也能实时看到当前进度。
    """
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return
        outline = dict(d.outline or {})
        outline.setdefault("title", d.title or draft_title)
        outline["characters"] = characters
        chs = (await s.execute(
            select(ScriptChapter).where(ScriptChapter.draft_id == draft_id)
            .order_by(ScriptChapter.chapter_order)
        )).scalars().all()
        outline["chapters"] = [
            {
                "order": c.chapter_order,
                "title": c.title or f"第{c.chapter_order}集",
                "synopsis": (c.summary or "")[:200],
                "must_have": [],
                "characters": [],
                "locked": True,
                "version": 1,
            }
            for c in chs
        ]
        if "synopsis" not in outline or not outline.get("synopsis"):
            outline["synopsis"] = f"从视频反推的剧本(进行中,已完成 {len(chs)} 集)"
        d.outline = outline
        d.outline_locked = 1
        if (d.episode_count or 0) < len(chs):
            d.episode_count = len(chs)
        flag_modified(d, "outline")


async def _load_outline_characters(draft_id: int) -> list[dict]:
    """加载已有的角色列表(用于重试场景保留跨集一致性)"""
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d or not isinstance(d.outline, dict):
            return []
        chars = d.outline.get("characters") or []
        return list(chars) if isinstance(chars, list) else []


async def _update_outline_video_paths(draft_id: int, items: list[tuple[int, str]]) -> None:
    """把 {order: path} 合并写进 outline.video_paths,便于失败重试时定位文件"""
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return
        outline = dict(d.outline or {})
        vp = dict(outline.get("video_paths") or {})
        for order, path in items:
            vp[str(order)] = path
        outline["video_paths"] = vp
        d.outline = outline
        flag_modified(d, "outline")


async def _prune_video_paths(draft_id: int, success_orders: set[int]) -> None:
    """把已成功的 order 从 outline.video_paths 中移除(磁盘文件也已删)"""
    if not success_orders:
        return
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return
        outline = dict(d.outline or {})
        vp = dict(outline.get("video_paths") or {})
        for order in success_orders:
            vp.pop(str(order), None)
        outline["video_paths"] = vp
        d.outline = outline
        flag_modified(d, "outline")
