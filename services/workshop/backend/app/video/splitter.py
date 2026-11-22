"""视频转码 + 切片 — 把长视频压缩并切成 90s 一段, 送给 Gemini 反推。

设计思路 (2026-05 改版):
  - 原方案: stream copy (-c copy) 保留原画质, 5min 切片
    → 问题: 高码率短剧 5min 切片 > 128MB, Gemini API 拒收
  - 新方案: 一步 ffmpeg 完成 转码 + 切片
    → 540p / 5fps / CRF28 / AAC 64K mono / 90s 切片
    → 90s 单片约 6-8 MB, 远小于 128MB 上限
    → 27× 压缩比, Gemini 流量从 ~3GB 降到 ~110MB
    → AI 视角无损 (短剧核心是对白+表情, 540p/5fps 完全够)
    → 转码速度 22× realtime (25min 视频 ~70s 处理完)

外部依赖: ffmpeg + libx264 (Dockerfile 已装 ffmpeg)

公开接口:
  - probe_duration(path) -> float
  - split_long_video(path, out_dir) -> list[str]   # 切片路径列表
  - split_videos_for_upload(files, out_dir) -> list[(idx, path, meta)]  # 批量
"""
from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path

logger = logging.getLogger("video.splitter")

# ============================================================
# 切片 + 转码参数 (针对 Gemini 视频反推优化, 短剧场景)
# ============================================================

# 单段时长 90 秒 (留足容错; 60-120 秒都可接受, 90 秒是甜点)
SEGMENT_S = 90

# 不切阈值: 视频时长 ≤ 此值时不切 (但仍要转码降码率, 防止整文件 > 128MB)
NO_SPLIT_THRESHOLD_S = 100  # 100 秒以下不切 (避免末尾切出过短段)

# 视频参数: 540p (短边 540, 宽度自动按比例)
VIDEO_HEIGHT = 540
# 帧率 5 fps (Gemini 内部按 1fps 采样, 5fps 已远超必要; 进一步降到 3 也可以)
VIDEO_FPS = 5
# CRF 28 = 中等画质, 文件小; 短剧场景 28 字幕仍可读, 表情清晰
VIDEO_CRF = 28
# x264 preset: veryfast 速度/压缩比平衡最佳 (短剧场景质量足够)
VIDEO_PRESET = "veryfast"

# 音频参数: 64K mono AAC, 对白完全可懂
AUDIO_BITRATE = "64k"
AUDIO_CHANNELS = 1  # mono

# 转码超时 (按视频时长动态算, 见 _calc_timeout)
TRANSCODE_RT_MULTIPLIER = 0.5  # 实际只需要 0.05-0.1×, 给 0.5 留充足余量
TRANSCODE_MIN_TIMEOUT = 120
TRANSCODE_MAX_TIMEOUT = 7200   # 2 小时上限


def _calc_transcode_timeout(duration: float) -> float:
    """按视频时长估算转码超时."""
    base = duration * TRANSCODE_RT_MULTIPLIER
    return max(TRANSCODE_MIN_TIMEOUT, min(TRANSCODE_MAX_TIMEOUT, base))


async def _run_cmd(cmd: list[str], timeout: float = 60.0) -> tuple[int, str, str]:
    """运行命令,返回 (returncode, stdout, stderr)"""
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return proc.returncode or 0, stdout.decode("utf-8", "ignore"), stderr.decode("utf-8", "ignore")
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise RuntimeError(f"command timeout: {' '.join(cmd[:3])}...")


async def probe_duration(video_path: str | Path) -> float:
    """ffprobe 读视频总时长(秒). 失败返回 0."""
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(video_path),
    ]
    rc, out, err = await _run_cmd(cmd, timeout=30)
    if rc != 0:
        logger.warning("ffprobe failed for %s: %s", video_path, err.strip()[:200])
        return 0.0
    try:
        return float(out.strip())
    except ValueError:
        return 0.0


def _build_transcode_segment_cmd(src: str, out_pattern: str) -> list[str]:
    """构建一步式 转码+切片 ffmpeg 命令.

    用 -f segment 一次输出多个文件, 文件名按 out_pattern (含 %03d) 自动编号.
    """
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", src,
        # 视频: 缩放 + 帧率 + x264 编码
        "-vf", f"scale=-2:{VIDEO_HEIGHT}",
        "-r", str(VIDEO_FPS),
        "-c:v", "libx264",
        "-crf", str(VIDEO_CRF),
        "-preset", VIDEO_PRESET,
        "-pix_fmt", "yuv420p",
        # 音频: AAC mono
        "-c:a", "aac",
        "-b:a", AUDIO_BITRATE,
        "-ac", str(AUDIO_CHANNELS),
        # 切片: segment muxer
        "-f", "segment",
        "-segment_time", str(SEGMENT_S),
        "-reset_timestamps", "1",
        "-segment_format", "mp4",
        "-segment_format_options", "movflags=+faststart",
        out_pattern,
    ]


def _build_transcode_single_cmd(src: str, dst: str) -> list[str]:
    """构建单文件转码命令 (短视频不切, 仅压缩)."""
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", src,
        "-vf", f"scale=-2:{VIDEO_HEIGHT}",
        "-r", str(VIDEO_FPS),
        "-c:v", "libx264",
        "-crf", str(VIDEO_CRF),
        "-preset", VIDEO_PRESET,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", AUDIO_BITRATE,
        "-ac", str(AUDIO_CHANNELS),
        "-movflags", "+faststart",
        dst,
    ]


async def split_long_video(
    video_path: str | Path,
    out_dir: str | Path,
    *,
    use_scene_detect: bool = False,  # 已废弃, 保留参数兼容旧调用
) -> list[str]:
    """转码并切片(若需要). 返回输出文件路径列表(按顺序).

    - 短视频 (≤ NO_SPLIT_THRESHOLD_S): 转码成单文件 (压缩到合理大小)
    - 长视频 (> NO_SPLIT_THRESHOLD_S): 转码 + 按 SEGMENT_S 等长切片
    """
    src = Path(video_path)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    if not src.exists():
        logger.error("源视频不存在: %s", src)
        return []

    src_size_mb = src.stat().st_size / 1024 / 1024
    duration = await probe_duration(src)
    if duration <= 0:
        logger.warning("无法读取时长 (%.1f MB), 仍尝试单文件转码: %s", src_size_mb, src)
        # 时长读不到, 估个 30 分钟超时
        timeout = 1800.0
    else:
        timeout = _calc_transcode_timeout(duration)
        logger.info(
            "转码 + 切片: %s (%.1f MB, %.1f min) → 540p/%dfps/CRF%d/%dsec, timeout=%.0fs",
            src.name, src_size_mb, duration / 60,
            VIDEO_FPS, VIDEO_CRF, SEGMENT_S, timeout,
        )

    # 决定单文件还是切片
    is_single = duration > 0 and duration <= NO_SPLIT_THRESHOLD_S

    if is_single:
        ext = src.suffix.lower() or ".mp4"
        dst = out / f"{src.stem}_compressed{ext}"
        cmd = _build_transcode_single_cmd(str(src), str(dst))
    else:
        # 切片输出 stem_part_001.mp4, stem_part_002.mp4, ...
        out_pattern = str(out / f"{src.stem}_part_%03d.mp4")
        cmd = _build_transcode_segment_cmd(str(src), out_pattern)

    rc, _stdout, stderr = await _run_cmd(cmd, timeout=timeout)
    if rc != 0:
        logger.error("ffmpeg 转码失败 (rc=%d): %s", rc, stderr.strip()[-500:])
        # 失败兜底: 直接返回原文件 (但很可能 Gemini 仍会拒)
        return [str(src)]

    # 收集输出文件 (按文件名排序)
    if is_single:
        if not Path(dst).exists():
            logger.error("ffmpeg 单文件转码完成但输出不存在: %s", dst)
            return [str(src)]
        size_mb = dst.stat().st_size / 1024 / 1024
        logger.info(
            "✓ 单文件转码完成: %s → %s (%.1f MB → %.1f MB, 压缩比 %.1fx)",
            src.name, dst.name, src_size_mb, size_mb,
            src_size_mb / max(size_mb, 0.01),
        )
        return [str(dst)]

    # 切片模式: 列出所有 part_*.mp4
    parts = sorted(out.glob(f"{src.stem}_part_*.mp4"))
    if not parts:
        logger.error("ffmpeg 切片完成但找不到输出: prefix=%s", src.stem)
        return [str(src)]

    total_out_mb = sum(p.stat().st_size for p in parts) / 1024 / 1024
    max_part_mb = max(p.stat().st_size for p in parts) / 1024 / 1024
    logger.info(
        "✓ 转码+切片完成: %s → %d 段 (%.1f MB → %.1f MB, 压缩比 %.1fx, 最大单片 %.1f MB)",
        src.name, len(parts), src_size_mb, total_out_mb,
        src_size_mb / max(total_out_mb, 0.01), max_part_mb,
    )
    if max_part_mb > 100:
        logger.warning(
            "⚠️ 单片 %.1f MB 接近 Gemini 128MB 上限, 考虑降低 SEGMENT_S 或 CRF",
            max_part_mb,
        )

    return [str(p) for p in parts]


async def split_videos_for_upload(
    files: list[tuple[int, str]],
    out_dir: str | Path,
) -> list[tuple[int, str, dict]]:
    """批量转码+切片, 给上传接口用.

    输入: [(原始 episode_index, 文件路径), ...]
    返回: [(新 episode_index, 输出文件路径, meta), ...]
      meta = {
        "source_index": 原 index,
        "part": 第几段 (1-based),
        "total_parts": 总段数,
        "duration": float,
        "source_filename": 原文件名,
      }

    新的 episode_index 从 1 开始重新编号.
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    result: list[tuple[int, str, dict]] = []
    new_idx = 1
    for src_idx, path in files:
        try:
            parts = await split_long_video(path, out_dir)
        except Exception as e:
            logger.exception("split failed for %s, fallback to single: %s", path, e)
            parts = [path]

        if not parts:
            logger.warning("第 %d 集转码无输出, 用原文件: %s", src_idx, path)
            parts = [path]

        total = len(parts)
        for part_no, part_path in enumerate(parts, start=1):
            duration = await probe_duration(part_path)
            result.append((
                new_idx, part_path,
                {
                    "source_index": src_idx,
                    "part": part_no,
                    "total_parts": total,
                    "duration": duration,
                    "source_filename": Path(path).name,
                },
            ))
            new_idx += 1

    return result


# ============================================================
# 无损切分(给豆包分段反推用) —— 不转码、不降画质、不改帧率
# ============================================================

# 单段目标时长。选 300 秒(5 分钟)的依据:
#   火山抽帧上限 1280 帧、单视频 token 上限 81920。
#   5 分钟 @1fps = 300 帧, 远离上限, 模型注意力能集中在本段;
#   而 20 分钟整片 @1fps = 1200 帧, 逼近 1280 帧上限, 后半段注意力被稀释,
#   实测表现为"后 30% 台词全丢、整段被压缩成概括"(draft 458)。
REVERSE_SEGMENT_S = 300

# 段间重叠。切点可能正好落在一句台词/一个动作中间,
# 让下一段往前多包 8 秒, 保证跨切点的戏在某一段里是完整的。
REVERSE_OVERLAP_S = 8

# 低于此时长不切: 本来就在安全区内, 切了反而增加拼接损耗
REVERSE_NO_SPLIT_S = 420


def _build_lossless_cut_cmd(src: str, dst: str, start: float, dur: float) -> list[str]:
    """无损截取 [start, start+dur) 区间。

    关键: -c copy 直接复制码流, **不重编码** ——
      ① 画质/帧率/分辨率完全不变(用户明确要求不许压)
      ② 速度极快(几秒), 且几乎不吃 CPU
    这条命令不属于"重编码", 不受项目里"重编码必须走算力机"的约束。

    -ss 放在 -i **之前** 走输入端快速定位(关键帧对齐);
    -avoid_negative_ts make_zero 修正切点处的时间戳, 否则某些播放器/解析器
    会因首帧 PTS 非零而判定文件异常。
    """
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-ss", f"{start:.3f}",
        "-i", src,
        "-t", f"{dur:.3f}",
        "-c", "copy",
        "-avoid_negative_ts", "make_zero",
        "-movflags", "+faststart",
        dst,
    ]


async def split_for_reverse(
    video_path: str | Path,
    out_dir: str | Path,
    *,
    segment_s: int = REVERSE_SEGMENT_S,
    overlap_s: int = REVERSE_OVERLAP_S,
) -> list[dict]:
    """把长视频无损切成若干段, 供豆包分段反推。

    与 split_long_video 的区别: 那个会转码到 540p/5fps/CRF28(为省流量),
    这里**完全不动画质与帧率** —— 反推质量依赖画面细节(服装、字幕、物品),
    降画质会直接损失信息。

    返回 [{path, index, start, duration}], 按时间顺序。
    视频短于 REVERSE_NO_SPLIT_S 时返回单元素列表(不切, path 即原文件)。
    """
    src = Path(video_path)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    if not src.exists():
        raise FileNotFoundError(f"视频不存在: {src}")

    duration = await probe_duration(src)
    if duration <= 0:
        logger.warning("读不到时长, 按整片反推: %s", src.name)
        return [{"path": str(src), "index": 1, "start": 0.0, "duration": 0.0}]

    if duration <= REVERSE_NO_SPLIT_S:
        logger.info("时长 %.1f 分钟, 在安全区内, 不切分", duration / 60)
        return [{"path": str(src), "index": 1, "start": 0.0, "duration": duration}]

    segs: list[dict] = []
    idx = 0
    pos = 0.0
    while pos < duration:
        idx += 1
        # 除第一段外, 每段起点前移 overlap 秒, 避免切点处的戏被切碎
        start = max(0.0, pos - (overlap_s if idx > 1 else 0))
        dur = min(segment_s + (pos - start), duration - start)
        if dur <= 1.0:            # 末尾不足 1 秒的碎片并入上一段, 不单独切
            break
        dst = out / f"{src.stem}_seg{idx:03d}.mp4"
        rc, _o, err = await _run_cmd(
            _build_lossless_cut_cmd(str(src), str(dst), start, dur),
            timeout=300.0,
        )
        if rc != 0 or not dst.exists():
            logger.error("切分第 %d 段失败 (rc=%d): %s", idx, rc, err.strip()[-300:])
            raise RuntimeError(f"视频切分失败(第{idx}段): {err.strip()[-200:]}")
        segs.append({
            "path": str(dst), "index": idx,
            "start": start, "duration": dur,
        })
        pos = start + dur

    logger.info("无损切分完成: %s (%.1f 分钟) → %d 段, 每段 ~%d 秒, 重叠 %d 秒",
                src.name, duration / 60, len(segs), segment_s, overlap_s)
    return segs
