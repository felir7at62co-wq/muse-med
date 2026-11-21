"""被用户删除的资产（墓碑）的**统一闸门**（用户 2026-09-09 需求 4）。

## 为什么删除必须是软的

用户的要求是「删掉的资产不该再在后面的生成过程中可见、被调用」。
`DELETE` 掉那一行做不到这件事——有四条路径会让它原地复活或继续花钱：

| # | 位置 | 它做了什么 |
|---|---|---|
| ① | `routes_v2` 拆解完成后的资产增量合并 | 剧本里还有这个角色 → 补一行 |
| ② | `scenes.ensure_location_asset` | 镜头还挂着这个场景名 → 补一行 |
| ③ | 资产 upsert（任何写入路径） | 按 name 找不到就新建 |
| ④ | `readiness.locations_no_image` | 从 **`Shot.location`** 算缺口、**根本不看资产表** → 真删之后依然报"缺图"，用户点一次「补齐」就又花钱把它画回来 |

前三条是"建回来"，第四条更糟：它不建行，但会**直接下单生图**。
所以判据不能是"资产表里有没有这一行"，必须是"用户有没有说过不要它"——
这就是墓碑 `Asset.deleted_at` 的作用。

## 语义边界（用户决策：「只断资产链，不动剧本」）

| | |
|---|---|
| **断掉** | 不再注入参考图、不计入缺图缺口、不被自动流程重建、资产页不显示、不再为它跑场景描述/形象档案 |
| **不动** | 镜头里该角色/场景**照旧存在**，剧本一个字不改，镜头不停用 |
| **保留** | 已生成的图与磁盘文件全在（`media` 的 GC 引用扫描**故意**不过滤墓碑），可 restore |

最后一条值得强调：`media._referenced_names` 扫的是"哪些文件还被引用"，
它必须**连墓碑一起扫**。过滤掉的话，用户删一个资产，下一次媒体清理就会把
那张图从磁盘上抹掉，restore 回来是一条指向 404 的记录——软删就白软了。

## 为什么不用 `Asset.disabled INTEGER`

`shots.disabled` 那个先例是"停用但保留"的开关，语义是用户随时来回切的。
这里要的是"删除"，时间戳能回答"什么时候删的"（列表里给用户看），
布尔值不能；而恢复同样只是把它置空，不损失任何能力。
"""
from __future__ import annotations

from .db import Asset


def alive(q):
    """给一个 `session.query(Asset)` 挂上"排除墓碑"的过滤。

    用法：`alive(session.query(Asset).filter(...))`。
    墓碑列是后加的，老库里全是 NULL，所以 `is_(None)` 对老数据天然为真。
    """
    return q.filter(Asset.deleted_at.is_(None))


def deleted_names(session, project_id: str, kind: str | None = None) -> set[str]:
    """该项目被用户删掉的资产名集合。

    给那些**不查资产表**的地方用——典型是 `readiness.locations_no_image`：
    它从 `Shot.location` 算缺口，只能拿这个集合去减。

    ⚠️ **同名还有在用行时不算"删过"**（2026-10-16 补，合并功能逼出来的）。

    这个名字集合是**按行收的**，调用方拿它去减一个**按名字**算出来的清单
    （镜头里的角色名、`Shot.location` 算出的场景名）。只要库里存在
    "一行墓碑 + 一行在用、两行同名"，那些调用方就会把**在用的那一行也当删过**
    而从注入里剔除 —— 角色突然不出参考图，且没有任何报错。

    这个状态原本不需要处理，因为此前的两条收敛路径（`scenes.reconcile_*` /
    `char_alias.apply_character_aliases`）都是 `session.delete` 真删，
    并完就只剩一行。改成软删（合并功能，用户裁定 2026-10-16）之后它是可达的：
    合并把被并的行打成墓碑，只要那行的名字与被留行相同，就构成这个状态。

    在**这一步**收口而不是要求每个"合并调用方"记得别改名字：收口在这里，
    以后任何路径造出同名声都自动安全；靠调用方自觉，迟早会漏一处。
    """
    q = (session.query(Asset.name)
         .filter(Asset.project_id == project_id, Asset.deleted_at.isnot(None)))
    if kind:
        q = q.filter(Asset.kind == kind)
    dead = {(n or "").strip() for (n,) in q.all() if (n or "").strip()}
    if not dead:
        return dead
    # 同名还在用的，不算删过
    alive_q = (session.query(Asset.name)
               .filter(Asset.project_id == project_id,
                       Asset.deleted_at.is_(None), Asset.name.in_(dead)))
    if kind:
        alive_q = alive_q.filter(Asset.kind == kind)
    alive = {(n or "").strip() for (n,) in alive_q.all() if (n or "").strip()}
    return dead - alive



def is_deleted(session, project_id: str, kind: str, name: str) -> bool:
    """这个名字的资产是不是被用户删掉了。"""
    n = (name or "").strip()
    if not n:
        return False
    row = (session.query(Asset.id)
           .filter(Asset.project_id == project_id, Asset.kind == kind,
                   Asset.name == n, Asset.deleted_at.isnot(None))
           .first())
    return row is not None
