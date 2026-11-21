"""continuity.py — 镜头之间的连贯性推导（3.9）

解决用户实测到的两类穿帮，两者根子是同一件事：**连续镜头之间没有可传递的状态**。

## 一、在场角色断续（「林母只出现在一个片段里」）

拆解提示词只要求 LLM 列"本镜有戏份的角色"，坐在桌边不说话的人不会进
`characters`。实测项目「真人剧-验证片（五集）」：

    镜1  林语、陆沉、林母      ← 林母踩林语的脚、压低身子警告她
    镜2  陆沉、林语            ← 剧本里**一个字的离场描写都没有**
    镜3  陆沉、林语
    镜4  陆沉、林语
    镜5  林语、陆沉、林母      ← 又回来了
    镜6  林语、陆沉
    镜7  陆沉、林语

同样的形态在镜 8→9（餐厅包厢）、镜 19→21（林家餐厅）各复现一次。
后果是链式的：不在 `characters` → 定妆图不注入 → 提示词不提她 →
模型照着"两人对坐"画，人就没了。镜 2 实际下发的提示词就是
「@图片1 陆沉 与 @图片2 林语 对面而坐」——整幅画面里没有林母的任何位置。

**做法**：在同一场连续戏内，把先出现过的角色向后传播，直到剧本出现明确的
离场描写为止。结果写进 `Shot.present_characters`（L1.5），不碰拆解真值。

## 二、人物位置在相邻镜之间跳变

`jobs._scene_run_ctx` 早就写了「人物的座次、站位、朝向与距离延续上一镜结尾」，
但那是一句**没有事实支撑的空话**：优化器拿到的三样东西里，通用约束句不含
事实、recap 是剧本原文（剧本几乎不写走位）、anchor 是**段首**的提示词
（到第 5 镜早就失真了）。而尾帧图作为众多参考图之一，权重被定妆图稀释，
模型只当风格参考，不当位置约束。

**做法**：让每一镜产出一份"结束时刻各角色在哪"的台账（`Shot.blocking_out`），
下一镜把它当作"开场必须与之一致"的硬事实注入。台账由提示词优化那一次调用
**顺带**产出（见 prompt_opt.service 的输出要求第 4 段），不额外发起任何请求
——既不花钱，也不动任何并发数。

本模块只做纯推导与读写，不调用 LLM、不碰网络，便于单测。
"""

from __future__ import annotations

import json
import logging

logger = logging.getLogger(__name__)

#: 离场描写的判据。命中即认为该角色**从本镜结束时起**不再在场，停止向后传播。
#:
#: 只收"人离开了这个空间"的写法，不收"转身""起身"这类**还在场**的动作 ——
#: 宁可漏判（继续传播，最多多注入一张定妆图）也不可错判（一错就是人凭空消失，
#: 而那正是本模块要修的毛病）。
_EXIT_PATTERNS = (
    "走出", "离开", "离去", "走了", "出门", "夺门", "摔门",
    "转身走", "转身离", "起身离", "拂袖", "退出",
    "下车", "上车走", "驶离", "扬长而去", "头也不回地走",
    "被带走", "被拖走", "送走", "目送",
    "挂断", "挂了电话", "退出房间", "退下",
)

#: 台账里每个角色允许的字段。多余的键一律丢掉 ——
#: LLM 很爱自作主张加 "emotion" / "costume" 之类，那些各有各的真源
#: （情绪在剧本里、服装在定妆图里），混进走位台账只会与它们打架。
#:
#: 3.9.1（2026-09-19）扩字段，三个都是"跨镜必须延续的物理事实"：
#:   · `prop`      —— 谁拿着什么、用哪只手（与 pos 同构：剧本几乎不写，
#:                    只能靠台账传递；实测模型已在 posture 里自发写了 11/18 条）
#:   · `cam_side`  —— 摄影机在轴线哪一侧、朝向哪个锚点。**这是 pos 的参照系**：
#:                    没有它，"画面左侧"这种坐标在下一镜就是空的
#:   · `cam_height`—— 机位高度（平视/俯/仰/胸高…），同样跨镜要延续
_BLOCKING_FIELDS = ("pos", "posture", "facing", "prop", "cam_side", "cam_height")

#: 台账的**格式版本**。旧台账（无此标记）里的 pos 是**画面坐标**，
#: 而画面坐标的参照系（机位）没有随台账传递 —— 见 `blocking_text` 的降级说明。
#: 带此标记的台账 pos 是**场景坐标**，可以当硬事实用。
_BLOCKING_REF_SCENE = "scene"

#: `parse_blocking` 的返回值形状：`{角色: {字段: 值}}`。
#: `blocking_ref` 从任一角色上取（同一份台账里所有角色同版本）。
def blocking_ref(blocking: dict[str, dict[str, str]]) -> str:
    """取台账的格式版本标记（`"scene"` = 场景坐标；`""` = 旧格式画面坐标）。

    从任一角色条目上取：标记与角色无关，是整份台账的属性。
    """
    for f in blocking.values():
        v = (f.get("_ref") or "").strip()
        if v:
            return v
    return ""


def parse_characters(raw: str | None) -> list[str]:
    """把 `Shot.characters` / `present_characters` 解析成干净的字符串列表。

    解析失败一律当空 —— 这两列历史上都是 LLM 产出后落库的，脏数据必须
    降级为"没有推导"而不是抛异常把出片链路打断。
    """
    try:
        v = json.loads(raw or "[]")
    except (ValueError, TypeError):
        return []
    if not isinstance(v, list):
        return []
    out: list[str] = []
    for c in v:
        if isinstance(c, str) and c.strip() and c.strip() not in out:
            out.append(c.strip())
    return out


def mentions_exit(text: str, name: str) -> bool:
    """`text` 里是否写了 `name` 这个角色离场。

    判据要求**离场词与角色名同句**：整段里出现"走出"就把所有人都判离场的话，
    一个人出门会导致整桌人从下一镜起全部消失 —— 比原来的毛病还严重。

    句子切分用中英文句末标点 + 换行；剧本里的"△"是动作行标记，也当分隔符
    （一行一个动作，跨行的主语通常已经变了）。
    """
    if not text or not name:
        return False
    seps = "。！？；\n\r△!?;"
    cur = ""
    for ch in text:
        if ch in seps:
            if name in cur and any(p in cur for p in _EXIT_PATTERNS):
                return True
            cur = ""
        else:
            cur += ch
    return bool(name in cur and any(p in cur for p in _EXIT_PATTERNS))


class ShotLike:
    """`derive_present_characters` 需要的最小镜头形状（便于单测不依赖 ORM）。

    真实调用传的就是 `db.Shot`；这里只是把用到的字段写出来当文档。
    """

    id: str
    order: int
    location: str | None
    link_to_prev: str | None
    characters: str | None
    script_ref: str | None


def derive_present_characters(
    run: list, *, canon_of=None,
) -> dict[str, list[str]]:
    """对**一整段连续同场戏**推导每镜的在场角色补充集（L1.5）。

    `run` 是按 order 升序、已经确认属于同一连续段的镜头列表
    （判据由调用方给，与 `jobs._scene_run_ctx` 同源：`link_to_prev=="continuous"`
    且归一场景名相同）。`canon_of` 可选，仅用于在本函数内二次校验场景一致性。

    返回 `{shot_id: [补充进来的角色名]}` —— **只含推导出来的部分**，
    不含该镜 `characters` 里本来就有的人。没有补充的镜头不出现在结果里。

    规则：
      1. 段首镜不补（它是这场戏的起点，谁在场以拆解为准）；
      2. 某角色在段内第 k 镜出现过，则第 k+1..n 镜都补上他，
         直到某一镜的 `script_ref` 里出现**与他同句**的离场描写为止
         （含那一镜：那一镜他还在场，是在这一镜里走的，下一镜起才移除）；
      3. 已经在 `characters` 里的不重复补。

    ⚠️ 不做"跨段传播"：换了场景或标了 transition，人物位置本就该重新安排，
    这时补人反而会把上一场的人塞进新场景（比原来的毛病更难查）。
    """
    if len(run) < 2:
        return {}

    out: dict[str, list[str]] = {}
    # 累积"到目前为止仍在场"的人，按首次出现顺序
    carried: list[str] = []
    # 本镜结束后要移除的人（在本镜里离场的）
    for i, sh in enumerate(run):
        own = parse_characters(getattr(sh, "characters", None))
        if i > 0 and carried:
            extra = [c for c in carried if c not in own]
            if extra:
                out[sh.id] = extra
        # 更新累积集：本镜自己列出的人加进来
        for c in own:
            if c not in carried:
                carried.append(c)
        # 本镜里写了离场的人，从下一镜起不再传播
        ref = (getattr(sh, "script_ref", None) or "")
        if ref and carried:
            gone = [c for c in carried if mentions_exit(ref, c)]
            if gone:
                logger.info("镜 #%s 检出离场：%s",
                            getattr(sh, "order", "?"), "、".join(gone))
                carried = [c for c in carried if c not in gone]
    return out


def parse_blocking(raw: str | None) -> dict[str, dict[str, str]]:
    """解析 `Shot.blocking_out`，只保留白名单字段且值必须是非空字符串。

    脏数据一律降级为"没有台账"：宁可退回原来的通用约束，也不能把
    `{"林母": {"pos": null}}` 这种半残的东西拼进提示词——那会让模型
    看到一句「林母：位置 None」，比不写更糟。

    `_ref` 是**唯一的非白名单例外**：它是整份台账的格式版本标记
    （`"scene"` = 场景坐标 / 缺省 = 旧格式画面坐标），
    每个角色条目上复制一份，取值用 `blocking_ref()`。
    """
    try:
        v = json.loads(raw or "")
    except (ValueError, TypeError):
        return {}
    if not isinstance(v, dict):
        return {}
    out: dict[str, dict[str, str]] = {}
    for name, val in v.items():
        if not isinstance(name, str) or not name.strip():
            continue
        if not isinstance(val, dict):
            continue
        fields = {k: val[k].strip() for k in _BLOCKING_FIELDS
                  if isinstance(val.get(k), str) and val[k].strip()}
        if fields.get("pos"):     # 没有位置就等于没说，丢掉
            ref = val.get("_ref") or val.get("ref")
            if isinstance(ref, str) and ref.strip():
                fields["_ref"] = ref.strip()
            out[name.strip()] = fields
    return out


def blocking_text(blocking: dict[str, dict[str, str]]) -> str:
    """把台账渲染成给提示词优化器看的一段中文。空台账返回空串。

    ⚠️ **两种格式走两套措辞**（2026-09-19 起）：

    · 带 `_ref: "scene"` → 新格式，`pos` 是**场景坐标**，可以当硬事实用；
    · 不带标记 → 旧格式，`pos` 是**当时的画面坐标**，而机位没有随台账传递。
      直接当硬事实下发是错的（画面坐标换个机位就翻车），
      所以渲染成"请据此**推断物理位置**"的弱表述。

    为什么旧数据不直接丢弃：消费者是**下一镜**。丢弃 = 存量项目的下一镜
    立刻失去全部位置约束，**比现状更差**；降级为"推断"既保住了信息，
    又拆掉了"硬事实"那个错误口吻。
    """
    if not blocking:
        return ""
    scene_ref = blocking_ref(blocking) == _BLOCKING_REF_SCENE
    lines = []
    for name, f in blocking.items():
        bits = [f["pos"]]
        if f.get("posture"):
            bits.append(f["posture"])
        if f.get("facing"):
            bits.append(f["facing"])
        if f.get("prop"):
            bits.append(f"手持：{f['prop']}")
        lines.append(f"  · {name}：{'，'.join(bits)}")
    body = "\n".join(lines)
    cam = next((f["cam_side"] for f in blocking.values() if f.get("cam_side")), "")
    if scene_ref:
        head = "（位置以**场景陈设**为参照，与镜头机位无关）"
        tail = f"\n  （本镜机位：{cam}）" if cam else ""
        return f"{head}\n{body}{tail}"
    # 旧格式：明确标注"这是当时的取景框坐标"，并要求推断而不是照抄
    return ("（⚠️ 旧格式台账：下面是**当时的取景框坐标**，机位可能已变。"
            "请据此**推断人物的物理位置**——例如「画面左侧、餐桌北侧」"
            "= 人在餐桌北侧——按推断出的物理位置延续，"
            "**不要**照字面把「画面左侧」当成硬约束）\n"
            + body)


# ---------------------------------------------------------------------------
# 连续段切分：**全工程唯一**的一份
# ---------------------------------------------------------------------------

# ============================================================
# 连续段结构缓存（2026-10-22）
# ============================================================
#
# `_scene_run_ctx`（jobs.py）是**逐镜**调用的，它每次都 `continuous_runs(...)`
# 全量重算整个项目的连续段。1424 镜的项目单次 150 ms，拆解一集 40 镜就是 6 秒
# 纯同步 DB 开销，且全部压在事件循环上 —— 2026-10-22 10:23 那次生产卡死即此。
#
# ## 缓存的是 **id 列表**，不是 ORM 行
#
# 这是本缓存唯一的安全前提。`_one_run` 的并发设计依赖一条数据链：
#   段首镜先跑完并 commit → 段内其余镜**再**读它，拿到**刚写入的** gen_prompt。
# 若缓存 ORM 对象，其余镜会读到缓存时刻那份**空** gen_prompt，`anchor` 段整块
# 消失 —— 912 项目「同一个餐厅被写成会客室/包厢」会原样复发，且不报错、
# 只是提示词质量悄悄下降，没有任何信号能发现。
#
# 所以这里只存"谁和谁一段"这个**结构**，调用方取用时必须从当前 session
# 重新 `get` 本镜/上一镜/段首。
#
# ## 结构什么时候会变
#
# `continuous_runs` 的结论只取决于 `Shot.location` / `Shot.link_to_prev` /
# `SceneAlias` / `Asset(kind='location')`。往这四样里写东西的入口都必须调
# `invalidate_run_cache(project_id)`，否则后续 `_scene_run_ctx` 会拿旧分组。
#
# 没用 TTL 而是显式失效：结构变化是**事件驱动**的，TTL 只会让"改了没生效"
# 看起来随机，反而更难查。
_RUN_CACHE: dict[str, list[list[str]]] = {}
_RUN_CACHE_MAX_PROJECTS = 256


def invalidate_run_cache(project_id: str | None = None) -> None:
    """丢掉连续段缓存。`None` = 全丢。

    改 `Shot.location` / `Shot.link_to_prev` / `SceneAlias` / 场景资产名的
    任何入口都要调它。
    """
    if project_id is None:
        _RUN_CACHE.clear()
    else:
        _RUN_CACHE.pop(project_id, None)


def prime_run_cache(project_id: str, runs) -> None:
    """用调用方刚算出的 runs 预热缓存（接受 ORM 段列表或 id 段列表）。"""
    out: list[list[str]] = []
    for run in runs:
        out.append([getattr(x, "id", x) for x in run])
    if len(_RUN_CACHE) >= _RUN_CACHE_MAX_PROJECTS:
        _RUN_CACHE.clear()      # 无锁整表丢；丢缓存只是多算一次，不会算错
    _RUN_CACHE[project_id] = out


def cached_runs(session, project_id: str) -> list[list[str]]:
    """连续段结构（id 列表），进程内缓存。冷启动时算一次。"""
    hit = _RUN_CACHE.get(project_id)
    if hit is not None:
        return hit
    runs = [[s.id for s in run] for run in continuous_runs(session, project_id)]
    prime_run_cache(project_id, runs)
    return _RUN_CACHE[project_id]


def _same_scene_sig(session, project_id: str, a: str, b: str,
                    loc_assets: dict[str, str] | None = None) -> bool:
    """两个场景名是否指向**同一个物理空间**（连续段切分的判据内核）。

    三条判据，**满足其一即算同场景**（2026-09-19 起，见下面 `continuous_runs`）：

      ① 归一名完全相同（原有行为，保持不变）；
      ② 指向同一个 `Asset(kind='location')`（最权威：资产是按归一名建的，
         `scene_desc` 与资产图都挂在它上面）；
      ③ 去掉空格后互为包含（治"俗称 vs 全称"，如
         `破城隍庙内` ↔ `青石镇城郊破旧城隍庙荒草废墟`）。

    `loc_assets`：调用方已预取好的 `{资产名: 资产 id}`。批量判段时必须传
    （见 `_location_asset_index`）——否则每一对场景名都要查 2 次库。

    ⚠️ 判据②/③ 是**放宽**，方向是"宁可多连、不可断"。理由：断段的代价是
    `_scene_run_ctx` 的四段约束**全部不注入**（段首），站位链条从此处起断；
    多连的代价只是多注入一段约束。与 `mentions_exit` 的取向一致。

    ⚠️ 判据③ 有误连风险（"林家客厅" ⊂ "林家"），所以要求公共片段
    **至少 2 个连续汉字**且**不是通用词**（`_GENERIC_SCENE_WORDS`）。
    """
    if not a or not b:
        return False
    if a == b:
        return True                                    # ①
    if _shares_location_asset(session, project_id, a, b, loc_assets=loc_assets):
        return True                                    # ②
    return _name_contains(a, b)                        # ③


def _location_asset_index(session, project_id: str) -> dict[str, str]:
    """该项目 `{场景资产名 -> 资产 id}`，一次取全。

    2026-10-22：`_shares_location_asset` 原先每对场景名查 2 次库，1424 镜的
    项目有 238 对需要走判据②，累计 134 ms —— 是 `continuous_runs` 剩下的
    最大开销，而该函数又在逐镜路径上被调用。一次取全后降为 1 次查询。
    """
    from .db import Asset
    try:
        rows = (session.query(Asset.name, Asset.id)
                .filter(Asset.project_id == project_id,
                        Asset.kind == "location").all())
    except Exception:  # noqa: BLE001 判据是增强项，绝不因它打断出片
        logger.warning("[continuity] 预取场景资产失败，退回逐次查询", exc_info=True)
        return {}
    return {(n or "").strip(): i for n, i in rows if (n or "").strip()}


def _shares_location_asset(session, project_id: str, a: str, b: str,
                           loc_assets: dict[str, str] | None = None) -> bool:
    """判据②：两个场景名是否落在同一行场景资产上。

    `assets.name` 存的是**归一名**，所以两个名字各查一次即可。
    查不到资产不算错——返回 False 让它落到判据③。

    `loc_assets`：调用方预取的索引。传了就用内存查（不再查库）；
    没传则保持原行为逐次查询（单点调用不受影响）。
    """
    from .db import Asset
    ids = []
    for n in {a, b}:
        n = (n or "").strip()
        if not n:
            return False
        if loc_assets is not None:
            aid = loc_assets.get(n)
            if aid is None:
                return False
            ids.append(aid)
            continue
        try:
            row = (session.query(Asset)
                   .filter(Asset.project_id == project_id, Asset.kind == "location",
                           Asset.name == n).first())
        except Exception:  # noqa: BLE001 判据是增强项，绝不因它打断出片
            logger.warning("[continuity] 场景资产比对失败，退回按名字判", exc_info=True)
            return False
        if not row:
            return False
        ids.append(row.id)
    return ids[0] == ids[1]


#: 判据③ 的通用词：这些片段出现在两个场景名里**不代表是同一个房间**。
#: 表格按"这个字符串本身能不能指认一个房间"来定 —— 姓氏、物业类型、
#: 房间类型、时间/内外标记都不能。反过来 `城隍庙`、`消金窟`、`白玉盘龙柱`
#: 这类**专名**不在此表，它们出现即意味着指认。
_GENERIC_SCENE_WORDS = frozenset({
    # 姓氏/家族前缀：`林家` 出现在 `林家客厅` 里不代表另一个场景也是这个家
    "林家", "顾家", "沈家", "楚家", "陆家", "苏家", "陈家", "王家", "李家",
    "赵家", "孙家", "周家", "吴家", "郑家", "何家", "高家", "许家",
    # 物业/机构类型
    "公司", "集团", "大厦", "大楼", "酒店", "医院", "学校", "公园",
    # 房间类型
    "家里", "房间", "走廊", "客厅", "卧室", "厨房", "餐厅", "书房",
    "浴室", "阳台", "办公室", "会议室", "大堂", "院子", "门口",
    # 时间/内外标记（`normalize_location` 本应剥掉，残留时不能当判据）
    "日", "夜", "内", "外", "晨", "黄昏",
    # 道路/载具
    "街道", "马路", "车内", "车里",
})

#: 判据③ 的最小词长：短于这个长度的名字不参与包含判断。
_MIN_SHARED_TOKEN = 3


def _name_contains(a: str, b: str) -> bool:
    """判据③：一个是另一个的**整串**（允许短名末尾少一两个方位字）。

    只认精确的包含关系，**不做"共享若干字"的模糊匹配**。后者实测会误连：

        `九重天仙域后山 上古虚空禁地 天道结界边缘` 与
        `九重天凌霄仙域 白玉盘龙柱前` 共享 3 字（"九重天"）；
        `九重天凌霄仙域 太虚剑坪` 与 `九重天凌霄仙域 白玉盘龙柱前`
        共享 7 字 —— 而它们是**四个不同的地方**。

    长场景名在仙侠/古装题材里天然共享"门派名 + 大区名"这种前缀，
    按共享长度判会把一整个项目连成一段。误连会把两场戏合并、
    并让其中一场继承另一场的位置台账，**破坏面比漏连大得多**（§3 原则 4）。

    ⚠️ **已知失效**：`破城隍庙内` ↔ `青石镇城郊 破旧城隍庙 荒草废墟`
    是同一座庙的两种叫法（两份场景描述说的都是"屋顶破洞 + 残破神像 +
    中央柴火堆"），但两者**没有**整串包含关系（"破城隍庙" ≠ "破旧城隍庙"），
    且各自挂着**不同的场景资产**（`5662377c4f4c` / `af59200c257a`），
    所以判据②③都对它无效，该处仍会断段。
    治理走 `PLAN-跨镜站位一致性.md` §4-P2.3（拆解后让用户核对场景清单），
    **不在此处放宽** —— 放宽到这个程度必然误连上面那四个仙域场景。
    """
    x, y = a.replace(" ", ""), b.replace(" ", "")
    if not x or not y or x == y:
        return False
    short, long_ = (x, y) if len(x) <= len(y) else (y, x)
    if short in long_:
        return short not in _GENERIC_SCENE_WORDS
    # 末尾去掉 1..2 个字再试（"破城隍庙内" → "破城隍庙"）。
    # ⚠️ 单独用这一步**不会**救回实测那一例：`破城隍庙` 并不是
    # `破旧城隍庙` 的子串（"旧"字插在中间）。保留它是因为它对
    # `青石镇城郊 破城隍庙` ↔ `破城隍庙内` 这类真实写法有效。
    for cut in (1, 2):
        core = short[:-cut]
        if len(core) < _MIN_SHARED_TOKEN:
            break
        if core in long_ and core not in _GENERIC_SCENE_WORDS:
            return True
    return False


def continuous_runs(session, project_id: str) -> list[list]:
    """把项目的有效镜头切成若干「同场连续戏」段，按 order 升序返回。

    判据（3.9.1 起由 `_same_scene_sig` 承担，含 ①归一名相同 ②同一场景资产
    ③归一名互为包含 三条）：
      · 相邻两镜 order 相邻（都取自过滤后的有效镜头序列）
      · 后一镜 `link_to_prev == "continuous"`
      · 两镜**属于同一物理空间**（`_same_scene_sig`）

    为什么 3.9.1 要放宽场景判据：实测项目 `b630e57d3f6a`（动漫剧 / 国风3D）
    的镜 13-15 标 `青石镇城郊·破旧城隍庙、荒草废墟`、镜 16-19 标 `破城隍庙内`
    —— **同一座庙、同一个场景资产、两份描述说的都是"屋顶破洞 + 残破神像 +
    中央柴火堆"**，只因归一名字面不等就断成两段，镜 16 成了段首，
    它的站位约束整段丢失，且**镜 16 产出的零方位台账又传给镜 17**——
    伤害沿链条传染。放宽后该处连成一段（3 + 4 → 7 镜）。

    ⚠️ **不按集过滤**（这是 912 项目留下的关键教训）：该项目镜 1-4 属第 1 集、
    镜 5-6 属第 2 集，却同属场景「半岛酒店顶楼餐厅」且镜 5 的 link_to_prev
    就是 continuous。这里的"集"是长剧本的切块，一场戏跨块继续是常态；
    按集拦住等于在最需要连贯的地方断掉。

    单镜成段（长度 1）也会返回 —— 调用方各自决定要不要忽略：
    走位注入需要"上一镜"，在场推导也需要，两者都会跳过长度 1 的段；
    但保留它能让调用方看到完整切分，便于排查。
    """
    from .db import Shot
    from .scenes import canonical_map

    rows = (session.query(Shot)
            .filter(Shot.project_id == project_id,
                    Shot.disabled == 0, Shot.is_special == 0)
            .order_by(Shot.order).all())
    if not rows:
        return []
    # 2026-10-22：原先是逐镜 `canonical_of` —— 那是 N 次查库。1015 镜的项目
    # 实测 190.5 ms，占本函数总耗时（414 ms）的 81%，而本函数又在**逐镜**的
    # `_scene_run_ctx` 里被调用，拆解一集就把这段乘上镜头数。
    #
    # 换成 `canonical_map` 一次取全后 1.4 ms。等价性已实测核对：
    #   · 同一批 1015 个场景名逐字比对，两个函数结果**差异 0 处**
    #   · 优先级一致：字典表有行就用 `row.canonical`，没有则 `normalize_location`
    #   · 空名两边都返回空串
    #   · prod 库 `scene_aliases` 无同名重复行（4954 条），故 `canonical_of` 的
    #     `.first()` 与 `canonical_map` 的"后写覆盖"取到同一行
    #
    # 这里刻意保留 `canonical_of` 的 strip 语义（用 strip 后的名字查表）：
    # `canonical_map` 是按**原值**建键的，而 `canonical_of` 查的是 `raw.strip()`。
    # 当前 dev/prod 都没有含首尾空格的 `Shot.location`，但依赖"数据恰好干净"
    # 是隐患，不赌。
    canon_map = canonical_map(session, project_id, rows)

    def _canon_of_row(r) -> str:
        raw = (r.location or "").strip()
        if not raw:
            return ""
        return canon_map.get(raw) or (r.location or "").strip()

    canons = {r.id: _canon_of_row(r) for r in rows}
    # 判据② 用到的场景资产一次性取全（原先是每对场景名查 2 次库）
    loc_assets = _location_asset_index(session, project_id)

    runs: list[list] = [[rows[0]]]
    for prev, cur in zip(rows, rows[1:]):
        ca, cb = canons.get(prev.id), canons.get(cur.id)
        # 快速路径：归一名相同（绝大多数项目走这条，一次字符串比较）
        same = bool(cb) and (cb == ca or _same_scene_sig(
            session, project_id, ca or (prev.location or ""),
            cb or (cur.location or ""), loc_assets=loc_assets))
        if (cur.link_to_prev or "") == "continuous" and same:
            if cb != ca:
                logger.info("[continuity] 按场景资产/包含关系连段：#%s「%s」↔ #%s「%s」",
                            prev.order, prev.location, cur.order, cur.location)
            runs[-1].append(cur)
        else:
            runs.append([cur])
    return runs


def refresh_present_characters(session, project_id: str) -> int:
    """重算整个项目的在场推导（L1.5），写回 `Shot.present_characters`。

    返回被改动的镜头数。**幂等**：同样的输入重复跑结果一致，可以在拆解后、
    人工修正拆解后、以及出片前反复调用。

    调用方负责 commit —— 拆解那边整段都在 `_BREAKDOWN_DB_LOCK` 里一次性提交，
    这里再自己 commit 会把那个事务切开。
    """
    changed = 0
    for run in continuous_runs(session, project_id):
        derived = derive_present_characters(run)
        for sh in run:
            want = derived.get(sh.id, [])
            new = json.dumps(want, ensure_ascii=False) if want else None
            if (sh.present_characters or None) != new:
                sh.present_characters = new
                changed += 1
    if changed:
        logger.info("项目 %s 在场推导更新了 %d 个镜头", project_id, changed)
    return changed
