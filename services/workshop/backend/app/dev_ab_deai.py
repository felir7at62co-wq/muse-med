"""A/B 验证：去味规则注入生成 prompt 前后，产出质量对比（PLAN §5.2）

## 为什么必须做这一步

B7 的规则会**改变所有产出**。在没有任何对照的情况下全量上线，等于对全平台
所有生成结果做一次未经检验的行为变更。

而这里有个特别的陷阱：**不能只看检测分**。

docs/RESEARCH-去AI感方法论.md 明确记录：

    "sepia 的 detector 研究记录过，迭代改写可把人类文本的检测分从 0% 推到 100%
     —— 追着分数改，结果是越改越可疑。"

所以本工具的输出是**三组数据**，供人工判断：

  1. AI 味检测分（同批两组对比，只看**相对差**，不当验收标准）
  2. 结构化指标（句长参差度、段落均匀度 —— 这些是"机器手感"的客观侧写）
  3. **两份原文并排**，供人工盲评

第 3 条是重点。前两项只是帮人快速定位可疑样本。

## 用法

    python -m app.dev_ab_deai --draft-id 584 --episodes 3

会对同一份大纲的第 1..N 集各生成两遍（关规则 / 开规则），
落盘到 uploads/ab_deai/ 并打印对比。**会产生真实 LLM 费用**。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
from pathlib import Path

from .defaults import DEFAULT_CHAPTER_WORD_TARGET

logger = logging.getLogger("ab_deai")

OUT_DIR = (Path(os.environ["UPLOADS_DIR"]) / "ab_deai")


async def _gen_one(draft_id: int, order: int, *, with_rules: bool) -> str:
    """生成一集，可控地开关去味规则。

    ⚠ 通过临时改写模块级函数来实现开关 —— 不改 generate_chapter 的签名，
    这样不会波及任何既有调用点（77 个 get_llm 调用点的教训：签名改动极易漏改）。
    """
    # ⚠️ 本模块位于 app/ 下（= 顶层包 app），所以只能用**单点**相对导入。
    # 写成 `..polish` 会越过顶层包，报 "attempted relative import beyond
    # top-level package" —— 且只在真正跑起来时才炸（`-m app.dev_ab_deai` 下
    # 模块名是 app.dev_ab_deai，不是 app.dev_ab_deai 的子模块）。
    from .polish import deai_rules
    from .stages import chapter_gen
    from .db import session_scope
    from sqlalchemy import text

    # 读大纲
    async with session_scope() as s:
        row = (await s.execute(
            text("SELECT outline FROM script_drafts WHERE id = :i"), {"i": draft_id}
        )).first()
    if not row or not row[0]:
        raise RuntimeError(f"draft {draft_id} 没有大纲")
    outline = row[0] if isinstance(row[0], dict) else json.loads(row[0])

    # 读前序章节（保持与真实生成一致的上下文）
    async with session_scope() as s:
        prev = (await s.execute(
            text("""SELECT chapter_order, title, full_text, summary FROM script_chapters
                    WHERE draft_id = :i AND chapter_order < :o ORDER BY chapter_order"""),
            {"i": draft_id, "o": order},
        )).all()
    prev_chapters = [
        {"order": r[0], "title": r[1], "full_text": r[2] or "", "summary": r[3] or ""}
        for r in prev
    ]

    original = deai_rules.build_deai_rules_block
    try:
        # 关规则时让 build 返回空串 —— 其余代码路径完全一致，这就是"同批对照"
        deai_rules.build_deai_rules_block = lambda enabled=True: (original(enabled) if with_rules else "")
        # chapter_gen 是 from ... import 拿的函数引用，必须一并替换
        chapter_gen.build_deai_rules_block = deai_rules.build_deai_rules_block
        text_out = await chapter_gen.generate_chapter(
            outline=outline,
            chapter_order=order,
            word_target=int(outline.get("chapter_word_target") or DEFAULT_CHAPTER_WORD_TARGET),
            prev_chapters=prev_chapters,
            provider="gemini",
            draft_id=None,          # 不写日志，避免污染真实草稿的日志流
        )
    finally:
        deai_rules.build_deai_rules_block = original
        chapter_gen.build_deai_rules_block = original
    return text_out


def _spread_metrics(t: str) -> dict:
    """句长参差度 / 段落均匀度 —— "机器手感"的客观侧写。

    RESEARCH 的结论是"通篇句子一样长、段落一样厚 = 均匀 = 机器的手感"。
    所以这两个指标是**越低越像机器**（参差度低 = 太均匀）。
    """
    import re as _re
    sents = [s for s in _re.split(r"[。！？…]+", t) if s.strip()]
    paras = [p for p in t.split("\n") if p.strip()]
    if not sents or not paras:
        return {}
    sl = [len(s) for s in sents]
    pl = [len(p) for p in paras]
    mean_s = sum(sl) / len(sl)
    mean_p = sum(pl) / len(pl)
    sd_s = (sum((x - mean_s) ** 2 for x in sl) / len(sl)) ** 0.5
    sd_p = (sum((x - mean_p) ** 2 for x in pl) / len(pl)) ** 0.5
    return {
        "句数": len(sents),
        "句长均值": round(mean_s, 1),
        "句长标准差": round(sd_s, 1),
        # 变异系数：标准差/均值。**参差度**，越高越像人写的
        "句长变异系数": round(sd_s / mean_s, 3) if mean_s else 0,
        "段数": len(paras),
        "段长变异系数": round(sd_p / mean_p, 3) if mean_p else 0,
    }


async def run(draft_id: int, episodes: list[int]) -> None:
    from .polish.ai_taste import detect_ai_taste

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    summary = []

    for order in episodes:
        logger.info("=== 第 %d 集 ===", order)
        # 两组各自生成。刻意**串行**：并行会让同一批的模型侧条件不一致
        # （中转站限流/换线路），对照就不公平了。
        off = await _gen_one(draft_id, order, with_rules=False)
        on = await _gen_one(draft_id, order, with_rules=True)

        r_off = detect_ai_taste(off)
        r_on = detect_ai_taste(on)

        row = {
            "集": order,
            "关规则": {"AI味分": r_off.score, "A级命中": r_off.a_count, "字数": len(off), **_spread_metrics(off)},
            "开规则": {"AI味分": r_on.score, "A级命中": r_on.a_count, "字数": len(on), **_spread_metrics(on)},
        }
        summary.append(row)

        # 落盘原文供人工盲评（这是最重要的一步 —— 分数只用于定位可疑样本）
        (OUT_DIR / f"ep{order:03d}_关规则.txt").write_text(off, encoding="utf-8")
        (OUT_DIR / f"ep{order:03d}_开规则.txt").write_text(on, encoding="utf-8")

        print(f"\n── 第 {order} 集 ──")
        print(f"  关规则: 分 {r_off.score} | A级 {r_off.a_count} | 句长变异 {row['关规则']['句长变异系数']}")
        print(f"  开规则: 分 {r_on.score} | A级 {r_on.a_count} | 句长变异 {row['开规则']['句长变异系数']}")

    (OUT_DIR / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\n原文已落盘到 {OUT_DIR}/（供人工盲评）")
    print("⚠ 分数只用于'同批改前改后比一比'，不是验收标准 —— 必须人工盲评后再全量。")


def main() -> None:
    ap = argparse.ArgumentParser(description="去味规则 A/B 验证")
    ap.add_argument("--draft-id", type=int, required=True)
    ap.add_argument("--episodes", type=int, default=3, help="验证前 N 集")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    asyncio.run(run(args.draft_id, list(range(1, args.episodes + 1))))


if __name__ == "__main__":
    main()
