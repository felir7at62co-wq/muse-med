"""管理员数据分析: 意见库/提示词效果/生成质量指标"""
import logging
import re
from collections import Counter
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, Query
from sqlalchemy import text

from ..db import session_scope
from ..auth import require_admin, User

router = APIRouter(prefix="/v1/admin-api/analytics", tags=["admin-analytics"])
logger = logging.getLogger("admin-analytics")


# 中文停用词(简单版)
CN_STOPWORDS = {
    "的", "了", "是", "我", "你", "他", "她", "它", "这", "那", "有", "在", "和", "就",
    "但", "不", "一下", "也", "请", "要", "吧", "吗", "呢", "啊", "哦", "让", "把",
    "可以", "能", "需要", "请问", "帮我", "一个", "可能", "或者", "因为", "所以",
    "感觉", "觉得", "这里", "那里", "一些", "什么", "太", "比较", "有点", "应该",
    "建议", "希望", "最好", "更", "这样", "一样", "起来", "出来", "下来", "上去",
    "然后", "这个", "那个", "如果", "或者", "之后", "之前", "现在", "一定", "不要",
}

# 常见feedback关键词
KEY_PATTERNS = [
    r"太平淡", r"太快", r"太慢", r"太长", r"太短",
    r"加.{0,5}冲突", r"加.{0,5}反转", r"增加.{0,5}紧张", r"节奏",
    r"人设.{0,5}崩", r"人物.{0,5}扁平", r"性格.{0,5}不.{0,5}鲜明",
    r"对白.{0,5}生硬", r"台词.{0,5}尴尬",
    r"逻辑.{0,5}不.{0,5}通", r"设定.{0,5}矛盾",
    r"重复", r"啰嗦", r"冗余",
    r"高潮.{0,5}不.{0,5}够", r"结尾.{0,5}仓促",
]


@router.get("/feedback")
async def feedback_analytics(
    days: int = Query(30, ge=1, le=365),
    admin: User = Depends(require_admin)
):
    """意见库分析: 所有feedback的统计"""
    async with session_scope() as s:
        since = datetime.utcnow() - timedelta(days=days)
        
        # 拉取所有含feedback的日志(用jsonb_exists避免?操作符被误解析)
        rows = (await s.execute(
            text("""SELECT gl.stage, gl.chapter_order, gl.log_metadata AS metadata, gl.created_at, gl.draft_id,
                    d.user_id, u.username
                    FROM generation_logs gl
                    LEFT JOIN script_drafts d ON d.id = gl.draft_id
                    LEFT JOIN users u ON u.id = d.user_id
                    WHERE jsonb_exists(gl.log_metadata, 'feedback')
                    AND gl.created_at >= :since
                    ORDER BY gl.created_at DESC"""),
            {"since": since}
        )).mappings().all()
        
        feedbacks = []
        for r in rows:
            fb = (r["metadata"] or {}).get("feedback", "")
            if fb:
                feedbacks.append({
                    "feedback": fb,
                    "stage": r["stage"],
                    "chapter_order": r["chapter_order"],
                    "draft_id": r["draft_id"],
                    "username": r["username"],
                    "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                })
        
        total = len(feedbacks)
        
        # 按stage分组
        by_stage: dict[str, int] = {}
        for f in feedbacks:
            stg = f["stage"] or "unknown"
            by_stage[stg] = by_stage.get(stg, 0) + 1
        
        # 关键词频次(模式匹配)
        pattern_counts: dict[str, int] = {}
        for f in feedbacks:
            fb = f["feedback"]
            for pat in KEY_PATTERNS:
                if re.search(pat, fb):
                    key = pat.replace(".{0,5}", "")
                    pattern_counts[key] = pattern_counts.get(key, 0) + 1
        top_patterns = sorted(pattern_counts.items(), key=lambda x: -x[1])[:20]
        
        # 词频统计(简单中文字符分组: 2字词 + 3字词)
        word_counter: Counter = Counter()
        for f in feedbacks:
            text_fb = f["feedback"]
            # 2字词
            for i in range(len(text_fb) - 1):
                w = text_fb[i:i+2]
                if re.match(r'^[\u4e00-\u9fff]{2}$', w) and w not in CN_STOPWORDS:
                    word_counter[w] += 1
            # 3字词
            for i in range(len(text_fb) - 2):
                w = text_fb[i:i+3]
                if re.match(r'^[\u4e00-\u9fff]{3}$', w) and w not in CN_STOPWORDS:
                    word_counter[w] += 1
        
        top_words = word_counter.most_common(30)
        
        # 按用户
        user_counts: dict[str, int] = {}
        for f in feedbacks:
            uname = f["username"] or "unknown"
            user_counts[uname] = user_counts.get(uname, 0) + 1
        top_users = sorted(user_counts.items(), key=lambda x: -x[1])[:10]
        
        # 按日期
        by_date: dict[str, int] = {}
        for f in feedbacks:
            if f["created_at"]:
                day = f["created_at"][:10]
                by_date[day] = by_date.get(day, 0) + 1
        
        return {
            "total": total,
            "days": days,
            "by_stage": by_stage,
            "top_patterns": [{"keyword": k, "count": v} for k, v in top_patterns],
            "top_words": [{"word": w, "count": c} for w, c in top_words],
            "top_users": [{"username": u, "count": c} for u, c in top_users],
            "by_date": sorted([{"date": d, "count": c} for d, c in by_date.items()], key=lambda x: x["date"]),
            "recent_feedbacks": feedbacks[:20],  # 最近20条原文
        }


@router.get("/prompt-stats")
async def prompt_stats(admin: User = Depends(require_admin)):
    """提示词效果统计(粗略版)"""
    async with session_scope() as s:
        # 各stage的活跃提示词
        prompts = (await s.execute(
            text("""SELECT stage, name, version, is_active FROM prompts
                    ORDER BY stage, is_active DESC, id DESC""")
        )).mappings().all()
        
        # 生成总次数 vs 意见重写次数(粗略反映"满意度")
        stats = (await s.execute(
            text("""SELECT stage, COUNT(*) FILTER (WHERE log_type = 'done') as completed,
                    COUNT(*) FILTER (WHERE jsonb_exists(log_metadata, 'feedback')) as rewrites
                    FROM generation_logs
                    WHERE created_at >= NOW() - INTERVAL '30 days'
                    GROUP BY stage""")
        )).mappings().all()
        
        stats_dict = {r["stage"]: {
            "completed": r["completed"],
            "rewrites": r["rewrites"],
            "rewrite_rate": round((r["rewrites"] / r["completed"] * 100), 2) if r["completed"] > 0 else 0,
        } for r in stats}
        
        return {
            "prompts": [dict(r) for r in prompts],
            "stats_by_stage": stats_dict,
        }


@router.get("/gen-metrics")
async def gen_metrics(
    days: int = Query(7, ge=1, le=90),
    admin: User = Depends(require_admin)
):
    """生成质量指标"""
    async with session_scope() as s:
        since = datetime.utcnow() - timedelta(days=days)
        
        # 按stage统计
        by_stage = (await s.execute(
            text("""SELECT stage,
                    COUNT(*) as total,
                    COUNT(*) FILTER (WHERE log_type = 'done') as success,
                    COUNT(*) FILTER (WHERE log_type = 'error') as error
                    FROM generation_logs
                    WHERE created_at >= :since AND stage IS NOT NULL
                    GROUP BY stage
                    ORDER BY total DESC"""),
            {"since": since}
        )).mappings().all()
        
        # 章节长度分布(字数分组)
        word_dist = (await s.execute(
            text("""SELECT 
                    CASE
                        WHEN word_count < 1000 THEN '<1k'
                        WHEN word_count < 3000 THEN '1-3k'
                        WHEN word_count < 5000 THEN '3-5k'
                        WHEN word_count < 8000 THEN '5-8k'
                        ELSE '>8k'
                    END as bucket,
                    COUNT(*) as count
                    FROM script_chapters
                    WHERE word_count > 0
                    GROUP BY bucket
                    ORDER BY bucket""")
        )).mappings().all()
        
        # 按天统计
        by_day = (await s.execute(
            text("""SELECT DATE(created_at) as day, COUNT(*) as count
                    FROM generation_logs
                    WHERE created_at >= :since
                    GROUP BY day ORDER BY day"""),
            {"since": since}
        )).mappings().all()
        
        return {
            "days": days,
            "by_stage": [dict(r) for r in by_stage],
            "word_distribution": [dict(r) for r in word_dist],
            "by_day": [{"day": r["day"].isoformat() if hasattr(r["day"], 'isoformat') else str(r["day"]),
                       "count": r["count"]} for r in by_day],
        }
