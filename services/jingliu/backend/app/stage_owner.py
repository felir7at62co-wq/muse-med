"""造型归属台账（P1a）——「这一格该记在哪套造型名下」的唯一读写点。

## 为什么需要它

后端按**角色名**分段（`routes_v2::_present_orders_map`），前端按**造型 stageId**
分段（`AssetTrack.rows`）。两套键之间没有任何权威，靠前端自己翻译 —— 这就是
「提示注入成功、轨道上却看不到」的共同根因（`docs/PLAN-第二轮收敛-键对齐与守卫.md` 根因 A）。

翻译的**结果**（哪一格归哪套造型）一直只活在**前端内存 + localStorage** 里。
前端能算出来是因为它手里有"是谁写下的"（`AssetOverrideOp.stageId`），
而这个信息**从来没有落过库**：`Shot.ref_overrides` 只存角色名数组。

于是服务端**永远无法**回答"#5 是常服还是夜行衣"，只能每处各自猜（现在前端 5 个
文件在猜）。本模块把归属落库，让服务端也能投影同一件事。

## 存储形态

`ref_overrides` 里新增**并列**的一键（不与 `add`/`remove` 混）：

    {"add":["林昭"], "by":{"<shot_id>":"<stage_id>"}, "remove":[...]}

- 用 shot_id 而不是 order：`RefOverridesIn` 的入参本来就是 shot_id，而 order
  会因为删镜/重排而整体位移（`jobs.py:2865` 那一类的重排）。
- **并列键**而不是把 `add` 改成对象数组：`add` 的读者有 4 处（`db.effective_characters`、
  `db.effective_locations`、`scenes.py`、`routes_v2._present_orders_map`），
  改元素类型要同时改 4 处，且**旧客户端已经在写字符串数组**。并列键是纯增量：
  老数据没有 `by` → 归属为空 → 一律落到「未设阶段」段，与今天的表现一致。
- **只对 add 盖归属**。`remove` 是"不要这一格"，没有"记在哪套造型名下"这回事。

## 语义：归属必须跟着人工痕迹的存亡

`by[shot_id]` 只在"这个角色在这个镜头上确实有一条**人工加进来**的注入"时才有意义。
所以撤销加入（`remove`）、重置（`reset`）都必须**同时删掉 `by[shot_id]`** ——
否则用户撤销一次注入，格子回到拆解真值，却还挂着一枚造型章，虚拟段就再也不出现，
用户看到"我撤了它还在"。清理点集中在 `apply_attribution()`，不许各调用点自己 pop。
"""
from __future__ import annotations

import json
from typing import Any, Iterable

#: `ref_overrides` 里存归属的那个键名。改动它 = 迁移存量数据，别无他处引用字面量。
BY_KEY = "by"


def _load(raw: str | None) -> dict[str, Any]:
    """把 `Shot.ref_overrides` 解析成 dict。坏 JSON 一律当空 —— 与全仓既有口径一致。

    不在这里修数据：读到坏 JSON 时静默丢归属，比在列表渲染路径上突然 500 好。
    """
    if not raw:
        return {}
    try:
        ov = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    return ov if isinstance(ov, dict) else {}


def attribution_of(shot) -> dict[str, str]:
    """某一镜的 **order → stage_id**。未盖章的镜头不在返回里。

    键是 order 而不是 shot_id：`StageOut` 的其余字段（`present_orders` 等）都是
    order 口径，前端拿到的也全是 order。在服务端转这一次，省得每个读者各自
    拿着按 shot_id 索引的表去对。调用方得自己知道这一镜的 order（它本来就在
    遍历 `Shot`）。
    """
    ov = _load(getattr(shot, "ref_overrides", None))
    raw = ov.get(BY_KEY)
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for sid, stage_id in raw.items():
        if isinstance(sid, str) and isinstance(stage_id, str) and stage_id:
            out[sid] = stage_id
    return out


def stage_id_for_order(shot, order: int) -> str | None:
    """本镜的 order 归哪套造型。未盖章 → None（= 落到「未设阶段」段）。"""
    ov = _load(getattr(shot, "ref_overrides", None))
    raw = ov.get(BY_KEY)
    if not isinstance(raw, dict):
        return None
    sid = getattr(shot, "id", None)
    if not isinstance(sid, str):
        return None
    got = raw.get(sid)
    return got if isinstance(got, str) and got else None


def apply_attribution(ov: dict[str, Any], shot_id: str, char: str,
                      add: list[str], remove: list[str],
                      stage_id: str | None) -> None:
    """就地维护 `ov` 里的归属键。**唯一**允许写 `by` 的地方。

    规则（与 `patch_ref_overrides` 的对消逻辑一一对应）：

    | 情形 | `by[shot_id]` |
    |---|---|
    | `char` 在 add 里，且带 stage_id | 记成 stage_id |
    | `char` 在 add 里，但**没带** stage_id | 删除 —— 「谁都没声明过」是合法答案，不是"保留上一次" |
    | `char` 不在 add 里（撤销加入 / 只是 remove） | 删除 |
    | `by` 清空 | 整个键删掉，别在库里留 `{"by":{}}` |

    第三条是最容易漏的：撤销一次"拖进公共空地"的注入后，格子回到拆解真值，
    可 `by` 里那枚章还在 —— 于是它继续占着归属，虚拟段不出，用户看到"我撤了它
    还在"。这与 `add`/`remove` 必须同生共死。
    """
    raw = ov.get(BY_KEY)
    by: dict[str, Any] = dict(raw) if isinstance(raw, dict) else {}
    if char in add and stage_id:
        by[shot_id] = stage_id
    else:
        by.pop(shot_id, None)
    if by:
        ov[BY_KEY] = by
    else:
        ov.pop(BY_KEY, None)


def live_attribution(shots: Iterable, order_of_id: dict[str, int]) -> dict[int, str]:
    """一批镜头 → `{order: stage_id}`，**只保留仍被人工加着的那些格**。

    过滤是必要的：`by` 是随 `ref_overrides` 一起存的，而 `ref_overrides` 可能被
    别处**整份**重写（`routes_v2` 切开镜头时整份复制、`asset_rename` 改名、
    重拆时被清空）。那些路径不认识 `by`，于是可能留下一枚指向"已经不在 add 里"
    的章。投影层读的是"当前真实状态"，不能读历史垃圾。

    `order_of_id` 由调用方从同一批 Shot 构造 —— 传进来而不是在这里再查一次库：
    调用点已经在遍历 `Shot` 了（`_present_orders_map` 的循环），再查一遍是同一个
    表扫两次，而这个函数在每个 `list_stages` 请求里都会跑。
    """
    out: dict[int, str] = {}
    for sh in shots:
        sid = getattr(sh, "id", None)
        order = order_of_id.get(sid) if isinstance(sid, str) else None
        if order is None:
            continue
        stage_id = stage_id_for_order(sh, order)
        if stage_id:
            out[order] = stage_id
    return out
