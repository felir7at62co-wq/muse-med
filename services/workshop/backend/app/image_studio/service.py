"""image_studio 业务编排: 生成 -> 转存 OSS -> 写 image_assets, 全程实时写 image_jobs 状态。

抗重启: 每步把 status/progress 写库; 生成型任务为本地协程, 重启会中断,
lifespan 恢复逻辑把残留 running 标记为 interrupted (不无差别清 failed)。
"""
from __future__ import annotations

import asyncio
import io
import logging
from datetime import datetime
from typing import Optional

from sqlalchemy import select

from ..db import session_scope
from ..oss import client as oss_client
from . import providers
from . import workflows as _wf
from .models import ImageAsset, ImageJob

logger = logging.getLogger("image_studio")

# kegeai 通道限速, 控制全局并发
_SEM = asyncio.Semaphore(100)  # 后台调度并发上限; 超出按提交顺序排队


def _probe_size(raw: bytes) -> tuple[Optional[int], Optional[int]]:
    try:
        from PIL import Image  # type: ignore
        im = Image.open(io.BytesIO(raw))
        return im.width, im.height
    except Exception:  # noqa: BLE001
        return None, None


async def _set_status(job_id: int, *, status: Optional[str] = None, progress: Optional[int] = None,
                      error: Optional[str] = None) -> None:
    async with session_scope() as s:
        job = await s.get(ImageJob, job_id)
        if not job:
            return
        if status is not None:
            job.status = status
        if progress is not None:
            job.progress = progress
        if error is not None:
            job.error = error[:500]
        job.updated_at = datetime.utcnow()


async def _load_ref_images(keys: list[str]) -> list[bytes]:
    """从 OSS 下载参考图字节 (最多 9 张)。"""
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
            logger.warning("load ref image %s failed: %s", k, e)
    return out


def _split_3x3(raw: bytes) -> list[bytes]:
    """把一张图按 3x3 数学等分硬切为 9 块, 返回行优先(左上->右下)的 PNG 字节列表。"""
    from PIL import Image as _Img
    import io as _io
    im = _Img.open(_io.BytesIO(raw)).convert("RGB")
    W, H = im.size
    cw, ch = W // 3, H // 3
    out: list[bytes] = []
    for r in range(3):
        for c in range(3):
            box = (c * cw, r * ch, (c + 1) * cw if c < 2 else W, (r + 1) * ch if r < 2 else H)
            buf = _io.BytesIO()
            im.crop(box).save(buf, format="PNG")
            out.append(buf.getvalue())
    return out


_MAX_ATTEMPTS = 3  # 失败自动重试次数 (含首次共 3 次)


async def _kegeai_generate_with_retries(job_id, *, model, prompt, n, size, ref_images):
    """kegeai 通道 (gpt-image-2 / gemini) 生成, 失败重试 _MAX_ATTEMPTS 次, 指数退避。"""
    last_err = None
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        if is_cancelled(job_id):
            raise RuntimeError("用户取消")
        try:
            imgs = await providers.generate(
                model=model, prompt=prompt, n=n, size=size, ref_images=ref_images,
            )
            if imgs:
                return imgs
        except Exception as e:  # noqa: BLE001
            last_err = e
            logger.warning("kegeai generate job %s attempt %d/%d failed: %s", job_id, attempt, _MAX_ATTEMPTS, e)
            if attempt < _MAX_ATTEMPTS:
                await asyncio.sleep(2 * attempt)
    raise RuntimeError(f"kegeai 生成失败(已重试{_MAX_ATTEMPTS}次): {last_err}")


async def _generate_with_retries(job_id, *, model, prompt, n, size, ref_images, ref_keys=None):
    """生成 (含重试)。返回 (images, used_model)。

    ## ⚠️ 2026-10-14：渠道大改 —— RunningHub 生图已摘除

    原先是三层结构（文生图对冲 RunningHub、图生图优先 RunningHub，kegeai 兜底）。
    上游 CN 节点因合规要求下线了 RunningHub 的托管生图模型，报
    `RH submit error 40310: this model is no longer available on the CN endpoint`，
    用户决定不补救、直接放弃该渠道。

    现在**只剩一条链**：zx1(主) + kege(兜底)，都在 `providers.generate()` 内部实现
    （见 generate_gpt_image / generate_gemini_image 的 chain 列表）。本函数因此退化为
    "按 _MAX_ATTEMPTS 重试调用 providers.generate" —— 渠道级兜底下沉到了 provider 层。

    `ref_keys` 保留在签名里是**有意为之**：调用方仍在传（run_generate_job:331），
    且摘除的 RunningHub 图生图是唯一需要"公网 URL"的渠道 —— 现在参考图直接以字节
    走 zx1/kege 的 images/edits，不再需要签 URL。保留参数可避免调用方与这里同时改动，
    也方便将来若接入新的"需要 URL"的渠道时有现成入口。它当前**不被使用**。

    `used_model` 恒等于传入的 model：渠道兜底在 provider 层完成，切换渠道不换模型名，
    所以不会再出现"请求 gpt-image-2 实际出图 rh-image-g-2"这种落库口径分裂。
    """
    # 人像专用 (rh-portrait-t2i): 纯文生图独立工作流, 直接调用对应 provider。
    # **保留**：它走的是 ComfyUI 工作流接口，不在被摘除的托管生图渠道内。
    if model == "rh-portrait-t2i":
        last_err = None
        for attempt in range(1, _MAX_ATTEMPTS + 1):
            if is_cancelled(job_id):
                raise RuntimeError("用户取消")
            try:
                imgs = await providers.generate(model=model, prompt=prompt, n=n, size=size)
                if imgs:
                    return imgs, model
            except Exception as e:  # noqa: BLE001
                last_err = e
                logger.warning("portrait t2i job %s attempt %d/%d failed: %s", job_id, attempt, _MAX_ATTEMPTS, e)
                if attempt < _MAX_ATTEMPTS:
                    await asyncio.sleep(2 * attempt)
        raise RuntimeError(f"人像专用生成失败(已重试{_MAX_ATTEMPTS}次): {last_err}")

    # ── 唯一的生成路径: zx1 主 + kege 兜底 (渠道链在 providers 内部) ──
    imgs = await _kegeai_generate_with_retries(
        job_id, model=model, prompt=prompt, n=n, size=size, ref_images=ref_images,
    )
    return imgs, model


# ⛔ 2026-10-14: `_public_urls_for_keys` 随 RunningHub 生图一起删除。
# 它唯一的用途是把 OSS key 签成公网 URL —— RunningHub 是唯一要求"参考图必须是远端
# 可拉的 URL"的渠道。zx1/kege 走 images/edits，参考图以字节直接 POST，不需要签名 URL。
# 因此它摘除后没有任何调用者。若将来接入新的"需要 URL"的渠道，从 git 历史取回即可
# （`git log -S _public_urls_for_keys`）。


async def run_generate_job(job_id: int) -> None:
    """后台执行一次生成任务。"""
    async with _SEM:
        if is_cancelled(job_id):
            await _set_status(job_id, status="canceled", error="用户取消")
            _CANCELLED.discard(job_id)
            return
        await _set_status(job_id, status="running", progress=10)
        try:
            async with session_scope() as s:
                job = await s.get(ImageJob, job_id)
                if not job:
                    return
                params = dict(job.params or {})
                user_id = job.user_id
                model = job.model or "gpt-image-2"

            prompt: str = params.get("effective_prompt") or params.get("prompt") or ""
            n: int = int(params.get("n") or 1)
            size: str = params.get("size") or "1024x1024"
            ref_keys: list[str] = params.get("ref_image_keys") or []

            # 可选: 提示词优化 (勾选时, 用对应文本模型先改写提示词再送绘图)
            if params.get("optimize_prompt"):
                try:
                    from .optimize import optimize_prompt as _opt
                    optimized = await _opt(prompt, model)
                    if optimized:
                        prompt = optimized
                        async with session_scope() as s:
                            j2 = await s.get(ImageJob, job_id)
                            if j2:
                                p2 = dict(j2.params or {})
                                p2["optimized_prompt"] = optimized
                                j2.params = p2
                                j2.updated_at = datetime.utcnow()
                except Exception as e:  # noqa: BLE001
                    logger.warning("optimize prompt for job %s failed (use original): %s", job_id, e)

            ref_images = await _load_ref_images(ref_keys) if ref_keys else None
            await _set_status(job_id, progress=30)

            images, used_model = await _generate_with_retries(
                job_id, model=model, prompt=prompt, n=n, size=size,
                ref_images=ref_images, ref_keys=ref_keys,
            )
            # ⚠️ 2026-10-14: 这里原先有一段"若 used_model != model 就往 params 写
            # fallback_model"的逻辑，随 RunningHub 摘除而**恒定不触发**。
            # 原因：过去 RunningHub 是独立模型名（rh-image-g-2），换渠道就换名字；
            # 现在渠道兜底下沉到 providers 层（zx1 → kege 都在 generate_gpt_image 内部），
            # 换渠道**不换模型名**，所以 used_model 恒等于 model。
            # 这段删除而不是保留：留着会让人以为"还有渠道切换的痕迹要看"。
            # 变量名保持 used_model（不带下划线）：下面计费要用它。
            # 2026-10-14 摘除 RunningHub 时曾误改成 `_used_model`，导致
            # `record_generate(model=used_model)` 每张图都抛 NameError，
            # 被 except 吞成一行 warning —— 出图照常成功、账一条没记。
            # 将来若真有跨模型兜底，从 git 历史取回这段即可
            # （`git log -S fallback_model`）。
            await _set_status(job_id, progress=70)
            if is_cancelled(job_id):
                await _set_status(job_id, status="canceled", error="用户取消")
                _CANCELLED.discard(job_id)
                return

            # 转存 OSS + 写 image_assets
            saved = 0
            for i, raw in enumerate(images):
                key = oss_client.build_oss_key(
                    user_id=user_id, filename=f"img_{job_id}_{i}.png", namespace="image-studio",
                )
                # 上传到 OSS (public bucket)
                try:
                    await oss_client.put_object_async(key, raw)
                except Exception as e:  # noqa: BLE001
                    logger.exception("oss put failed for job %s seq %s", job_id, i)
                    raise RuntimeError(f"OSS 上传失败: {e}")
                w, h = _probe_size(raw)
                async with session_scope() as s:
                    s.add(ImageAsset(
                        job_id=job_id, user_id=user_id, oss_key=key,
                        width=w, height=h, kind="original", seq=i,
                    ))
                saved += 1

            await _set_status(job_id, status="succeeded", progress=100)
            logger.info("image job %s done, %d assets", job_id, saved)

            # 计费: 按实际出图模型 (兜底时为 RunningHub 模型) 与产出张数计费
            try:
                from ..billing import service as _billing
                await _billing.record_generate(
                    job_id=job_id, user_id=user_id, model=used_model, size=size, n_images=saved,
                )
            except Exception as _be:  # noqa: BLE001
                logger.warning("billing record_generate job %s failed: %s", job_id, _be)

            # ── 工作流 post_steps: 切九张 ──
            wf = _wf.get_workflow(params.get("workflow"))
            hd_target_ids: list[int] = []  # auto_hd 作用对象 (切片优先, 否则原图)
            if wf and "split_3x3" in (wf.get("post_steps") or []):
                async with session_scope() as s:
                    orig = (await s.execute(
                        select(ImageAsset).where(
                            ImageAsset.job_id == job_id, ImageAsset.kind == "original",
                        ).order_by(ImageAsset.seq)
                    )).scalars().all()
                    orig_list = [(a.oss_key, a.seq) for a in orig]
                for (okey, oseq) in orig_list:
                    try:
                        raw0 = await _load_asset_bytes(okey)
                        slices = _split_3x3(raw0)
                        for idx, sb in enumerate(slices):
                            skey = oss_client.build_oss_key(
                                user_id=user_id, filename=f"slice_{job_id}_{oseq}_{idx}.png",
                                namespace="image-studio",
                            )
                            await oss_client.put_object_async(skey, sb)
                            sw, sh = _probe_size(sb)
                            async with session_scope() as s:
                                a2 = ImageAsset(
                                    job_id=job_id, user_id=user_id, oss_key=skey,
                                    width=sw, height=sh, kind="slice", seq=oseq * 9 + idx,
                                    meta={"grid_index": idx, "source_seq": oseq},
                                )
                                s.add(a2)
                                await s.flush()
                                hd_target_ids.append(a2.id)
                    except Exception as e:  # noqa: BLE001
                        logger.warning("split_3x3 for job %s asset seq %s failed: %s", job_id, oseq, e)

            # 作用对象集合 (auto_hd / auto_polish 共用): 有切片则用切片, 否则原图
            auto_hd = bool(params.get("auto_hd"))
            auto_polish = bool(params.get("auto_polish"))
            if (auto_hd or auto_polish) and not hd_target_ids:
                async with session_scope() as s:
                    orig = (await s.execute(
                        select(ImageAsset).where(
                            ImageAsset.job_id == job_id, ImageAsset.kind == "original",
                        )
                    )).scalars().all()
                    hd_target_ids = [a.id for a in orig]

            # 顺序: 生成 → (可选)高清 → (可选)润色
            # - 同时勾选: 先放大, 放大完成后在其产出图上链式触发润色 (also_polish=True)
            # - 仅高清: 只放大
            # - 仅润色: 直接对原图/切片润色
            if auto_hd:
                for aid in hd_target_ids:
                    try:
                        await create_and_run_upscale(
                            user_id=user_id, source_asset_id=aid, also_polish=auto_polish,
                        )
                    except Exception as e:  # noqa: BLE001
                        logger.warning("auto-hd upscale for asset %s failed: %s", aid, e)
            elif auto_polish:
                for aid in hd_target_ids:
                    try:
                        await create_and_run_polish(user_id=user_id, source_asset_id=aid)
                    except Exception as e:  # noqa: BLE001
                        logger.warning("auto-polish for asset %s failed: %s", aid, e)
        except Exception as e:  # noqa: BLE001
            logger.exception("image job %s failed", job_id)
            await _set_status(job_id, status="failed", error=str(e))


async def create_and_run_generate(
    *,
    user_id: int,
    model: str,
    prompt: str,
    n: int = 1,
    size: str = "1024x1024",
    preset_id: Optional[int] = None,
    ref_image_keys: Optional[list[str]] = None,
    auto_hd: bool = False,
    auto_polish: bool = False,
    workflow: Optional[str] = None,
    optimize_prompt: bool = False,
    ref_labels: Optional[list[str]] = None,
) -> int:
    """建任务记录 + 起后台协程, 立即返回 job_id。


    workflow: 固定工作流 id (如 grid_9)。命中时:
      - 在用户提示词前拼接隐藏前缀 (effective_prompt, 用户不可见原始 prompt)
      - 生成成功后按 workflow.post_steps 执行 (如 split_3x3 切九张)
    ref_labels: 参考图标注 (与 ref_image_keys 同序)。仅作用于 effective_prompt,
      把提示词里的标注词替换成 图1..图N (用户不可见, params.prompt 仍为原文)。
    """
    wf = _wf.get_workflow(workflow)
    effective_prompt = prompt
    if wf and wf.get("prompt_prefix"):
        effective_prompt = wf["prompt_prefix"] + "\n" + prompt
    # 参考图标注 → 图N 替换 (后端隐式, 只改送模型的 effective_prompt)
    if ref_labels:
        from .ref_labels import apply_ref_label_map
        effective_prompt = apply_ref_label_map(effective_prompt, ref_labels)
    # 追加明确宽高比指令: gpt-image-2 吃 size, 但 gemini 忽略 size, 只能靠提示词约束比例
    try:
        _w, _h = (int(x) for x in str(size).lower().split("x"))
        if _w and _h:
            from math import gcd as _gcd
            _g = _gcd(_w, _h) or 1
            _orient = "竖屏(portrait)" if _h > _w else ("横屏(landscape)" if _w > _h else "正方形(square)")
            effective_prompt = (
                effective_prompt
                + f"\n\n【输出尺寸要求】整张图片的宽高比必须严格为 {_w//_g}:{_h//_g}（{_orient}，约 {_w}×{_h} 像素），不要输出其他比例。"
            )
    except Exception:  # noqa: BLE001
        pass
    async with session_scope() as s:
        job = ImageJob(
            user_id=user_id,
            kind="generate",
            provider=model,
            model=model,
            status="pending",
            progress=0,
            params={
                "prompt": prompt,                    # 用户原文 (前端只显示这个)
                "effective_prompt": effective_prompt,  # 实际送模型 (含隐藏前缀)
                "n": n,
                "size": size,
                "preset_id": preset_id,
                "ref_image_keys": (ref_image_keys or [])[: providers.MAX_REF_IMAGES],
                "ref_labels": (ref_labels or [])[: providers.MAX_REF_IMAGES] or None,
                "auto_hd": bool(auto_hd),
                "auto_polish": bool(auto_polish),
                "workflow": workflow,
                "req_size": size,
            },
        )
        s.add(job)
        await s.flush()
        job_id = job.id

    asyncio.create_task(run_generate_job(job_id))
    return job_id


# ============================================================
# 参考图处理 (ref-process): 用户直接上传图, 跳过生图, 对每张图各自走 高清/润色
# 不调用生图模型: 上传图落成 ImageAsset(kind=uploaded), 再复用 upscale/polish。
# auto_hd+auto_polish 沿用"先高清后润色"链式; polish_prompt 仅润色时写 #146。

async def create_and_run_ref_process(
    *, user_id: int, ref_image_keys, auto_hd: bool = False,
    auto_polish: bool = False, polish_prompt=None,
) -> int:
    """对每张上传图直接创建 高清/润色 任务本身 — N 张图 = 恰好 N 个任务。
    不创建任何 ref_process 容器任务, 不展示原图; 每张图就是一个 upscale 或 polish 任务。
    返回第一个任务 id (仅供前端 toast)。"""
    keys = (ref_image_keys or [])[: providers.MAX_REF_IMAGES]
    if not keys:
        raise ValueError("参考图处理需要至少 1 张上传图")
    if not (auto_hd or auto_polish):
        raise ValueError("请至少勾选 高清 或 图片润色")
    pp = polish_prompt.strip() if (polish_prompt and polish_prompt.strip()) else None

    job_ids: list[int] = []
    for key in keys:
        # 上传图本身就是源 oss_key; 直接建处理任务 (无需先落 uploaded asset / 无需容器任务)。
        # 勾选高清 -> upscale (高清完再润色走 also_polish 链式); 否则仅润色。
        if auto_hd:
            jid = await create_and_run_upscale(
                user_id=user_id, source_oss_key=key, also_polish=auto_polish,
                polish_prompt=pp,
            )
        else:
            jid = await create_and_run_polish(
                user_id=user_id, source_oss_key=key, prompt=pp,
            )
        job_ids.append(jid)

    return job_ids[0]


# 高清放大 (P2) - RunningHub 远端异步工作流
# 抗重启: rh_task_id 存 params, 重启后用它续查 (远端任务不受本进程影响)
# ============================================================

RH_POLL_INTERVAL = 5.0
RH_POLL_MAX = 240  # 5s * 240 = 20min 上限


async def _load_asset_bytes(oss_key: str) -> bytes:
    """下载 OSS 对象字节。优先内网 (prod 免流量费); 内网不可达 (如 dev 不在同 VPC)
    时回退到公网预签名 URL 下载, 保证两端都能取到图。"""
    import tempfile, os as _os
    with tempfile.NamedTemporaryFile(delete=False, suffix=".img") as tf:
        tmp = tf.name
    try:
        try:
            await oss_client.get_object_to_file_async(oss_key, tmp)
            with open(tmp, "rb") as fh:
                return fh.read()
        except Exception as e:  # noqa: BLE001
            # 内网端点不可达 (dev 环境常见) -> 回退公网预签名 URL
            logger.warning("internal OSS download failed for %s (%s), fallback to public URL", oss_key, e)
            url = oss_client.sign_get_url(oss_key, ttl_seconds=600)
            return await providers.download_url(url)
    finally:
        try:
            _os.unlink(tmp)
        except Exception:  # noqa: BLE001
            pass


async def _save_rh_task_id(job_id: int, rh_task_id: str) -> None:
    async with session_scope() as s:
        job = await s.get(ImageJob, job_id)
        if not job:
            return
        p = dict(job.params or {})
        p["rh_task_id"] = rh_task_id
        job.params = p
        # 远端任务创建成功的瞬间 = 算力开始计时(此前排队/上传的时间不算)
        if job.started_at is None:
            job.started_at = datetime.utcnow()
        job.updated_at = datetime.utcnow()


async def _mark_finished(job_id: int) -> tuple[Optional[datetime], Optional[datetime]]:
    """终态时补 finished_at, 返回 (started_at, finished_at) 供计费口径使用。"""
    async with session_scope() as s:
        job = await s.get(ImageJob, job_id)
        if not job:
            return None, None
        if job.finished_at is None:
            job.finished_at = datetime.utcnow()
        job.updated_at = datetime.utcnow()
        return job.started_at, job.finished_at


async def _bill_failed_upscale(job_id: int, user_id: int | None, *, kind: str) -> None:
    """在 RH 终态为失败/超时时落一条计费。

    远端任务已经真跑过(或被排队后失败), 算力已消耗 —— 不记的话这些消耗就凭空消失。
    幂等由 billing.record_upscale 的 _exists(job_id) 保证: 同一次任务不会记两条。
    """
    try:
        from ..billing import service as _billing
        _s, _f = await _mark_finished(job_id)
        await _billing.record_upscale(
            job_id=job_id, user_id=user_id,
            duration_seconds=(_f - _s).total_seconds() if (_s and _f) else 0.0,
            started_at=_s, finished_at=_f,
        )
    except Exception as _be:  # noqa: BLE001
        logger.warning("billing record_upscale(%s failed) job %s failed: %s", kind, job_id, _be)


async def _finish_upscale_from_outputs(job_id: int, user_id: int) -> None:
    """SUCCESS 后: 取产出 URL -> 下载 -> 转存 OSS -> 写 upscaled asset。"""
    urls = await providers.rh_outputs_for_job(job_id)
    await _set_status(job_id, progress=80)
    saved = 0
    upscaled_asset_ids: list[int] = []
    for i, url in enumerate(urls):
        raw = await providers.download_url(url)
        key = oss_client.build_oss_key(
            user_id=user_id, filename=f"upscaled_{job_id}_{i}.png", namespace="image-studio",
        )
        try:
            await oss_client.put_object_async(key, raw)
        except Exception as e:  # noqa: BLE001
            logger.exception("oss put failed for upscale job %s seq %s", job_id, i)
            raise RuntimeError(f"OSS 上传失败: {e}")
        w, h = _probe_size(raw)
        async with session_scope() as s:
            a = ImageAsset(
                job_id=job_id, user_id=user_id, oss_key=key,
                width=w, height=h, kind="upscaled", seq=i,
            )
            s.add(a)
            await s.flush()
            upscaled_asset_ids.append(a.id)
        saved += 1
    await _set_status(job_id, status="succeeded", progress=100)
    logger.info("upscale job %s done, %d assets", job_id, saved)

    # 链式润色 (生成→高清→润色): 放大任务带 also_polish 时, 对放大产出图触发润色
    async with session_scope() as s:
        j = await s.get(ImageJob, job_id)
        also_polish = bool(dict(j.params or {}).get("also_polish")) if j else False
    if also_polish:
        for aid in upscaled_asset_ids:
            try:
                await create_and_run_polish(user_id=user_id, source_asset_id=aid)
            except Exception as e:  # noqa: BLE001
                logger.warning("chained polish for upscaled asset %s failed: %s", aid, e)

    # 计费: RunningHub 高清放大按运行时长折算 (4 元/小时)。
    # 口径 v2: 用 started_at(远端任务创建)→ finished_at(轮询到终态),
    # 不再用 created_at → now —— 那会把排队等待也算成算力。
    try:
        from ..billing import service as _billing
        _started, _finished = await _mark_finished(job_id)
        _duration = 0.0
        if _started and _finished:
            _duration = max(0.0, (_finished - _started).total_seconds())
        await _billing.record_upscale(
            job_id=job_id, user_id=user_id, duration_seconds=_duration,
            started_at=_started, finished_at=_finished,
        )
    except Exception as _be:  # noqa: BLE001
        logger.warning("billing record_upscale job %s failed: %s", job_id, _be)


async def _poll_upscale(job_id: int, user_id: int) -> None:
    """轮询 RunningHub 任务状态直到终态。"""
    for _ in range(RH_POLL_MAX):
        await asyncio.sleep(RH_POLL_INTERVAL)
        try:
            st = await providers.rh_status_for_job(job_id)
        except Exception as e:  # noqa: BLE001
            logger.warning("upscale job %s status query err: %s", job_id, e)
            continue
        if st in ("SUCCESS", "SUCCEED", "SUCCEEDED"):
            await _finish_upscale_from_outputs(job_id, user_id)
            return
        if st in ("FAILED", "ERROR", "CANCELED", "CANCELLED"):
            await _set_status(job_id, status="failed", error=f"RunningHub 任务 {st}")
            await _bill_failed_upscale(job_id, user_id, kind="upscale")
            return
        # RUNNING / QUEUED: 继续, progress 在 40~75 间缓动
        async with session_scope() as s:
            job = await s.get(ImageJob, job_id)
            cur = job.progress if job else 40
        if cur is not None and cur < 75:
            await _set_status(job_id, progress=min(75, (cur or 40) + 2))
    await _set_status(job_id, status="failed", error="RunningHub 任务超时")
    await _bill_failed_upscale(job_id, user_id, kind="upscale")


async def run_upscale_job(job_id: int) -> None:
    """放大任务主流程 (新建任务用)。"""
    await _set_status(job_id, status="running", progress=10)
    try:
        async with session_scope() as s:
            job = await s.get(ImageJob, job_id)
            if not job:
                return
            params = dict(job.params or {})
            user_id = job.user_id
        # 计费归属: 后台协程/启动恢复路径无请求上下文, 显式盖一次
        from ..factory.usage import set_usage_context
        set_usage_context(job_id=None, user_id=user_id, source="image_studio.upscale")
        source_key = params.get("source_oss_key")
        if not source_key:
            raise RuntimeError("缺少源图 oss_key")

        raw = await _load_asset_bytes(source_key)
        await _set_status(job_id, progress=25)

        last_err = None
        rh_task_id = None
        for attempt in range(1, _MAX_ATTEMPTS + 1):
            try:
                file_name = await providers.rh_upload(raw)
                await _set_status(job_id, progress=35)
                rh_task_id = await providers.rh_create_upscale(file_name)
                break
            except Exception as e:  # noqa: BLE001
                last_err = e
                logger.warning("upscale job %s attempt %d/%d failed: %s", job_id, attempt, _MAX_ATTEMPTS, e)
                if attempt < _MAX_ATTEMPTS:
                    await asyncio.sleep(2 * attempt)
        if rh_task_id is None:
            raise RuntimeError(f"高清放大失败(已重试{_MAX_ATTEMPTS}次): {last_err}")

        await _save_rh_task_id(job_id, rh_task_id)
        await _set_status(job_id, progress=40)

        await _poll_upscale(job_id, user_id)
    except Exception as e:  # noqa: BLE001
        logger.exception("upscale job %s failed", job_id)
        await _set_status(job_id, status="failed", error=str(e))


async def resume_upscale_job(job_id: int) -> None:
    """重启后恢复: 已有 rh_task_id 则直接续查, 否则标记中断。"""
    async with session_scope() as s:
        job = await s.get(ImageJob, job_id)
        if not job:
            return
        params = dict(job.params or {})
        user_id = job.user_id
        rh_task_id = params.get("rh_task_id")
    if not rh_task_id:
        await _set_status(job_id, status="interrupted", error="重启前未取得远端任务ID")
        return
    logger.info("resume upscale job %s rh_task=%s", job_id, rh_task_id)
    # 计费归属: 启动恢复协程无请求上下文, 显式播种(后续轮询里若有 LLM/RH 调用才归得到人)
    from ..factory.usage import set_usage_context
    set_usage_context(job_id=None, user_id=user_id, source="image_studio.resume")
    await _poll_upscale(job_id, user_id)


async def create_and_run_upscale(*, user_id: int, source_asset_id: int, also_polish: bool = False) -> int:
    """按源 asset 建放大任务 + 起后台协程。

    also_polish=True 时, 放大成功后自动对放大产出图链式触发润色 (生成→高清→润色)。
    """
    async with session_scope() as s:
        asset = await s.get(ImageAsset, source_asset_id)
        if not asset or asset.user_id != user_id:
            raise ValueError("源图不存在或无权限")
        source_key = asset.oss_key
        parent_jid = asset.job_id
        job = ImageJob(
            user_id=user_id,
            kind="upscale",
            provider="runninghub",
            model="seedvr2-upscale",
            status="pending",
            progress=0,
            parent_job_id=parent_jid,
            params={
                "source_asset_id": source_asset_id,
                "source_oss_key": source_key,
                "also_polish": bool(also_polish),
            },
        )
        s.add(job)
        await s.flush()
        job_id = job.id

    asyncio.create_task(run_upscale_job(job_id))
    return job_id


# ============================================================
# 图片润色 (P3) - RunningHub 远端异步工作流 (工作流 __REDACTED__)
# 复用 upscale 同一套轮询/重启恢复逻辑; 产出 kind="polished" 的并列 asset (保留原图)
# 复用同一 RUNNINGHUB_API_KEY, 共享 100 并发
# ============================================================

async def _finish_polish_from_outputs(job_id: int, user_id: int) -> None:
    """SUCCESS 后: 取产出 URL -> 下载 -> 转存 OSS -> 写 polished asset。"""
    urls = await providers.rh_outputs_for_job(job_id)
    await _set_status(job_id, progress=80)
    saved = 0
    for i, url in enumerate(urls):
        raw = await providers.download_url(url)
        key = oss_client.build_oss_key(
            user_id=user_id, filename=f"polished_{job_id}_{i}.png", namespace="image-studio",
        )
        try:
            await oss_client.put_object_async(key, raw)
        except Exception as e:  # noqa: BLE001
            logger.exception("oss put failed for polish job %s seq %s", job_id, i)
            raise RuntimeError(f"OSS 上传失败: {e}")
        w, h = _probe_size(raw)
        async with session_scope() as s:
            s.add(ImageAsset(
                job_id=job_id, user_id=user_id, oss_key=key,
                width=w, height=h, kind="polished", seq=i,
            ))
        saved += 1
    await _set_status(job_id, status="succeeded", progress=100)
    logger.info("polish job %s done, %d assets", job_id, saved)

    # 计费: 复用高清放大同口径 (按运行时长折算), RunningHub 同 key 共享额度
    try:
        from ..billing import service as _billing
        _started, _finished = await _mark_finished(job_id)
        _duration = 0.0
        if _started and _finished:
            _duration = max(0.0, (_finished - _started).total_seconds())
        await _billing.record_upscale(
            job_id=job_id, user_id=user_id, duration_seconds=_duration,
            started_at=_started, finished_at=_finished,
        )
    except Exception as _be:  # noqa: BLE001
        logger.warning("billing record_polish job %s failed: %s", job_id, _be)


async def _poll_polish(job_id: int, user_id: int) -> None:
    """轮询 RunningHub 润色任务状态直到终态。"""
    for _ in range(RH_POLL_MAX):
        await asyncio.sleep(RH_POLL_INTERVAL)
        try:
            st = await providers.rh_status_for_job(job_id)
        except Exception as e:  # noqa: BLE001
            logger.warning("polish job %s status query err: %s", job_id, e)
            continue
        if st in ("SUCCESS", "SUCCEED", "SUCCEEDED"):
            await _finish_polish_from_outputs(job_id, user_id)
            return
        if st in ("FAILED", "ERROR", "CANCELED", "CANCELLED"):
            await _set_status(job_id, status="failed", error=f"RunningHub 任务 {st}")
            await _bill_failed_upscale(job_id, user_id, kind="polish")
            return
        async with session_scope() as s:
            job = await s.get(ImageJob, job_id)
            cur = job.progress if job else 40
        if cur is not None and cur < 75:
            await _set_status(job_id, progress=min(75, (cur or 40) + 2))
    await _set_status(job_id, status="failed", error="RunningHub 任务超时")
    await _bill_failed_upscale(job_id, user_id, kind="polish")


async def run_polish_job(job_id: int) -> None:
    """润色任务主流程 (新建任务用)。"""
    await _set_status(job_id, status="running", progress=10)
    try:
        async with session_scope() as s:
            job = await s.get(ImageJob, job_id)
            if not job:
                return
            params = dict(job.params or {})
            user_id = job.user_id
        # 计费归属: 后台协程/启动恢复路径无请求上下文, 显式盖一次
        from ..factory.usage import set_usage_context
        set_usage_context(job_id=None, user_id=user_id, source="image_studio.polish")
        source_key = params.get("source_oss_key")
        if not source_key:
            raise RuntimeError("缺少源图 oss_key")

        raw = await _load_asset_bytes(source_key)
        await _set_status(job_id, progress=25)

        polish_prompt = params.get("polish_prompt")
        last_err = None
        rh_task_id = None
        for attempt in range(1, _MAX_ATTEMPTS + 1):
            try:
                file_name = await providers.rh_upload(raw)
                await _set_status(job_id, progress=35)
                rh_task_id = await providers.rh_create_polish(file_name, prompt=polish_prompt)
                break
            except Exception as e:  # noqa: BLE001
                last_err = e
                logger.warning("polish job %s attempt %d/%d failed: %s", job_id, attempt, _MAX_ATTEMPTS, e)
                if attempt < _MAX_ATTEMPTS:
                    await asyncio.sleep(2 * attempt)
        if rh_task_id is None:
            raise RuntimeError(f"图片润色失败(已重试{_MAX_ATTEMPTS}次): {last_err}")

        await _save_rh_task_id(job_id, rh_task_id)
        await _set_status(job_id, progress=40)

        await _poll_polish(job_id, user_id)
    except Exception as e:  # noqa: BLE001
        logger.exception("polish job %s failed", job_id)
        await _set_status(job_id, status="failed", error=str(e))


async def resume_polish_job(job_id: int) -> None:
    """重启后恢复: 已有 rh_task_id 则直接续查, 否则标记中断。"""
    async with session_scope() as s:
        job = await s.get(ImageJob, job_id)
        if not job:
            return
        params = dict(job.params or {})
        user_id = job.user_id
        rh_task_id = params.get("rh_task_id")
    if not rh_task_id:
        await _set_status(job_id, status="interrupted", error="重启前未取得远端任务ID")
        return
    logger.info("resume polish job %s rh_task=%s", job_id, rh_task_id)
    from ..factory.usage import set_usage_context
    set_usage_context(job_id=None, user_id=user_id, source="image_studio.resume")
    await _poll_polish(job_id, user_id)


async def create_and_run_polish(
    *, user_id: int, source_asset_id: int | None = None,
    source_oss_key: str | None = None, prompt: Optional[str] = None
) -> int:
    """按源 asset 建润色任务 + 起后台协程。

    prompt: 可选; 传入则写入润色工作流 #146 节点 (调用方应已拼好 "预置词\\n用户词")。
    """
    parent_jid = None
    if source_oss_key:
        source_key = source_oss_key
    else:
        async with session_scope() as s:
            asset = await s.get(ImageAsset, source_asset_id)
            if not asset or asset.user_id != user_id:
                raise ValueError("源图不存在或无权限")
            source_key = asset.oss_key
            parent_jid = asset.job_id
    async with session_scope() as s:
        params = {"source_asset_id": source_asset_id, "source_oss_key": source_key}
        if prompt and prompt.strip():
            params["polish_prompt"] = prompt.strip()
        job = ImageJob(
            user_id=user_id,
            kind="polish",
            provider="runninghub",
            model="flux2-polish",
            status="pending",
            progress=0,
            parent_job_id=parent_jid,
            params=params,
        )
        s.add(job)
        await s.flush()
        job_id = job.id

    asyncio.create_task(run_polish_job(job_id))
    return job_id


# ============================================================
# 取消 + 队列位次 (并发调度增强)
# ============================================================

# 运行中任务的取消标记 (进程内); 生成任务在检查点查询此集合提前退出
_CANCELLED: set[int] = set()


def request_cancel(job_id: int) -> None:
    _CANCELLED.add(job_id)


def is_cancelled(job_id: int) -> bool:
    return job_id in _CANCELLED


async def cancel_job(job_id: int, user_id: int) -> str:
    """取消任务: pending 直接置 canceled; running 打标记 + 置 canceled。
    返回最终 status。无权限/不存在抛 ValueError。"""
    async with session_scope() as s:
        job = await s.get(ImageJob, job_id)
        if not job or job.user_id != user_id:
            raise ValueError("任务不存在或无权限")
        if job.status in ("succeeded", "failed", "canceled", "interrupted"):
            return job.status
        request_cancel(job_id)
        job.status = "canceled"
        job.error = "用户取消"
        job.updated_at = datetime.utcnow()
        return "canceled"


async def queue_position(job_id: int) -> int:
    """该任务前面还有多少个未完成的本地生成任务 (Semaphore 排队估算)。
    放大任务走远端, 不计本地队列, 返回 0。"""
    async with session_scope() as s:
        job = await s.get(ImageJob, job_id)
        if not job or job.kind != "generate" or job.status not in ("pending", "running"):
            return 0
        from sqlalchemy import func as _f
        cnt = (await s.execute(
            select(_f.count()).select_from(ImageJob).where(
                ImageJob.kind == "generate",
                ImageJob.status.in_(("pending", "running")),
                ImageJob.id < job_id,
            )
        )).scalar() or 0
        return int(cnt)
