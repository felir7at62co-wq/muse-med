"""视频交付服务 — 查询/CDN URL生成/下载统计/业务标签"""
from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import func, select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..novel_video.models import NovelVideoJob
from .models import VideoDownloadLog, VideoDeliveryTag

if TYPE_CHECKING:
    from ..auth.models import User

_settings = get_settings()

# 预置业务标签(全局共享)。前端下拉默认给这几个, 也允许自定义自由输入。
PRESET_TAGS = ["已使用", "已发布", "待剪辑", "有问题"]


def get_cdn_url(video_oss_key: str, title: str | None = None) -> str:
    """OSS key → CDN URL（无鉴权版，复用已有cdn_public_base_url配置）"""
    base = _settings.cdn_public_base_url or "http://auto.jubianai.net"
    return f"{base}/{video_oss_key}"


def _thumbnail_url(cover_oss_key: str | None) -> str | None:
    """封面图 OSS key → CDN 缩略图 URL。无封面返回 None。"""
    if not cover_oss_key:
        return None
    base = _settings.cdn_public_base_url or "http://auto.jubianai.net"
    return f"{base}/{cover_oss_key}"


async def list_videos(
    session: AsyncSession,
    *,
    page: int = 1,
    page_size: int = 20,
    start_date: datetime | None = None,
    end_date: datetime | None = None,
    keyword: str | None = None,
    source: str | None = None,
    user: "User | None" = None,
    download_status: str | None = None,   # all|not_downloaded|downloaded_by_me|downloaded_by_others
    tag: str | None = None,               # 按标签筛(如 已使用); 特殊值 __untagged__=无任何标签
    sort: str | None = None,              # latest|most_downloaded|duration|oldest
) -> dict:
    """查询可交付视频列表（分页+筛选+个人下载状态+业务标签）"""
    me_id = getattr(user, "id", None)

    # 基础查询：succeeded + 有视频
    query = select(NovelVideoJob).where(
        NovelVideoJob.status == "succeeded",
        NovelVideoJob.video_oss_key.isnot(None),
        NovelVideoJob.video_oss_key != "",
    )

    # 时间筛选(按完成时间 updated_at)
    if start_date:
        query = query.where(NovelVideoJob.updated_at >= start_date)
    if end_date:
        query = query.where(NovelVideoJob.updated_at <= end_date)

    # 关键词搜索（标题/封面标题）
    if keyword:
        kw = f"%{keyword}%"
        query = query.where(
            (NovelVideoJob.title.ilike(kw)) | (NovelVideoJob.cover_title.ilike(kw))
        )

    # 来源筛选
    if source:
        query = query.where(NovelVideoJob.source == source)

    # 下载状态筛选(需子查询下载日志)
    if download_status == "not_downloaded":
        sub = select(VideoDownloadLog.job_id).distinct()
        query = query.where(NovelVideoJob.id.notin_(sub))
    elif download_status == "downloaded_by_me" and me_id is not None:
        sub = select(VideoDownloadLog.job_id).where(VideoDownloadLog.user_id == me_id).distinct()
        query = query.where(NovelVideoJob.id.in_(sub))
    elif download_status == "downloaded_by_others" and me_id is not None:
        sub_others = select(VideoDownloadLog.job_id).where(VideoDownloadLog.user_id != me_id).distinct()
        query = query.where(NovelVideoJob.id.in_(sub_others))

    # 标签筛选
    if tag == "__untagged__":
        sub_tagged = select(VideoDeliveryTag.job_id).distinct()
        query = query.where(NovelVideoJob.id.notin_(sub_tagged))
    elif tag:
        sub_tag = select(VideoDeliveryTag.job_id).where(VideoDeliveryTag.tag == tag).distinct()
        query = query.where(NovelVideoJob.id.in_(sub_tag))

    # 总数
    count_stmt = select(func.count()).select_from(query.subquery())
    total = (await session.execute(count_stmt)).scalar_one()

    # 排序
    if sort == "most_downloaded":
        # 按全站下载次数排序: 用相关子查询计数(数据量大时可优化为预聚合)
        dl_count_sub = (
            select(func.count(VideoDownloadLog.id))
            .where(VideoDownloadLog.job_id == NovelVideoJob.id)
            .scalar_subquery()
        )
        query = query.order_by(dl_count_sub.desc(), NovelVideoJob.updated_at.desc())
    elif sort == "duration":
        query = query.order_by(NovelVideoJob.audio_duration.desc().nullslast())
    elif sort == "oldest":
        query = query.order_by(NovelVideoJob.updated_at.asc())
    else:  # latest(默认): 完成时间倒序
        query = query.order_by(NovelVideoJob.updated_at.desc())

    # 分页
    query = query.offset((page - 1) * page_size).limit(page_size)
    jobs = (await session.execute(query)).scalars().all()
    job_ids = [j.id for j in jobs]

    # === 一次性聚合(避免 N+1): 全站下载次数 / 我的下载次数 / 下载人清单 / 标签 ===
    download_counts: dict[int, int] = {}
    my_counts: dict[int, int] = {}
    last_downloaded: dict[int, datetime] = {}
    downloaders_map: dict[int, list[dict]] = {}
    tags_map: dict[int, list[str]] = {}

    if job_ids:
        # 全站下载次数 + 最近下载时间
        rows = (await session.execute(
            select(
                VideoDownloadLog.job_id,
                func.count(VideoDownloadLog.id),
                func.max(VideoDownloadLog.created_at),
            )
            .where(VideoDownloadLog.job_id.in_(job_ids))
            .group_by(VideoDownloadLog.job_id)
        )).all()
        for jid, cnt, last_at in rows:
            download_counts[jid] = cnt
            last_downloaded[jid] = last_at

        # 我的下载次数
        if me_id is not None:
            my_rows = (await session.execute(
                select(VideoDownloadLog.job_id, func.count(VideoDownloadLog.id))
                .where(VideoDownloadLog.job_id.in_(job_ids), VideoDownloadLog.user_id == me_id)
                .group_by(VideoDownloadLog.job_id)
            )).all()
            my_counts = dict(my_rows)

        # 下载人清单(job_id+user_id 聚合 → join users 拿昵称)
        # 前台展示优先 display_name(用户昵称), 回退 username(内部代号)
        from ..auth.models import User as _User
        dler_rows = (await session.execute(
            select(
                VideoDownloadLog.job_id,
                VideoDownloadLog.user_id,
                func.count(VideoDownloadLog.id),
                func.max(VideoDownloadLog.created_at),
                _User.display_name,
                _User.username,
            )
            .join(_User, _User.id == VideoDownloadLog.user_id, isouter=True)
            .where(VideoDownloadLog.job_id.in_(job_ids))
            .group_by(
                VideoDownloadLog.job_id, VideoDownloadLog.user_id,
                _User.display_name, _User.username,
            )
            .order_by(func.count(VideoDownloadLog.id).desc())
        )).all()
        for jid, uid, cnt, last_at, dname, uname in dler_rows:
            downloaders_map.setdefault(jid, []).append({
                "user_id": uid,
                "name": (dname or uname or f"用户{uid}"),
                "count": cnt,
                "last_at": last_at.isoformat() if last_at else None,
                "is_me": (uid == me_id),
            })

        # 标签
        tag_rows = (await session.execute(
            select(VideoDeliveryTag.job_id, VideoDeliveryTag.tag)
            .where(VideoDeliveryTag.job_id.in_(job_ids))
            .order_by(VideoDeliveryTag.id)
        )).all()
        for jid, t in tag_rows:
            tags_map.setdefault(jid, []).append(t)

    # 组装返回
    items = []
    for job in jobs:
        title = job.cover_title or job.title or f"视频_{job.id}"
        my_cnt = my_counts.get(job.id, 0)
        items.append(
            {
                "id": job.id,
                "title": title,
                "original_title": job.title,
                "source": job.source or "platform",
                "cdn_url": get_cdn_url(job.video_oss_key, title),
                "thumbnail_url": _thumbnail_url(job.cover_oss_key),
                "created_at": (
                    job.created_at.isoformat()
                    if (job.created_at and job.source == "feishu")
                    else None
                ),
                "updated_at": job.updated_at.isoformat() if job.updated_at else None,
                "feishu_record_id": job.feishu_record_id,
                "duration": job.audio_duration or 0,
                # 下载统计
                "download_count": download_counts.get(job.id, 0),      # 全站累计
                "my_download_count": my_cnt,                            # 我下过几次
                "downloaded_by_me": my_cnt > 0,                         # 是否我下过
                "last_downloaded_at": (
                    last_downloaded[job.id].isoformat() if job.id in last_downloaded else None
                ),
                "downloaders": downloaders_map.get(job.id, []),         # 谁下过(含次数/最近时间)
                # 业务标签
                "tags": tags_map.get(job.id, []),
            }
        )

    return {"items": items, "total": total, "page": page, "page_size": page_size}


async def log_downloads(
    session: AsyncSession, *, job_ids: list[int], user: "User", channel: str | None = None
) -> list[dict]:
    """批量记录下载统计 + 返回CDN链接"""
    stmt = select(NovelVideoJob).where(
        NovelVideoJob.id.in_(job_ids),
        NovelVideoJob.status == "succeeded",
        NovelVideoJob.video_oss_key.isnot(None),
        NovelVideoJob.video_oss_key != "",
    )
    result = await session.execute(stmt)
    jobs = {j.id: j for j in result.scalars().all()}

    for job_id in job_ids:
        if job_id in jobs:
            session.add(VideoDownloadLog(job_id=job_id, user_id=user.id, channel=channel or "web"))

    await session.commit()

    links = []
    for job_id in job_ids:
        if job_id in jobs:
            job = jobs[job_id]
            links.append(
                {
                    "id": job.id,
                    "title": job.cover_title or job.title or f"视频_{job.id}",
                    "cdn_url": get_cdn_url(job.video_oss_key),
                }
            )
    return links


async def get_job_by_id(session: AsyncSession, job_id: int) -> dict | None:
    """根据ID获取单个job"""
    result = await session.execute(
        select(NovelVideoJob).filter(NovelVideoJob.id == job_id)
    )
    job = result.scalar_one_or_none()
    if not job:
        return None
    return {
        "id": job.id,
        "title": job.cover_title or job.title or f"视频_{job.id}",
        "video_url": get_cdn_url(job.video_oss_key) if job.video_oss_key else None,
        "source": job.source or "platform",
    }


# ---------------- 业务标签 ----------------
async def add_tags(session: AsyncSession, *, job_ids: list[int], tag: str, user: "User") -> int:
    """批量给视频打标签(幂等: 已存在的跳过)。返回新增条数。"""
    tag = (tag or "").strip()[:32]
    if not tag or not job_ids:
        return 0
    # 查已存在的 (job_id, tag), 跳过
    existed = set((await session.execute(
        select(VideoDeliveryTag.job_id).where(
            VideoDeliveryTag.job_id.in_(job_ids), VideoDeliveryTag.tag == tag
        )
    )).scalars().all())
    added = 0
    for jid in job_ids:
        if jid in existed:
            continue
        session.add(VideoDeliveryTag(job_id=jid, tag=tag, created_by=getattr(user, "id", None)))
        added += 1
    await session.commit()
    return added


async def remove_tags(session: AsyncSession, *, job_ids: list[int], tag: str) -> int:
    """批量取消标签。返回删除条数。"""
    tag = (tag or "").strip()[:32]
    if not tag or not job_ids:
        return 0
    res = await session.execute(
        delete(VideoDeliveryTag).where(
            VideoDeliveryTag.job_id.in_(job_ids), VideoDeliveryTag.tag == tag
        )
    )
    await session.commit()
    return res.rowcount or 0


async def list_tag_presets(session: AsyncSession) -> list[str]:
    """返回给前端下拉的标签列表: 预置标签 + 已被用过的自定义标签(去重, 预置在前)。"""
    used = (await session.execute(
        select(VideoDeliveryTag.tag).distinct()
    )).scalars().all()
    out = list(PRESET_TAGS)
    for t in used:
        if t not in out:
            out.append(t)
    return out


async def get_download_stats(session: AsyncSession) -> dict:
    """下载统计：总次数 + 热门top10"""
    total = (await session.execute(select(func.count(VideoDownloadLog.id)))).scalar_one()

    top_stmt = (
        select(
            VideoDownloadLog.job_id,
            func.count(VideoDownloadLog.id).label("download_count"),
        )
        .group_by(VideoDownloadLog.job_id)
        .order_by(func.count(VideoDownloadLog.id).desc())
        .limit(10)
    )
    top_job_ids_counts = (await session.execute(top_stmt)).all()

    if top_job_ids_counts:
        job_ids = [row[0] for row in top_job_ids_counts]
        jobs = {
            j.id: j
            for j in (await session.execute(
                select(NovelVideoJob).where(NovelVideoJob.id.in_(job_ids))
            )).scalars().all()
        }
        top_videos = [
            {
                "id": job_id,
                "title": jobs[job_id].cover_title or jobs[job_id].title or f"视频_{job_id}",
                "download_count": count,
            }
            for job_id, count in top_job_ids_counts
            if job_id in jobs
        ]
    else:
        top_videos = []

    return {"total_downloads": total, "top_videos": top_videos}