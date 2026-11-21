"""音效库：manifest 驱动的平台级音效库 + 分类/关键词检索。

## 与 `bgm.py` 的关系

同构，但**不是配乐的子集**：配乐是长循环的"情绪底色"（按 9 个叙事功能标签选），
音效是短促的"事件点"（关门、脚步、打斗、提示音，按类目 + 关键词选）。
两者的检索维度不一样，硬塞进一个模块会让标签词表互相污染。

目录结构与 `bgm.py` 完全一致，理由也一致（见那边的说明）：

```
filmweaver-data/sfx-library/
  manifest.json
  lib/<id>.mp3
```

## manifest 的实际形状（运维已经放下 894 条，别改格式）

```json
{"id": "3a47bc6bca12", "name": "insects chirping", "aliases": [],
 "file": "lib/3a47bc6bca12.mp3", "category": "动物", "tags": ["动物"],
 "is_music": false, "duration": 5.112, "lufs": -24.1, "peak_db": -12.3,
 "size": 163629}
```

同一个库里混着 36 条 `is_music: true`（长曲）——**必须按它筛掉**，
否则"给这一段配个关门声"会检索出一首 15 分钟的 YouTube 背景乐。
本模块只返回 `is_music` 为假的条目。

## 为什么分类不做受控词表

配乐的 mood 是**创作意图**（紧张/燃/温情），必须收敛成少数几档模型才好选；
音效的 category 是**客观来源**（动物/机械/打斗/提示音，19 个类目，还在长）。
钉死一份词表就要求运维每次放素材都先改代码 —— 而这里是"放文件"而不是"改程序"。
所以 category 原样透出（随库内容自适应），检索靠**关键词匹配 name/aliases/tags**。
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

logger = logging.getLogger("fw.sfx")

#: 音效库目录（相对 DATA_DIR）。与 bgm-library 平级。
LIB_DIRNAME = "sfx-library"

#: 支持的音频格式。与 `media.py:136` 的上传扩展名同一口径。
EXTS = (".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg")

#: 单条音效的建议音量区间（0~1）。音效比配乐更靠前，但仍要让台词压得住它。
VOL_DEFAULT = (0.4, 0.8)

#: 一次最多返回多少条。
#:
#: 894 条全塞进模型上下文既浪费 token 也会让它挑花眼。检索命中 ≤ 这个数时直接全给；
#: 超出时按"名字/标签命中数"排序取前 N —— 但**永远同时返回 total**，
#: 让模型知道"库里还有更多，换个更具体的关键词再查"。
MAX_ITEMS = 40


def _root() -> Path:
    from .media import DATA_DIR
    return DATA_DIR / LIB_DIRNAME


def _load_manifest() -> list[dict]:
    """读 manifest。文件不存在 = 空库（**这是正常状态，不是错误**）。

    与 `bgm._load_manifest` 同一个口径：坏 manifest 只警告、不让调用方炸。
    """
    mf = _root() / "manifest.json"
    try:
        raw = json.loads(mf.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except Exception as e:  # noqa: BLE001 — 坏 manifest 不该让面板打不开
        logger.warning("[sfx] manifest 解析失败(%s)，按空库处理: %r", mf, e)
        return []
    if not isinstance(raw, list):
        logger.warning("[sfx] manifest 顶层不是数组，按空库处理: %s", mf)
        return []
    return [x for x in raw if isinstance(x, dict)]


def _url_of(item: dict) -> str | None:
    """manifest 的 `file` → 对外 URL。**只返回文件确实存在的那条**。

    与 `bgm._url_of` 同理：manifest 写了但文件没放，返回它只会让用户下载到 404。
    """
    fn = str(item.get("file") or "").strip()
    if not fn:
        return None
    p = _root() / fn
    if not p.is_file():
        return None
    return f"/fw/media/{LIB_DIRNAME}/{fn}"


def _haystack(item: dict) -> str:
    """用于关键词匹配的一整串小写文本：名字 + 别名 + 标签 + 分类 + 文件名。"""
    parts: list[str] = [str(item.get("name") or ""), str(item.get("category") or "")]
    for key in ("aliases", "tags"):
        v = item.get(key)
        if isinstance(v, list):
            parts += [str(x) for x in v]
    parts.append(str(item.get("file") or ""))
    return " ".join(parts).lower()


def _row(item: dict, url: str) -> dict:
    """一条音效 → 交给模型的形状。

    ## `usage` / `usage_hint` 是给 agent 判断"该用在哪"的核心字段（2026-10-24）

    模型**听不到声音**。库里这些名字（「微光」「10月23日」「大明王朝悬疑音效」）
    光看文字猜不出它是"一下就好"还是"铺满整段"——猜错的表现是音效全错位，
    而且不会报错。所以导入时用 `sfx_features` 算出声学特征，这里转成一句人话：

      · `hit`     一下即止 → 挂在某个动作的那一下
      · `accent`  重击带长尾 → 挂在一个节拍点，别叠第二个
      · `bed`     缓慢渐入 → 铺在一整段下面
      · `texture` 持续质感 → 铺在段落里，音量压低

    老条目没有这些字段时为 None（**不要编**）：那时模型只能按名字与时长判断。
    """
    from .sfx_features import USAGE_CN

    usage = item.get("usage")
    return {
        "id": item.get("id") or item.get("file"),
        "name": item.get("name") or item.get("file"),
        "url": url,
        "category": item.get("category") or None,
        "tags": item.get("tags") or [],
        "duration": item.get("duration"),
        #: 用途类型（hit / accent / bed / texture）与一句话说明。见上面。
        "usage": usage,
        # manifest 里存了就用存的（导入时的措辞），没存就按档位补上。
        # **不另写一份文案** —— 两处措辞一旦漂移，模型看到的就是两套说法。
        "usage_hint": item.get("usage_hint") or (
            USAGE_CN.get(usage) if usage else None),
        # 响度信息给模型判断"这个音效会不会盖住台词"。没有就是没测过，不要编。
        "lufs": item.get("lufs"),
        "peak_db": item.get("peak_db"),
    }


def usage_guide() -> dict[str, str]:
    """四档各是什么意思。跟着检索结果一起给，省得模型去猜 hit 是名词还是动词。"""
    from .sfx_features import USAGE_CN
    return dict(USAGE_CN)


def list_library(*, query: str | None = None, category: str | None = None,
                 usage: str | None = None,
                 max_duration: float | None = None,
                 limit: int = MAX_ITEMS) -> dict:
    """音效库检索。空库返回空数组 + 明确提示（**不是错误**）。

    `query` 按空格切词，要求**每个词**都出现在 `_haystack` 里（AND）——
    比 OR 精确：「关门」比「关」有用得多，而 OR 会把所有含"关"的条目都捞上来。
    中英文都适用（子串匹配，不依赖分词）。

    `max_duration` 是给"这条音效不能比画面长"用的：一段 0.8 秒的关门动作
    配一个 5 秒的环境音，剪出来就是声音盖过下一镜。

    ## `usage`：按"该挂在哪"直接筛（2026-10-24）

    这是回答"我该用哪条"最快的一刀。想给一个关门动作配"一下即止"的音，
    就 `usage="hit"` —— 不用先猜名字。四档见 `_USAGE_CN`。
    传了但库里一条都没有时**不报错**，返回空 + 说清这个档位有几条，
    让模型知道是"这个库里没有这类"而不是"库空了"。
    """
    items: list[dict] = []
    missing = 0
    cats: dict[str, int] = {}
    #: 全库按 usage 计数（**在 usage 过滤之前**统计，过滤后才知道别的档位有什么）
    all_usages: dict[str, int] = {}
    for it in _load_manifest():
        u = str(it.get("usage") or "").strip()
        if u and not it.get("is_music"):
            all_usages[u] = all_usages.get(u, 0) + 1

    want_usage = str(usage or "").strip().lower() or None
    q_terms = [t for t in str(query or "").lower().split() if t]
    for it in _load_manifest():
        # 混在同一个库里的长曲不能当音效用（见模块文档）
        if it.get("is_music"):
            continue
        url = _url_of(it)
        if not url:
            missing += 1
            continue
        if want_usage and str(it.get("usage") or "").strip().lower() != want_usage:
            continue
        cat = str(it.get("category") or "").strip()
        if cat:
            cats[cat] = cats.get(cat, 0) + 1
        if category and cat != category:
            continue
        if max_duration is not None:
            try:
                if float(it.get("duration") or 0) > float(max_duration):
                    continue
            except (TypeError, ValueError):
                continue
        hay = _haystack(it)
        if q_terms and not all(t in hay for t in q_terms):
            continue
        items.append(_row(it, url))

    total = len(items)
    # 命中过多时按名字与 query 的重合度排序取前 limit 条。给 total 让模型知道被截了。
    if q_terms and total > limit:
        items.sort(key=lambda r: (-sum(1 for t in q_terms if t in (r["name"] or "").lower()),
                                  r["duration"] or 0))

    out: dict = {
        "ok": True,
        "items": items[:max(1, limit)],
        "count": min(total, max(1, limit)),
        "total": total,
        "categories": dict(sorted(cats.items(), key=lambda kv: -kv[1])),
        #: 全库各用途档位的条数 —— 模型据此知道"换个 usage 还有什么可选"。
        #: 放在过滤之前统计，所以按 usage 筛完它也是全库视角。
        "usages": dict(sorted(all_usages.items(), key=lambda kv: -kv[1])),
        #: 四档各是什么意思。跟着结果一起给，省得模型去猜 "hit" 是名词还是动词。
        "usage_guide": usage_guide(),
    }
    if total > limit:
        out["note"] = (f"命中 {total} 条，只返回前 {max(1, limit)} 条；"
                       "换个更具体的关键词（如「关门」「脚步」）"
                       "或用 usage 指定档位（hit/accent/bed/texture）再查。")
    if not total and want_usage:
        # 分开这两种情况：库里有东西、只是没有这个档位 —— 那不该说"库为空"，
        # 否则模型会以为要"跳过配音效这一步"，而其实换一档就能用。
        have = "、".join(f"{k} {v} 条" for k, v in
                        sorted(all_usages.items(), key=lambda kv: -kv[1])) or "无"
        out["note"] = (f"库里没有 usage={want_usage} 的条目。现有档位：{have}。"
                       "换一档再查，或去掉 usage 看看整体。")
    elif not total:
        out["note"] = ("音效库为空，或没有匹配的条目。"
                       f"请把已授权的音频放进 filmweaver-data/{LIB_DIRNAME}/ "
                       "并写 manifest.json。库为空时**跳过配音效这一步**，如实告诉用户，"
                       "不要编造音效，也不要因此停下整轮。")
    if missing:
        out["missing_files"] = missing
        out["note"] = (out.get("note", "") + f" 另有 {missing} 条记录找不到对应文件，已跳过。").strip()
    return out


def find_by_id(sfx_id: str) -> dict | None:
    """按 id 取一条**可用的**音效（文件必须在）。供计划校验使用。"""
    if not sfx_id:
        return None
    for it in _load_manifest():
        if it.get("is_music"):
            continue
        if str(it.get("id") or "") != sfx_id:
            continue
        url = _url_of(it)
        return _row(it, url) if url else None
    return None
