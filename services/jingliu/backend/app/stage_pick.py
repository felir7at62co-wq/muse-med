"""「这一镜该用哪套造型」的唯一判据（2026-10-19 抽出来的）。

## 为什么单独成一个模块

这段排序原先只存在于 `jobs._auto_inject_refs_detailed` 里的一个闭包 `_rank`。
前端 `app.js::stageForShot` 是它的第二份实现（不能为了显示一张缩略图就去打接口），
而"造型阶段到底生没生效"这个用户最常问的问题，**没有任何地方能给出答案** ——
只能靠人翻库看区间。

抽出来之后有三处共用同一份判据：

  1. 出片注入（`jobs._auto_inject_refs_detailed`）—— 真正决定送哪张图
  2. 造型阶段面板的诊断（`stage_scene.list_stages`）—— 告诉用户"这套造型赢了几镜、
     为什么没赢"，而不是让他猜
  3. 验收脚本（`scripts/verify_stage_pick_parity.py`）—— 与前端实现逐镜对拍

## ⚠️ 镜号是**全剧镜号**，不是集内镜号

`Shot.order` 跨集连续（第 1 集 1–30、第 2 集 31–62 …）。造型阶段的
`shot_from/shot_to` 用的就是这一列。界面上把它截成 `#29–#37` 展示时，
用户会自然地读成"本集第 29 镜"——填进第 5 集就永远命中不到，于是
"第一套默认造型"永远生效。前端为此把输入框改成**本集镜号**并在提交前换算，
本模块继续按全剧镜号判定（存储格式不变）。

## 档位（越小越优先）

  ① 镜号命中本镜的变体（区间越窄越优先）
  ② 场景决定型服装 + 本镜就在这个归一场景（**跨集**沿用，不看集区间）
  ③ 场景对得上 + 集区间也命中
  ④ 本集的基础阶段（不限镜号、不绑场景）
  其余 = 对本镜不适用
"""
from __future__ import annotations

#: 档位常量（对外可见：诊断按它分类，前端按同一组数字渲染）
TIER_SHOT_RANGE = 0
TIER_SCENE_BOUND = 1
TIER_SCENE_AND_EP = 2
TIER_BASE = 3
TIER_NOT_APPLICABLE = 4


def rank(stage, *, episode: int, order: int, shot_canon: str = "") -> tuple[int, int]:
    """这套造型在本镜的档位 `(tier, width)`。`tier == 4` 表示对本镜不适用。

    2026-10-31 起「一镜只归一套造型」（见 `stage_coverage`）：覆盖关系由写入时保证不重叠，
    这里只回答「覆不覆盖」。场景（`location` / `scene_bound`）不再参与；`shot_canon` 参数保留只为
    调用方不用改签名。档位与宽度仍按旧口径给出，存量数据还没理顺时用来裁决。
    """
    from .stage_coverage import covers
    if not covers(stage, episode, order):
        return (TIER_NOT_APPLICABLE, 0)
    lo, hi = stage.shot_from, stage.shot_to
    if lo is not None or hi is not None:
        width = (hi - lo) if (lo is not None and hi is not None) else 10 ** 6
        return (TIER_SHOT_RANGE, width)
    return (TIER_BASE, 0)


def pick(stages, *, episode: int, order: int, shot_canon: str = "",
         usable=None):
    """在候选里挑出覆盖本镜的那套；没有则 None。

    `usable(stage) -> bool`：只在可用的里找（出片路径传「解析得到图」）。
    一镜只归一套，所以覆盖本镜的那套没图时**不会**换成别的造型，而是由调用方用卡片图兜底。
    为此这里先找覆盖者、再看它能不能用，而不是先过滤再挑。
    """
    best = None
    best_rank = None
    for st in stages:
        r = rank(st, episode=episode, order=order)
        if r[0] >= TIER_NOT_APPLICABLE:
            continue
        if best_rank is None or r < best_rank:
            best, best_rank = st, r
    if best is not None and usable is not None and not usable(best):
        return None
    return best


def tier_name(tier: int) -> str:
    return {
        TIER_SHOT_RANGE: "镜号命中",
        TIER_BASE: "整集覆盖",
        TIER_NOT_APPLICABLE: "对本镜不适用",
    }.get(tier, "未知")
