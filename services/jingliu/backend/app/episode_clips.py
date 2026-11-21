"""按集导出镜头文件：只给「名字 + 下载地址」，不转码、不拼接、不落盘。

## 为什么服务端不拼接（2026-10-21 用户裁定）

归一化一集要真烧 CPU：实测 20 镜 / 203 秒成片 = **187 秒 CPU 时间**，
单条 ffmpeg 会开约 9 个线程，两个用户同时导出就把 16 核打满，把等待
转嫁给同机上所有别的请求。而镜头文件本身已经是 H.264/mp4，**直接给地址
的成本是 0**：不读文件、不起 ffmpeg、不占内存，带宽由 `/media` 的 307
直接落到对象存储，不经本服务。

## 与剪映草稿的分工

| | 剪映草稿 | 本模块 |
|---|---|---|
| 产物 | 工程 JSON + 素材清单 | 一组 mp4 下载地址 |
| 转码 | 不做（剪映读源片段） | 不做 |
| 谁负责按顺序接起来 | 剪映 | 用户的剪辑软件 |
| 耗时 | 秒出 | 秒出（只查库） |

## 裁剪窗口在这里不生效

`clip_in_sec` / `clip_dur_sec` 是镜头级的取片窗口，要真的裁出来**必须重新
编码**（实测流拷贝会在关键帧上对齐，要 3.5 秒给出 3.584 秒）。所以这里
下载的是**原始片段**，并如实标注 `trimmed=true`，让界面提示用户。
需要精确裁剪的走剪映草稿那条通道 —— 剪映读入出点，不转码也不占服务端。
"""
from __future__ import annotations

import re

from .db import Project, Shot, get_session
from .shot_timing import shot_output_sec, shot_speed

#: 在 `/media` 之下、能直接给的相对地址前缀。别的（外链、历史占位地址
#: `/m/v1.mp4`）给出去就是死链，标成 `available=false` 让界面说清楚。
_MEDIA_PREFIX = "/fw/media/"


def safe_name(title: str, episode: int | None) -> str:
    """`{项目名}-第{N}集` → 安全的文件名主干（不含扩展名）。

    项目名是用户输入，可能带 Windows 不允许的 `/ \\ : * ? " < > |`，
    下载到本地会打不开甚至解压出错，一律换成 `_`，并截到安全长度。
    命名只是便利，**文件本身优先**。
    """
    raw = (title or "").strip() or "项目"
    raw = re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", raw).strip(" ._")
    raw = raw[:60] or "项目"
    return f"{raw}-第{episode}集" if episode is not None else f"{raw}-全片"


def clips_of(project_id: str, episode: int | None = None) -> dict:
    """这一集所有已出片的镜头 → 可直接下载的清单。

    只查库，一次 IO 都不做（`/media` 那边命中本地就直发、没有就 307 到桶）。
    """
    with get_session() as s:
        q = (s.query(Shot)
             .filter(Shot.project_id == project_id,
                     Shot.video_url.isnot(None), Shot.video_url != "",
                     (Shot.disabled == 0) | (Shot.disabled.is_(None))))
        if episode is not None:
            q = q.filter(Shot.episode == int(episode))
        rows = q.order_by(Shot.order).all()
        proj = s.get(Project, project_id)
        title = (proj.title if proj else "") or ""
        all_eps = sorted({int(r[0] or 1) for r in
                          s.query(Shot.episode).filter(
                              Shot.project_id == project_id).distinct()})

    base = safe_name(title, episode)
    clips = []
    for i, sh in enumerate(rows, 1):
        url = sh.video_url or ""
        # 与导出/字幕同一口径（`shot_timing.shot_output_sec`）：这是**成片里**
        # 占多久，已经算进变速。此前这里是 `clip_dur_sec ?? duration_sec`，
        # 不除速度 —— 一集里有变速镜头时，页面报的总时长会比实际成片长。
        clips.append({
            "shot_id": sh.id,
            #: 集内序号（1 起）。**不是 `Shot.order`** —— 那是全剧连续的
            #: （实测第 2 集的 order 是 14..33，第 5 集是 63..85），
            #: 直接拿来当镜号会让用户看到"这一集从第 14 镜开始"。
            "index": i,
            "order": sh.order,
            "label": f"第 {i} 镜",
            "url": url,
            "available": url.startswith(_MEDIA_PREFIX),
            # 补齐三位数：否则 S1 / S10 / S2 按文件名排序是乱的
            "download_name": f"{base}-S{i:03d}.mp4",
            "duration_sec": round(float(shot_output_sec(sh)), 2),
            "speed": shot_speed(sh),
            #: 有取片窗口时下载的是**原始片段**（这里不转码，裁不了），见模块头
            "trimmed": sh.clip_dur_sec is not None,
        })

    total = sum(float(c["duration_sec"]) for c in clips)
    return {"ok": True, "episode": episode, "project_title": title,
            "shots": len(clips), "duration_sec": round(total, 1),
            "episodes": all_eps, "clips": clips}
