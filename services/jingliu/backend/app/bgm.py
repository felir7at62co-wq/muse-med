"""配乐库：manifest 驱动的平台级曲库 + mood 检索。

## 为什么是 manifest 文件而不是数据库表

与 `routers/voice.py` 的音色库同款理由：**曲库是全局素材，由运维往目录里放，
不由用户在软件里增删**。加一张表意味着「放文件」之外还要写一次入库，
多一道会忘的手续；manifest 就在音频旁边，放文件时顺手写完。

```
filmweaver-data/bgm-library/
  manifest.json
  tension_01.mp3
  ...
```

## mood 为什么是受控词表而不是自由文本 + 向量

实测（2026-10-20）：三条渠道里 **只有 modelverse 提供 embedding**
（`text-embedding-3-small` zx1/kege 均 503），意味着语义检索是单点依赖；
而且入库时逐首算向量是持续的运维负担。

改用「9 个叙事功能标签 + 1~5 强度」后：
  · 过滤后的候选通常只有 3~10 首，让 LLM 读 `desc` 直接选比向量最近邻更准
    （它知道"这场是女主第一次反击"这种上下文）；
  · 决策可解释 —— 用户问"为什么配这首"，答案是具体那句话；
  · 零新增依赖。

## 标签为什么按**叙事功能**分而不是按音乐流派分

用户关心的不是"这是不是弦乐"，而是"这一段该不该紧张"。所以 `triumph`
（燃/爽）单独一档就很关键 —— 它是短剧的核心爽点，而音乐流派分类里没有这个概念。
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

logger = logging.getLogger("fw.bgm")

#: 曲库目录（相对 DATA_DIR）。
LIB_DIRNAME = "bgm-library"

#: 情绪主标签：**受控词表**。新增需要同步改这里 + 前端的筛选下拉。
MOODS: dict[str, str] = {
    "tension": "紧张 —— 对峙、追逐、危机",
    "suspense": "悬疑 —— 铺垫、试探、秘密将揭",
    "triumph": "燃/爽 —— 反击、逆袭、打脸（短剧核心爽点）",
    "warm": "温情 —— 亲情、和解、日常温暖",
    "sad": "悲伤 —— 分别、背叛、失去",
    "comedy": "欢快 —— 插科打诨、误会",
    "epic": "宏大 —— 转场、时代铺陈",
    "ambient": "空灵 —— 空镜、留白、无台词段",
    "neutral": "中性 —— 过场、信息交代",
}

#: 支持的音频格式（与 `media.py:136` 的上传扩展名同一口径，不新开一套）。
EXTS = (".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg")

#: 单段 BGM 的建议音量区间（0~1）。有台词时压低，纯空镜可抬高。
VOL_WITH_DIALOGUE = (0.15, 0.35)
VOL_NO_DIALOGUE = (0.5, 0.8)


def _root() -> Path:
    from .media import DATA_DIR
    return DATA_DIR / LIB_DIRNAME


def _load_manifest() -> list[dict]:
    """读 manifest。文件不存在 = 空库（**这是正常状态，不是错误**）。"""
    mf = _root() / "manifest.json"
    try:
        raw = json.loads(mf.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except Exception as e:  # noqa: BLE001 — 坏 manifest 不该让面板打不开
        logger.warning("[bgm] manifest 解析失败(%s)，按空库处理: %r", mf, e)
        return []
    if not isinstance(raw, list):
        logger.warning("[bgm] manifest 顶层不是数组，按空库处理: %s", mf)
        return []
    return [x for x in raw if isinstance(x, dict)]


def _url_of(item: dict) -> str | None:
    """manifest 的 `file` → 对外 URL。**只返回文件确实存在的那条**。

    manifest 写了但文件没传，前端点了会 404 —— 不如当它不存在。
    """
    fn = str(item.get("file") or "").strip()
    if not fn:
        return None
    p = _root() / fn
    if not p.is_file():
        return None
    return f"/fw/media/{LIB_DIRNAME}/{fn}"


def list_library(*, mood: str | None = None, min_intensity: int = 1,
                 max_intensity: int = 5) -> dict:
    """曲库列表（可按 mood / 强度过滤）。空库返回空数组 + 明确提示。"""
    items = []
    missing_files = 0
    for it in _load_manifest():
        url = _url_of(it)
        if not url:
            missing_files += 1
            continue
        m = str(it.get("mood") or it.get("mood_primary") or "").strip()
        if m and m not in MOODS:
            # 未知 mood 不丢弃，但在返回里标出来 —— 让运维看到自己写错了
            logger.warning("[bgm] %s 的 mood=%r 不在受控词表里", it.get("id"), m)
        try:
            inten = int(it.get("intensity") or 3)
        except (TypeError, ValueError):
            inten = 3
        if mood and m != mood:
            continue
        if not (min_intensity <= inten <= max_intensity):
            continue
        items.append({
            "id": it.get("id") or it.get("file"),
            "name": it.get("name") or it.get("file"),
            "url": url,
            "mood": m or None,
            "mood_cn": MOODS.get(m, m or ""),
            "intensity": inten,
            "bpm": it.get("bpm"),
            "duration": it.get("duration"),
            "instruments": it.get("instruments") or [],
            "vocals": bool(it.get("vocals")),
            "loopable": bool(it.get("loopable", True)),
            "desc": it.get("desc") or "",
            "license": it.get("license") or "",
        })

    out: dict = {
        "ok": True,
        "items": items,
        "count": len(items),
        "moods": MOODS,
    }
    if not items:
        out["note"] = (
            "配乐库为空。请把已授权的音频放进 "
            f"filmweaver-data/{LIB_DIRNAME}/ 并写 manifest.json；"
            "格式见 docs/PLAN-镜流超级Agent-落地方案.md 第 8 节。")
    if missing_files:
        out["missing_files"] = missing_files
        out["note"] = out.get("note", "") + (
            f" 另有 {missing_files} 条 manifest 记录找不到对应文件，已跳过。")
    return out


def find_by_id(bgm_id: str) -> dict | None:
    for it in list_library()["items"]:
        if it["id"] == bgm_id:
            return it
    return None


# ---------------------------------------------------------------------------
# 计划校验
# ---------------------------------------------------------------------------

def validate_plan(plan: dict, *, shots: list[dict], total_sec: float,
                  default_volume: float = 0.3) -> dict:
    """校验并规范化 agent 给出的 BGM 计划。

    `plan = {"segments": [{from_shot, to_shot, mood, intensity, bgm_id,
                           volume, fade_in, fade_out, reason}]}`

    返回 `{"ok": true, "segments": [...]}` 或 `{"ok": false, "error": ...}`。

    ## 为什么必须校验

    计划的每一段都要落成一条 `AudioClip`，而时间轴由**全剧镜号**定位。
    agent 很容易把"本集第 3 镜"当成 order=3（实际可能是 order=23）。
    这里做三件事：把镜号规整到真实存在的 order、裁掉越界的段、补默认音量。
    """
    segs = plan.get("segments") if isinstance(plan, dict) else None
    if not isinstance(segs, list) or not segs:
        return {"ok": False, "error": "segments 为空"}

    valid_orders = [int(s["order"]) for s in shots if s.get("order") is not None]
    if not valid_orders:
        return {"ok": False, "error": "项目没有可用的镜头，无法安排配乐"}
    o_min, o_max = min(valid_orders), max(valid_orders)

    out = []
    errors = []
    for i, raw in enumerate(segs):
        if not isinstance(raw, dict):
            continue
        try:
            a = int(raw.get("from_shot"))
            b = int(raw.get("to_shot"))
        except (TypeError, ValueError):
            errors.append(f"第 {i + 1} 段镜号不是整数")
            continue
        if a > b:
            a, b = b, a
        a, b = max(a, o_min), min(b, o_max)
        if a > b:
            errors.append(f"第 {i + 1} 段镜号 {raw.get('from_shot')}"
                          f"~{raw.get('to_shot')} 全部越界")
            continue

        bgm_id = str(raw.get("bgm_id") or "").strip()
        item = find_by_id(bgm_id) if bgm_id else None
        if bgm_id and item is None:
            errors.append(f"第 {i + 1} 段的 bgm_id={bgm_id} 不在曲库里，已跳过")
            continue
        if item is None:
            errors.append(f"第 {i + 1} 段没有指定 bgm_id，已跳过")
            continue

        mood = str(raw.get("mood") or item.get("mood") or "neutral")
        if mood not in MOODS:
            mood = "neutral"

        try:
            vol = float(raw.get("volume"))
        except (TypeError, ValueError):
            vol = default_volume
        # 夹到合理区间：>1 会削波，<=0 等于没有
        vol = min(1.0, max(0.02, vol))

        def _f(key: str, dflt: float) -> float:
            try:
                return max(0.0, float(raw.get(key)))
            except (TypeError, ValueError):
                return dflt

        out.append({
            "from_shot": a,
            "to_shot": b,
            "mood": mood,
            "intensity": int(raw.get("intensity") or item.get("intensity") or 3),
            "bgm_id": item["id"],
            "url": item["url"],
            "volume": round(vol, 3),
            "fade_in": round(_f("fade_in", 1.0), 2),
            "fade_out": round(_f("fade_out", 1.5), 2),
            "reason": str(raw.get("reason") or "")[:200],
        })

    if not out:
        return {"ok": False, "error": "；".join(errors) or "没有一段可用的配乐"}

    # 段之间不许重叠：后一段的起点若早于前一段的终点，顺延到前一段终点之后。
    out.sort(key=lambda x: x["from_shot"])
    for i in range(1, len(out)):
        if out[i]["from_shot"] <= out[i - 1]["to_shot"]:
            out[i]["from_shot"] = out[i - 1]["to_shot"] + 1
            if out[i]["from_shot"] > out[i]["to_shot"]:
                out[i]["to_shot"] = out[i]["from_shot"]

    res: dict = {"ok": True, "segments": out}
    if errors:
        res["warnings"] = errors
    return res
