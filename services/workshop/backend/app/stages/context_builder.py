"""M5增强版上下文构建器。"""
from __future__ import annotations


def build_context_for_episode(
    episode_order: int,
    total_episodes: int,
    original_outline: dict,
    locked_episodes: list[dict],
) -> str:
    """构建单集生成的上下文。
    
    策略:
    1. 原初大纲(完整)
    2. 前一集(完整,如果已锁定)
    3. 后一集(完整,如果已锁定)
    4. 其他已锁定集(仅标题+摘要)
    5. 明确标注当前生成位置
    """
    ctx_parts = []
    
    # 1. 原初大纲
    if original_outline:
        ctx_parts.append(f"# 原初大纲\n标题: {original_outline.get('title', '')}\n主线: {original_outline.get('synopsis', '')}")
    
    # 2. 当前位置
    ctx_parts.append(f"\n# 当前生成\n第 {episode_order} 集 (共 {total_episodes} 集)")
    
    # 3. 已锁定集
    if locked_episodes:
        prev_ep = next((e for e in locked_episodes if e.get('order') == episode_order - 1), None)
        next_ep = next((e for e in locked_episodes if e.get('order') == episode_order + 1), None)
        
        if prev_ep:
            ctx_parts.append(f"\n# 前一集(已锁定)\n{prev_ep.get('order')}. {prev_ep.get('title', '')}\n{prev_ep.get('synopsis', '')}")
        
        if next_ep:
            ctx_parts.append(f"\n# 后一集(已锁定)\n{next_ep.get('order')}. {next_ep.get('title', '')}\n{next_ep.get('synopsis', '')}")
        
        other_locked = [e for e in locked_episodes if e.get('order') not in [episode_order - 1, episode_order + 1]]
        if other_locked:
            ctx_parts.append("\n# 其他已锁定集")
            for e in other_locked[:5]:  # 最多5个
                ctx_parts.append(f"{e.get('order')}. {e.get('title', '')}")
    
    return "\n".join(ctx_parts)


def neighborhood_block(outline: dict, order: int, *, n_prev: int = 3) -> str:
    """单集（重）生成时的**人物 + 前后集**上下文，不论前后集是否锁定。

    2026-10-28 生产事故（草稿 #2952）：区间重写第 109–117 集时，上下文只有剧名和占位梗概
    「（从已有剧本导入）」——`build_context_for_episode` 只在前后集**已锁定**时才带上它们，
    而导入/改编来的草稿人物表又是空的。模型于是凭空另起一套人物（前 108 集是顾远舟、苏小满，
    新写的变成林晚、陈屿），同一批里还"陈屿""陈野"混用。

    人物表为空时，从前面各集的 `characters` 字段与梗概里出现频次最高的名字推出主要人物。
    """
    chs = sorted((c for c in (outline.get("chapters") or []) if isinstance(c, dict)),
                 key=lambda c: int(c.get("order") or 0))
    prev = [c for c in chs if int(c.get("order") or 0) < order][-n_prev:]
    nxt = next((c for c in chs if int(c.get("order") or 0) > order), None)

    parts: list[str] = []
    cast = [c for c in (outline.get("characters") or []) if isinstance(c, dict) and c.get("name")]
    if not cast:
        cast = [c for c in ((outline.get("story_bible") or {}).get("characters") or [])
                if isinstance(c, dict) and c.get("name")]
    if cast:
        parts.append("# 人物表（姓名、身份全剧沿用）")
        for c in cast[:12]:
            parts.append(f"- {c.get('name')}（{c.get('role', '')}）{c.get('appearance', '') or c.get('arc', '')}".rstrip())
    else:
        from collections import Counter
        cnt: Counter = Counter()
        for c in chs[max(0, len(chs) - 30):]:
            for n in c.get("characters") or []:
                if isinstance(n, str) and 1 < len(n) <= 6:
                    cnt[n] += 1
        if cnt:
            # 只有名字不够：实测"何建民"在前文是检测机构的帮手，重写时被写成了化工厂老板。
            # 每个名字附上他**首次出场**那一句，作为身份依据。
            import re as _re
            parts.append("# 本剧已出场的主要人物（从前面各集统计；姓名与身份全剧沿用，不要另起新名字）")
            for n, _ in cnt.most_common(10):
                first = next((c for c in chs if n in str(c.get("synopsis") or "")), None)
                seg = ""
                if first:
                    sents = _re.split(r"(?<=[。！？；])", str(first.get("synopsis") or ""))
                    seg = next((x.strip() for x in sents if n in x), "")[:70]
                parts.append(f"- {n}" + (f"：第{first.get('order')}集「{seg}」" if seg else ""))
    if prev:
        parts.append(f"\n# 前 {len(prev)} 集（本集紧接其后）")
        for c in prev:
            who = "、".join(x for x in (c.get("characters") or []) if isinstance(x, str))
            parts.append(f"第{c.get('order')}集《{c.get('title', '')}》{('（人物：' + who + '）') if who else ''}\n"
                         f"{c.get('synopsis', '')}")
            ho = (c.get("hook_out") or {}).get("leads_to") if isinstance(c.get("hook_out"), dict) else ""
            if ho and c is prev[-1]:
                parts.append(f"上一集结尾钩子：{ho}")
    if nxt:
        parts.append(f"\n# 后一集（本集要接得上）\n第{nxt.get('order')}集《{nxt.get('title', '')}》\n{nxt.get('synopsis', '')}")
    return "\n".join(parts)
