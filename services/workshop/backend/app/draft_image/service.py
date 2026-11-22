"""草稿生图业务编排。

复用 image_studio.providers 生成 + oss_client 转存 + 3x3 切片。
- single: 1 个 image_prompt -> 1 张图
- grid9 : 最多 9 个镜头的 image_prompt 合成 1 张 3x3 大图 -> 切 9 张, 顺序对齐

角色垫图注入: 扫描 prompt 文本, 命中角色名且当前集在该形象适用集内 -> 注入其 oss_key。
"""
from __future__ import annotations

import asyncio
import io
import logging
import re
from datetime import datetime
from typing import Optional

from sqlalchemy import select

from ..db import session_scope
from ..db.models import ScriptVideoPrompt
from ..oss import client as oss_client
from ..image_studio import providers
from ..image_studio.ref_labels import apply_ref_label_map
from .models import (
    DraftCharacter,
    DraftCharacterImage,
    DraftImageTask,
)

logger = logging.getLogger("draft_image")

# 与 image_studio 共用同一通道, 控制本模块并发
_SEM = asyncio.Semaphore(20)
_MAX_ATTEMPTS = 3

GRID_SIZE = 3
GRID_CELLS = GRID_SIZE * GRID_SIZE  # 9


def _probe_size(raw: bytes) -> tuple[Optional[int], Optional[int]]:
    try:
        from PIL import Image
        im = Image.open(io.BytesIO(raw))
        return im.width, im.height
    except Exception:  # noqa: BLE001
        return None, None


def _split_3x3(raw: bytes) -> list[bytes]:
    """3x3 等分切 9 块, 行优先 (左上->右下) 返回 PNG 字节。"""
    from PIL import Image as _Img
    im = _Img.open(io.BytesIO(raw)).convert("RGB")
    W, H = im.size
    cw, ch = W // 3, H // 3
    out: list[bytes] = []
    for r in range(3):
        for c in range(3):
            box = (c * cw, r * ch, (c + 1) * cw if c < 2 else W, (r + 1) * ch if r < 2 else H)
            buf = io.BytesIO()
            im.crop(box).save(buf, format="PNG")
            out.append(buf.getvalue())
    return out


def compose_grid9_prompt(cells: list[dict]) -> str:
    """A 方案: 把最多 9 个镜头的 image_prompt 模板拼接为一个 3x3 网格 prompt。

    cells: [{"pos": 1..9, "shot_index": int, "prompt": str}], 已按顺序。
    """
    n = len(cells)
    header = (
        f"请生成一张 3x3 九宫格组合图 (共 {GRID_CELLS} 个等分格子, 每格一个独立画面), "
        "整体保持统一的角色形象、光线基调与美术风格, 各格之间画面连贯。"
        "格子按从左到右、从上到下编号 1-9。\n"
        "严格要求: 整张图按设定的画面比例输出, 内部精确划分为 3 行 3 列的等大格子 "
        "(每格宽高 = 整图的 1/3), 格子之间不要留白边或文字标注。\n\n"
    )
    lines = []
    for i in range(GRID_CELLS):
        if i < n:
            c = cells[i]
            lines.append(f"【格{i+1}】{(c.get('prompt') or '').strip()}")
        else:
            lines.append(f"【格{i+1}】(留空, 与相邻格同色背景的空镜头)")
    return header + "\n".join(lines)


_NAME_CACHE_TTL = 0  # 不缓存, 直接查


async def _load_character_refs(draft_id: int, chapter_order: int) -> list[tuple[str, list[int], str]]:
    """返回 [(name, episodes, oss_key)], episodes 空表示全集。"""
    async with session_scope() as s:
        chars = (await s.execute(
            select(DraftCharacter).where(DraftCharacter.draft_id == draft_id)
        )).scalars().all()
        char_by_id = {c.id: c.name for c in chars}
        if not char_by_id:
            return []
        imgs = (await s.execute(
            select(DraftCharacterImage).where(
                DraftCharacterImage.character_id.in_(list(char_by_id.keys()))
            ).order_by(DraftCharacterImage.seq, DraftCharacterImage.id)
        )).scalars().all()
    out: list[tuple[str, list[int], str]] = []
    for im in imgs:
        name = char_by_id.get(im.character_id)
        if not name:
            continue
        eps = list(im.episodes or [])
        out.append((name, eps, im.oss_key))
    return out


def _match_refs_for_prompt(
    prompt_text: str,
    chapter_order: int,
    refs: list[tuple[str, list[int], str]],
) -> list[tuple[str, str]]:
    """扫描 prompt 文本, 命中角色名(全词边界) 且当前集适用 -> 收集 (name, oss_key)。

    返回顺序即"参考图顺序", 用于后续把 prompt 里的角色名替换成 图1..图N。
    去重以 oss_key 为准, 上限 9。
    """
    if not prompt_text:
        return []
    pairs: list[tuple[str, str]] = []
    seen: set[str] = set()
    for (name, eps, key) in refs:
        nm = (name or "").strip()
        if not nm:
            continue
        # 适用集过滤: 空=全集
        if eps and chapter_order not in eps:
            continue
        # 中文名直接子串匹配; 含 ASCII 用边界匹配避免误命中
        hit = False
        if re.search(r"[A-Za-z]", nm):
            if re.search(r"\b" + re.escape(nm) + r"\b", prompt_text):
                hit = True
        else:
            if nm in prompt_text:
                hit = True
        if hit and key not in seen:
            seen.add(key)
            pairs.append((nm, key))
        if len(pairs) >= providers.MAX_REF_IMAGES:
            break
    return pairs


async def _load_ref_bytes(keys: list[str]) -> list[bytes]:
    out: list[bytes] = []
    for k in (keys or [])[: providers.MAX_REF_IMAGES]:
        try:
            import tempfile, os as _os
            with tempfile.NamedTemporaryFile(delete=False, suffix=".img") as tf:
                tmp = tf.name
            await oss_client.get_object_to_file_async(k, tmp)
            with open(tmp, "rb") as fh:
                out.append(fh.read())
            _os.unlink(tmp)
        except Exception as e:  # noqa: BLE001
            logger.warning("load draft-image ref %s failed: %s", k, e)
    return out


async def _set_status(task_id: int, *, status: Optional[str] = None,
                      progress: Optional[int] = None, error: Optional[str] = None,
                      result_keys: Optional[list[str]] = None) -> None:
    async with session_scope() as s:
        t = await s.get(DraftImageTask, task_id)
        if not t:
            return
        if status is not None:
            t.status = status
        if progress is not None:
            t.progress = progress
        if error is not None:
            t.error = error[:500]
        if result_keys is not None:
            t.result_keys = result_keys
        t.updated_at = datetime.utcnow()


# ⛔ 2026-10-14: `_public_urls_for_keys` 随 RunningHub 生图一起删除（与 image_studio
# 同款处理）。它只服务于"参考图必须是公网可拉 URL"的 RunningHub；zx1/kege 走
# images/edits 直接传字节，不需要签名 URL，故摘除后没有调用者。


async def _kegeai_gen_with_retries(*, model, prompt, n, size, ref_images):
    """kegeai 通道 (gpt-image-2 / gemini) 生成, 失败重试 _MAX_ATTEMPTS 次。"""
    last = None
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            imgs = await providers.generate(
                model=model, prompt=prompt, n=n, size=size, ref_images=ref_images,
            )
            if imgs:
                return imgs
        except Exception as e:  # noqa: BLE001
            last = e
            logger.warning("draft-image kegeai gen attempt %d/%d failed: %s", attempt, _MAX_ATTEMPTS, e)
            if attempt < _MAX_ATTEMPTS:
                await asyncio.sleep(2 * attempt)
    raise RuntimeError(f"kegeai 生成失败(已重试{_MAX_ATTEMPTS}次): {last}")


async def _gen_with_retries(*, model, prompt, n, size, ref_images, ref_keys=None):
    """生成 (含重试)。

    ## ⚠️ 2026-10-14：与 image_studio 同步 —— RunningHub 生图已摘除

    原先"图生图优先 RunningHub(更便宜)、kegeai 兜底"的优先级链已删除：上游 CN 节点
    合规下线了 RunningHub 的托管生图模型（40310），用户决定直接放弃该渠道。

    现在只有一个路径：交给 providers.generate()，由它内部走 zx1(主) + kege(兜底)。
    参考图以字节直接进 images/edits，不再需要签公网 URL —— 这也是 `ref_keys` 现在
    不被使用的原因（保留参数以免与调用方同时改动）。

    剧本配图因此**不再有 RunningHub 兜底**，全部压在 zx1/kege 上（用户已确认这两家
    的并发与成本可承接）。
    """
    return await _kegeai_gen_with_retries(
        model=model, prompt=prompt, n=n, size=size, ref_images=ref_images,
    )


async def run_task(task_id: int) -> None:
    """执行一张生图任务卡 (single 或 grid9)。"""
    async with _SEM:
        await _set_status(task_id, status="running", progress=10)
        try:
            async with session_scope() as s:
                t = await s.get(DraftImageTask, task_id)
                if not t:
                    return
                draft_id = t.draft_id
                user_id = t.user_id
                chapter_order = t.chapter_order
                mode = t.mode
                prompt = t.image_prompt or ""
                model = t.model or "gpt-image-2"
                size = t.size or "2048x2048"
                ref_keys = list(t.ref_image_keys or [])
                ref_labels = list(t.ref_labels or [])

            # 角色名 → 图N 替换 (后端隐式, 只改送模型的 prompt; image_prompt 原文不变)
            if ref_labels:
                prompt = apply_ref_label_map(prompt, ref_labels)

            ref_images = await _load_ref_bytes(ref_keys) if ref_keys else None
            await _set_status(task_id, progress=30)

            if mode == "grid9":
                # 合成图锁 1:1, 取较大边长保证切后清晰
                images = await _gen_with_retries(
                    model=model, prompt=prompt, n=1, size=size, ref_images=ref_images,
                    ref_keys=ref_keys,
                )
                if not images:
                    raise RuntimeError("无产出图")
                await _set_status(task_id, progress=70)
                slices = _split_3x3(images[0])
                # 只保留与 shot_indexes 对应数量的切片
                async with session_scope() as s:
                    t = await s.get(DraftImageTask, task_id)
                    keep = len(list(t.shot_indexes or [])) if t else GRID_CELLS
                result_keys: list[str] = []
                for idx, sb in enumerate(slices[:keep]):
                    key = oss_client.build_oss_key(
                        user_id=user_id, filename=f"draftimg_{draft_id}_{task_id}_{idx}.png",
                        namespace="draft-image",
                    )
                    await oss_client.put_object_async(key, sb)
                    result_keys.append(key)
                await _set_status(task_id, status="succeeded", progress=100, result_keys=result_keys)
            else:
                # single
                images = await _gen_with_retries(
                    model=model, prompt=prompt, n=1, size=size, ref_images=ref_images,
                    ref_keys=ref_keys,
                )
                if not images:
                    raise RuntimeError("无产出图")
                await _set_status(task_id, progress=70)
                key = oss_client.build_oss_key(
                    user_id=user_id, filename=f"draftimg_{draft_id}_{task_id}_0.png",
                    namespace="draft-image",
                )
                await oss_client.put_object_async(key, images[0])
                await _set_status(task_id, status="succeeded", progress=100, result_keys=[key])
        except Exception as e:  # noqa: BLE001
            logger.exception("draft-image task %s failed", task_id)
            await _set_status(task_id, status="failed", error=str(e))


async def build_tasks_for_episode(
    *,
    draft_id: int,
    user_id: int,
    chapter_order: int,
    mode: str,
    model: str,
    size: str,
) -> list[int]:
    """按某集的 prompts(image_prompt) + 模式, 重建该集任务卡, 返回 task_id 列表。

    会先删除该集旧任务卡 (幂等)。none 模式不建卡。
    """
    if mode == "none":
        async with session_scope() as s:
            old = (await s.execute(
                select(DraftImageTask).where(
                    DraftImageTask.draft_id == draft_id,
                    DraftImageTask.chapter_order == chapter_order,
                )
            )).scalars().all()
            for o in old:
                await s.delete(o)
        return []

    # 取该集 prompts (有 image_prompt 的, 按 task_index)
    async with session_scope() as s:
        rows = (await s.execute(
            select(ScriptVideoPrompt).where(
                ScriptVideoPrompt.draft_id == draft_id,
                ScriptVideoPrompt.chapter_order == chapter_order,
            ).order_by(ScriptVideoPrompt.task_index)
        )).scalars().all()
        prompt_rows = [
            {"task_index": r.task_index, "image_prompt": r.image_prompt or ""}
            for r in rows
        ]

    refs = await _load_character_refs(draft_id, chapter_order)

    # 删旧
    async with session_scope() as s:
        old = (await s.execute(
            select(DraftImageTask).where(
                DraftImageTask.draft_id == draft_id,
                DraftImageTask.chapter_order == chapter_order,
            )
        )).scalars().all()
        for o in old:
            await s.delete(o)

    new_ids: list[int] = []
    valid = [p for p in prompt_rows if (p["image_prompt"] or "").strip()]
    if not valid:
        return []

    if mode == "grid9":
        # 合成大图: 保持用户所选画面比例, 放大到适合切 9 格的尺寸
        grid_size = _grid_size(size)
        async with session_scope() as s:
            for gi in range(0, len(valid), GRID_CELLS):
                chunk = valid[gi:gi + GRID_CELLS]
                cells = [
                    {"pos": i + 1, "shot_index": c["task_index"], "prompt": c["image_prompt"]}
                    for i, c in enumerate(chunk)
                ]
                shot_indexes = [c["task_index"] for c in chunk]
                composed = compose_grid9_prompt(cells)
                # 垫图: 合并该组所有 prompt 命中的角色
                merged_text = "\n".join(c["image_prompt"] for c in chunk)
                matched = _match_refs_for_prompt(merged_text, chapter_order, refs)
                ref_keys = [k for (_n, k) in matched]
                ref_labels = [n for (n, _k) in matched]
                # image_prompt 存原文 (前端只显示原文); 角色名→图N 替换在生成时(run_task)做
                task = DraftImageTask(
                    draft_id=draft_id, user_id=user_id, chapter_order=chapter_order,
                    mode="grid9", group_index=gi // GRID_CELLS,
                    shot_indexes=shot_indexes, image_prompt=composed,
                    status="pending", model=model, size=grid_size,
                    ref_image_keys=ref_keys or None,
                    ref_labels=ref_labels or None,
                )
                s.add(task)
                await s.flush()
                new_ids.append(task.id)
    else:  # single
        async with session_scope() as s:
            for gi, c in enumerate(valid):
                matched = _match_refs_for_prompt(c["image_prompt"], chapter_order, refs)
                ref_keys = [k for (_n, k) in matched]
                ref_labels = [n for (n, _k) in matched]
                # image_prompt 存原文 (前端只显示原文); 角色名→图N 替换在生成时(run_task)做
                task = DraftImageTask(
                    draft_id=draft_id, user_id=user_id, chapter_order=chapter_order,
                    mode="single", group_index=gi,
                    shot_indexes=[c["task_index"]], image_prompt=c["image_prompt"],
                    status="pending", model=model, size=size,
                    ref_image_keys=ref_keys or None,
                    ref_labels=ref_labels or None,
                )
                s.add(task)
                await s.flush()
                new_ids.append(task.id)
    return new_ids


def _grid_size(size: str) -> str:
    """grid9 合成大图: 保持用户所选画面比例, 放大每格到 ≥ ~853px。

    切后单格 = 整图的 1/3, 为保证清晰, 把整图长边放大到至少 2560 (≈每格 853),
    上限 4096。比例严格沿用用户选择 (不再强制正方形)。
    """
    try:
        w, h = (int(x) for x in str(size).lower().split("x"))
        if w <= 0 or h <= 0:
            raise ValueError
    except Exception:  # noqa: BLE001
        return "2560x2560"
    long_edge = max(w, h)
    target_long = max(long_edge, 2560)
    target_long = min(target_long, 4096)
    scale = target_long / long_edge
    nw = max(64, int(round(w * scale / 24)) * 24)  # 24 = 3格 × 8 对齐
    nh = max(64, int(round(h * scale / 24)) * 24)
    return f"{nw}x{nh}"


def kick_off(task_ids: list[int]) -> None:
    for tid in task_ids:
        asyncio.create_task(run_task(tid))