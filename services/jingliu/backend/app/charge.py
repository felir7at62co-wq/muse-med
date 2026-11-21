"""生成扣费闸门（P1 下半，2026-10-14）。

设计见 docs/DESIGN-积分预算与飞书审批-2026-10-13.md 第五节。

## 三句话

  1. **提交前预扣**：按计价规则估一个上界，从**提交者个人池**扣掉；余额不足直接
     402，生成根本不启动。
  2. **跑完结算**：用 `usage_events` 里这个 job 的实际花费做差，多退少补。
     实际花费来自 P0 的采集（每次真实上游调用一行），所以结算是**基于实测**
     而不是再估一次。
  3. **谁点谁付**：扣的是 `usage.current().user_id` 那个人，也就是点按钮的人。

## 为什么预扣必须同步、且在 _SUBMIT_LOCK 里

`routes_v2.submit_job` 的注释早就写明：「谁在查重与建 job 中间加一行 await
（比如加个鉴权/配额查询），去重立刻失效」。扣费就是那个"配额查询"。
所以 `hold()` 是**同步 SQL**（SQLAlchemy 直发 UPDATE），不能 await。

顺序也定死：**查重 → 扣 → 建 job**。命中复用那条已经扣过了，一分都不能再扣。

## 为什么结算能做成"基于实测"

P0 已经把每次上游调用的估算金额写进 `usage_events.cost_fen`（带 job_id）。
结算时 `SUM(cost_fen) WHERE job_id=?` 就是这一单的真实花费，不必逐个 provider
回报。代价是"估算的准确度取决于 P0 的采集覆盖度"——漏采的链路会退化成
"按预扣额收"（差额为 0，等于没退），这正是我们要的保守方向。

## 未配置组织的用户怎么办：**按余额 0 处理，拦**（2026-10-15 改）

早先的规则是"没有积分账户的人不拦"，理由是上线时组织树配不齐、别把配置
疏漏变成"点不了生成"。用户的口径正相反：**没有积分就不能生成**。实测这条
口子被真的走到了：一个大组长在被拉进组织前 4 分钟提交了一单出片，零预扣
（2026-10-15 09:12）；一个从没进过组织的人提交出片也是 200。

所以现在：没进组织 / 已停用 = 余额 0，任何报价 > 0 的生成都 402，提示语
和"余额不够"分开写（前者要找组长拉人，后者要找上级要钱）。

仍然不扣的只有三种：平台/最高管理员（无限积分）、子任务（父任务已计价）、
没有登录者的后台作业。急救开关 `FW_BUDGET_ENFORCED=0` 整体关闭闸门。
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import func

from . import pricing, scene_view
from .config import get_settings
from .db import BudgetLedger, BudgetPool, UsageEvent, UserBudget, get_session

log = logging.getLogger(__name__)


class InsufficientCredit(Exception):
    """余额不足。带上有用的数字，让前端能直接显示。"""

    def __init__(self, need_fen: int, have_fen: int, who: str = "",
                 hint: str = "请向你的上级申请额度。"):
        self.need_fen = need_fen
        self.have_fen = have_fen
        super().__init__(
            f"积分不足：本次预计需要 {pricing.fen_to_yuan(need_fen)} 元，"
            f"当前可用 {pricing.fen_to_yuan(have_fen)} 元"
            + (f"（{who}）" if who else "")
            + "。" + hint)


#: 没有积分账户的人看到的提示。和"余额不够"分开说：后者找上级要钱，
#: 前者得先有人把他拉进组——找错人会白跑一趟。
NO_ACCOUNT_HINT = "你还没有积分账户（还没被拉进任何组），请联系组长把你拉进组并分配积分。"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _member_pool(uid: int) -> str:
    return f"u:{uid}"


# --------------------------------------------------------------- 报价（估价）

#: 按「用户操作」收一次文本费的任务。报价与取消结算**共用这一份**——
#: 两处各写一个元组，迟早一处加了新 kind 另一处没加，取消就又变成全额退。
TEXT_KINDS = ("breakdown_all", "reprompt", "costume_scan", "asset_candidates_llm",
              "profile_fill", "asset_dedupe_ai", "nd_breakdown")

def _area_seconds(payload: dict) -> int:
    """本次要出多少个镜头。`shot_ids` / `orders` 给了就按它数，否则按整个项目。"""
    from .db import Shot
    pid = payload.get("project_id")
    if not pid:
        return 0
    with get_session() as s:
        q = s.query(Shot).filter(Shot.project_id == pid,
                                 (Shot.disabled == 0) | (Shot.disabled.is_(None)))
        if payload.get("shot_ids"):
            q = q.filter(Shot.id.in_(list(payload["shot_ids"])))
        elif payload.get("orders"):
            q = q.filter(Shot.order.in_(list(payload["orders"])))
        return len(q.all())


def _shot_seconds(shot_ids: list[str] | None, project_id: str) -> float:
    from .db import Shot
    if not shot_ids:
        return 0.0
    with get_session() as s:
        rows = (s.query(Shot.duration_sec).filter(Shot.id.in_(shot_ids)).all())
    return float(sum(float(r[0] or 0) for r in rows))


def _video_model(payload: dict, project_id: str | None) -> tuple[str, str]:
    """(model_id, resolution)。payload 覆写 > 项目设置 > 平台默认。"""
    from .db import Project
    mid = payload.get("model_id")
    res = payload.get("resolution")
    proj = None
    if project_id:
        with get_session() as s:
            proj = s.get(Project, project_id)
    if not mid and proj is not None:
        try:
            mid = (json.loads(proj.default_profile or "{}") or {}).get("video_model")
        except (ValueError, TypeError):
            mid = None
        if not res:
            try:
                res = (json.loads(proj.default_profile or "{}") or {}).get("resolution")
            except (ValueError, TypeError):
                res = None
    return (mid or get_settings().video_model, res or "720p")


def _fill_kinds(p: dict) -> set[str]:
    from .jobs import fill_kinds
    return fill_kinds(p)


def _fill_gap_count(pid: str | None, kinds: set[str]) -> int:
    """按页补全的预扣张数（上界）。盘点用 runner 同一份 `compute_readiness`。

    角色取「缺图阶段 + 需补建默认造型的角色」——与 readiness 的 `to_generate`
    同一口径（不能用 chars_no_asset：同一个角色会在两边各数一次）。
    场景按 8 视角取上界（结算按实际出图张数退）。
    """
    if not pid:
        return 0
    from .readiness import compute_readiness
    a = (compute_readiness(pid) or {}).get("assets") or {}
    n = 0
    if "character" in kinds:
        n += len(a.get("stages_no_image") or []) + len(a.get("chars_need_stage") or [])
    if "location" in kinds:
        n += scene_view.VIEW_COUNT * len(a.get("locations_no_image") or [])
    if "prop" in kinds:
        n += len(a.get("props_no_image") or [])
    return n


def _upscale_channel() -> str:
    """当前生效的超分渠道（`mediakit` / `runninghub`）。"""
    try:
        from .config import get_settings
        return (getattr(get_settings(), "upscale_channel", "") or "mediakit").strip().lower()
    except Exception:  # noqa: BLE001 —— 读配置失败按默认渠道走，别让报价炸掉
        return "mediakit"


def _upscale_prehold(secs: float, n_items: int | None) -> tuple[int, str]:
    """高清放大的**预扣**报价。按当前渠道选口径（2026-11-09）。

    · `mediakit`（火山）：按被处理素材秒数 × 1.25 分/秒。预扣即实扣 ——
      上游就是按素材时长计费，没有"多退少补"的空间。
    · `runninghub`（SeedVR2）：按机时计费，源秒数只是估值锚点（0.12 元/秒，
      实测 2s 素材 ≈ 139s 机时 ≈ ¥0.232，向上取）。
    """
    from . import pricing
    secs = max(0.0, float(secs or 0))
    head = (f"高清放大预扣：{n_items} 个视频 / " if n_items else "高清放大预扣：")
    if _upscale_channel() == "mediakit":
        fen = pricing.mediakit_upscale_cost(secs)
        return fen, f"{head}{secs:.0f}s 素材 × 0.0125 元/秒（火山标准版）"
    fen = int(secs * pricing.UPSCALE_PREHOLD_PER_SRC_SEC)
    return fen, f"{head}{secs:.0f}s 素材 × 0.12 元/秒"


def estimate(kind: str, payload: dict) -> tuple[int, str]:
    """返回 (预计扣费分, 人类可读的说明)。估不出来返回 (0, 原因)。

    ⚠️ 估的是**上界**：宁可多预扣（结算时退），不能少扣（生成到一半余额不够）。
    """
    p = payload or {}
    pid = p.get("project_id")

    if kind == "shot_videos":
        ids = p.get("shot_ids")
        if ids:
            n = len(ids)
            secs = _shot_seconds(ids, pid or "")
        else:
            n = _area_seconds(p)
            secs = 0.0
            from .db import Shot
            with get_session() as s:
                q = s.query(func.coalesce(func.sum(Shot.duration_sec), 0.0)).filter(
                    Shot.project_id == pid,
                    (Shot.disabled == 0) | (Shot.disabled.is_(None)))
                if p.get("orders"):
                    q = q.filter(Shot.order.in_(list(p["orders"])))
                secs = float(q.scalar() or 0.0)
        if n <= 0:
            return 0, "没有镜头可出"
        model, res = _video_model(p, pid)
        if pricing.seedance_family(model):
            # Seedance：token 可精确预估（分辨率/时长/帧率都是已知量）
            tokens = pricing.seedance_tokens_estimate(res, secs or n * 5)
            fen = pricing.seedance_cost(model, res, tokens)
            return fen, f"Seedance 按 token 计：{n} 镜 / {secs:.0f}s / {res}"
        if pricing.is_wan(model):
            # 万相：按输出秒数，确定价。时长按项目上限钳不了（镜头可能被抬到 2s 下限），
            # 每镜至少按 2 秒算；没记时长时按每镜 5 秒兜底
            fen = pricing.wan_cost(res, max(secs or n * 5, n * 2))
            return fen, f"万相 wan3.0 按输出时长计：{n} 镜 / {secs:.0f}s / {res}"
        # RunningHub（海螺 H3）：生成耗时无法预估，按输出时长 × 0.2 元/秒预扣
        fen = int(n * 0 + secs * pricing.H3_PREHOLD_PER_VIDEO_SEC)
        if fen <= 0:      # 没记时长时按每镜 5 秒兜底
            fen = n * 5 * pricing.H3_PREHOLD_PER_VIDEO_SEC
        return fen, f"海螺 H3 预扣：{n} 镜 × 0.2 元/秒（结算按实际生成耗时多退少补）"

    if kind in ("asset_batch", "asset_fill", "asset_candidates",
                "asset_generate", "first_frames"):
        n = 0
        if kind == "asset_batch":
            n = len(p.get("items") or [])
        elif kind == "asset_generate":
            n = max(1, int(p.get("n") or 1))
        elif kind == "asset_fill" and p.get("only"):
            # ⚠️ **子集补全必须按子集报价**（2026-10-15）。`asset_fill` 在提交时
            #    items 还是空的（清单要 runner 跑起来才算得出来），下面那条兜底
            #    于是落到 `_area_seconds` = 项目镜头数 —— 勾 2 个资产也会被按
            #    整片预扣、余额瞬间锁死。那是误伤，不是收费。
            #    这里按"选了几件"估：角色可能补多张（场景 8 视角 / 道具 1 张），
            #    所以取一个**上界**，宁可多预扣（结算按实测退）。
            kinds = [str((it or {}).get("kind") or "") for it in (p.get("only") or [])
                     if isinstance(it, dict)]
            n = (sum(scene_view.VIEW_COUNT if k == "location" else 1 for k in kinds)
                 or len(kinds) or 1)
        elif kind == "asset_fill" and _fill_kinds(p):
            # ⚠️ **按页补全必须按页报价**（2026-10-19）。理由同上：不处理的话落到
            #    `_area_seconds` 兜底 = 按整片预扣，只补 3 个道具也会锁住大额余额。
            #    缺口用 runner 自己用的那份盘点（compute_readiness）现算，
            #    分类过滤用同一个 `fill_kinds` —— 报价与实际跑的清单同源。
            #    场景按 8 视角取上界，宁可多预扣（结算按实测退）。
            n = _fill_gap_count(pid, _fill_kinds(p))
            if n <= 0:
                return 0, "当前分类没有缺图的要素"
        else:
            n = len(p.get("items") or []) or _area_seconds(p) or 1
        fen = pricing.image_cost(n or 1)
        return fen, f"生图 {n or 1} 张 × {pricing.fen_to_yuan(pricing.IMAGE_PER_PIC)} 元"

    if kind == "upscale":
        # ⚠️ 筛法**必须**与 run_upscale 共用 `upscale_candidates`（2026-10-15）。
        #    此前两处各写一套：传 episode 时预扣按那一集算、实际却跑整片
        #    （多花的钱没人拦），传 shot_ids 时又反过来（余额被锁住）。
        #    现在连"跳过已高清"这件事也是同一个判据，报价与实际永远一致。
        from .upscale_jobs import upscale_candidates
        with get_session() as s:
            cand = upscale_candidates(s, pid, payload=p)
        secs = float(sum(float(x.duration_sec or 0) for x in cand))
        if secs <= 0:
            return 0, "没有可放大的成片"
        return _upscale_prehold(secs, None)

    if kind == "video_upscale":
        # 镜流「高清」页的独立放大（2026-10-17）。
        #
        # ⚠️ 预扣口径**跟着渠道走**（2026-11-09 接入火山后）：
        #    · runninghub（SeedVR2）：按机时计费，源秒数只是个估值锚点，
        #      真实金额来自平台回报的 taskCostTime，靠 settle 多退少补；
        #    · mediakit（火山）：按源素材时长计费，**预扣即实扣**，不用退。
        #    两条通道的单价差一个数量级，写死同一个常数会让其中一条收错。
        # 时长由提交路由用 ffprobe 量好写进 payload；量不出来的条目按 15 秒兜底。
        from .upscale_jobs import video_upscale_items
        items = video_upscale_items(p)
        if not items:
            return 0, "没有要放大的视频"
        secs = float(sum((it["duration"] or 15.0) for it in items))
        return _upscale_prehold(secs, len(items))

    if kind == "desub_apply":
        # 火山按**被处理视频的时长**计费，与画质增强同一条通道、同一种口径。
        # 单价复用 `mediakit_erase_cost`（占位值，见 pricing 的注释）——
        # 预扣比实际略高没关系（多退少补），漏扣才是事故。
        #
        # ⚠️ `get_session` 在**模块顶层**已经导入，这里绝不能再写
        # `from .db import get_session` —— 函数体内任何位置的 import 都会把
        # 该名字变成**整个函数的局部变量**，于是本函数前面所有 `with get_session()`
        # （第 60/98/112/124 行）全部 UnboundLocalError。2026-11-13 踩过，
        # verify_charge.py 当场炸在 shot_videos 那一条上。
        from .desub_jobs import desub_plan
        from .pricing import mediakit_erase_cost
        total = 0.0
        with get_session() as session:
            for row in desub_plan(session, p.get("project_id") or "",
                                  "desub_apply", p):
                # 火山整条提交、按**整条素材时长**计费 —— 不是按区间之和。
                # `win` = (clip_in, clip_dur, speed, duration_sec)；拿不到时长的
                # 按 15 秒兜底（与画质增强同口径），宁可多预扣、多退少补。
                _cin, cdur, _spd, dsec = row["win"]
                total += float(dsec or cdur or 15.0)
        if total <= 0:
            return 0, "没有要擦除的镜头"
        return mediakit_erase_cost(total), "火山字幕擦除按镜头时长预扣"

    if kind == "tts_batch":
        return pricing.tts_cost(_area_seconds(p) or 1), "配音按段计价"

    if kind == "first_frame_pipeline":
        return pricing.image_cost(_area_seconds(p) or 1), "首帧链路：先出图"

    if kind in TEXT_KINDS:
        # 文本：按**用户操作**收一次（不是按底层调用；一次拆解底层约 670 次）
        return pricing.LLM_PER_OPERATION, "文本处理按次计费"

    if kind in ("desub_scan", "auto_subtitles"):
        return 0, "本任务不产生费用"

    if kind == "nd_produce":
        # 解说剧·角色开口：出片按 Seedance token 预估；自动重出那部分按实际用量补扣
        from .nd.pipeline import estimate as _nd_est
        return _nd_est(p)

    if kind == "one_click_film":
        fen = pricing.LLM_PER_OPERATION
        # 子任务在本任务的 runner 里直接跑、用量记在本任务名下，所以出片与生图
        # 由本任务结算时按实际花费补扣，不在子任务里另行结算（子任务 `_billing=child`）。
        return fen, "一键成片：先收文本操作费，出片与生图在本任务结算时按实际花费补扣"

    # 未登记的 kind：**不静默放过**，记一条日志便于发现漏配
    log.warning("[charge] kind=%s 没有计价规则，按 0 处理", kind)
    return 0, f"未登记计价的类型：{kind}"


# --------------------------------------------------------------- 预扣与结算

def _budget_on() -> bool:
    return bool(getattr(get_settings(), "budget_enforced", True))


def should_charge(kind: str, payload: dict) -> tuple[bool, str]:
    """这个任务该不该扣、从谁的池扣。"""
    from . import usage
    p = payload or {}
    if p.get("_billing") == "child":
        return False, "子任务：已由父任务统一计价"
    if not _budget_on():
        return False, "未启用积分闸门"
    uid = usage.current().user_id
    if not uid:
        return False, "没有登录者信息"
    with get_session() as s:
        u = s.get(UserBudget, uid)
    # ⚠️ 管理员判定必须在"有没有账户"**之前**：平台管理员可能从没被登记进组织，
    #    先判账户的话他会被当成"没账户"拦下。
    if _unlimited(u):
        return False, "管理员：无限积分"
    # 没账户 / 已停用：**照样要扣**（余额按 0 算，hold 会抛 402）。
    # 这里返回 True 而不是 False —— 返回 False 就是放行，正是 10-15 那个漏洞。
    return True, ""


def _unlimited(u: UserBudget | None) -> bool:
    """管理员账号无限积分（用户裁定，2026-10-14）：最高管理员与平台管理员不扣。

    用量照样被 P0 采集进 `usage_events`，报表里看得到他花了多少——
    只是不从任何池里扣、也就不会被 402 拦住。
    """
    from . import access
    from .budget import is_root_role
    if access.is_admin():
        return True
    return bool(u is not None and u.active and is_root_role(u.org_role))


def _require_account(uid: int, amount_fen: int) -> None:
    """没有积分账户、或账户已停用 → 直接 402，提示找组长拉人进组。

    不并进 `_take` 的"余额不够"：两种情况用户该找的人不一样。
    """
    with get_session() as s:
        u = s.get(UserBudget, uid)
    if u is None:
        raise InsufficientCredit(amount_fen, 0, hint=NO_ACCOUNT_HINT)
    if not u.active:
        raise InsufficientCredit(amount_fen, 0, hint="你的积分账户已停用，请联系组长。")


def _take(s, pool_id: str, amount_fen: int) -> bool:
    """原子扣减（带条件的 UPDATE），余额不够返回 False、一分不动。

    ⚠️ 以前是"读余额 → 判断 → 写回 `have - amount`"。在 `_SUBMIT_LOCK` 里
    提交与提交之间是串行的，但**下拨不在那把锁里**：组长提交生成的同时给组员
    下拨，两边各读到同一个旧余额，后写的那个把先写的覆盖掉——钱凭空多出来。
    """
    n = (s.query(BudgetPool)
         .filter(BudgetPool.pool_id == pool_id, BudgetPool.balance_fen >= amount_fen)
         .update({BudgetPool.balance_fen: BudgetPool.balance_fen - amount_fen,
                  BudgetPool.updated_at: _now()}, synchronize_session=False))
    return n == 1


def _have(s, pool_id: str) -> int:
    p = s.get(BudgetPool, pool_id)
    return int(p.balance_fen or 0) if p else 0


def hold(kind: str, payload: dict, job_id: str, *,
         amount_fen: int | None = None, note: str = "") -> int:
    """预扣。**同步**执行——调用方必须持 `_SUBMIT_LOCK`（见模块文档）。

    返回实际扣掉的分数。余额不足抛 `InsufficientCredit`。
    扣不动时**一行都不写**（余额与流水在同一事务里）。
    """
    from . import usage
    uid = usage.current().user_id
    if not uid:
        return 0
    if amount_fen is None:
        amount_fen, note = estimate(kind, payload)
    if amount_fen <= 0:
        return 0
    # ⚠️ 这里必须再过一次 should_charge：子任务（`_billing=child`）与未登记用户
    # 都要放行。只在 submit_job 里判一次是不够的——`hold` 是个公开函数，
    # 第一个直接调它的地方就会把子任务扣第二遍（一键成片就是这么双扣的）。
    allowed, why = should_charge(kind, payload)
    if not allowed:
        log.debug("[charge] hold 放行 job=%s kind=%s：%s", job_id, kind, why)
        return 0
    pool_id = _member_pool(uid)
    _require_account(uid, amount_fen)
    with get_session() as s:
        if not _take(s, pool_id, amount_fen):
            raise InsufficientCredit(amount_fen, _have(s, pool_id))
        s.add(BudgetLedger(id=uuid.uuid4().hex[:16], ts=_now(), pool_id=pool_id,
                           user_id=uid, entry="hold", amount=-amount_fen,
                           job_id=job_id, note=(note or f"{kind} 预扣")[:255]))
        s.commit()
    return amount_fen


def settle(job_id: str, *, ok: bool = True, reason: str = "",
           cancelled: bool = False) -> dict:
    """任务结束结算：多退少补。**幂等**（重复调用只退一次）。

    实际花费 = `usage_events` 里这个 job 的 `cost_fen` 之和（P0 采集）。

    | 情形 | 处理 |
    |---|---|
    | 成功有实测 | 退 `预扣 − 实际`；实际 > 预扣时**补扣差额，余额可为负**（用户裁定 2026-10-17） |
    | 全部失败 | **全额退**（上游没出货不该收钱） |
    | **取消·文本类** | **收满**预扣（用户裁定 2026-10-16，见下） |
    | **取消·其他** | 已结算的实测 **+** 在途任务的估值（RH 按等待时长、方舟按 token 估） |
    | 无实测数据 | 不退（保守：按预扣额收） |

    ## 取消不能只看 `SUM(cost_fen)`（2026-10-16 更正）

    10-15 的第一版取消结算拿 `SUM(cost_fen)` 当"已经花掉的钱"。但这个量会被
    两件**不同的事**压成 0：「一个请求都没派发」与「派发了、但金额没落在用量行上」。
    后者有三种，都会被判成"没花钱"而全额退款，而渠道那边早就扣过我们了：

      · **文本**：单次调用恒记 0 分（按操作在提交时收，见 pricing 模块文档）。
        dev 实测 372 行 llm 用量、合计 0 分。中转站按 token 扣、没有取消概念。
        → 用户裁定：**取消也收满**。
      · **RunningHub**：按机时计费，取消只是"停止继续烧"。已派发、未出结论的任务
        账上原本**一行都没有**。→ 用户裁定：**按派发至今的等待时长收**。
        派发行见 `usage.record_dispatch`；通道在轮询里感知取消时已就地结算，
        这里兜的是"通道没来得及结算"的残行（如进程中途退出）。
      · **方舟 Seedance**：只有 `queued` 能取消，`running` 会跑到出片并计费。
        在途残行按 token 公式估（分辨率 × 时长，与预扣同一个公式）。

    「RH 失败不收」（用户裁定 2026-10-16）在通道侧兑现：失败出口显式把派发行
    结算成 0 分，所以它们不会出现在这里的"在途残行"里。

    ## 取消为什么要单独一档（2026-10-15）

    用户的口径：「任务触发时往往已经发起了真实生成，取消后很可能也要实际扣费，
    这部分不能漏」。

    此前取消**完全不结算**，于是预扣（按上界估的）被一分不退地收下 —— 用户取消
    得越早，被多收得越多：一单预估 20 元、刚派发 1 个镜头就取消，也收满 20 元。
    这不是"防止白送钱"，是**多收**。

    现在按实测收：`实际 = SUM(usage_events.cost_fen)`，退 `预扣 − 实际`。
    取消发生在派发之前时实测为 0，预扣全额退还 —— 这是对的：一个上游请求都没
    发出，本来就不该收钱（各 runner 的取消检查点都在**发起上游调用之前**，
    见 jobs.py::is_cancelled 的用法）。

    ⚠️ 与成功路径的一处刻意差别：这里**不做**"无实测数据就按预扣额收"的兜底。
    那条兜底是为"采集漏了一整条链路"设计的；而在取消这条路上，实测为 0 更可能
    是**真的没跑**，套用兜底就等于按上界收全款 —— 正是要修的那个多收。
    代价是：若某次取消时采集整条失灵，会少收。考虑到 P0 的采集写在每个上游
    调用之后、同事务落库（见 usage 模块），这个风险低于"每次都多收"。
    
    幂等靠"查这笔 job 有没有**结算标记**流水"，不靠调用方自觉——终态有三处绕行。

    ⚠️ 结算标记**无论退不退款都要写**（`entry="settle"`，金额可以为 0）。
    早期版本只在 `refund > 0` 时写 refund 行，于是"没采到用量的成功任务"
    第二次被 settle 时又会走一遍，把预扣全额退回去 —— 而
    `_run_job_guarded` 的 finally 本来就会调一次，任何一处再调一次就是白送钱。
    实测复现过：余额 8000 → 10000，用户凭空多出 20 元。
    """
    if not job_id:
        return {"skipped": "no job_id"}
    with get_session() as s:
        held = (s.query(func.coalesce(func.sum(BudgetLedger.amount), 0))
                .filter(BudgetLedger.job_id == job_id,
                        BudgetLedger.entry == "hold").scalar() or 0)
        held = -int(held)                       # hold 记的是负数
        if held <= 0:
            return {"skipped": "没有预扣记录"}
        # 结算标记：settle 是本版的写法，refund 兼容早期版本已写下的行
        already = (s.query(BudgetLedger)
                   .filter(BudgetLedger.job_id == job_id,
                           BudgetLedger.entry.in_(("settle", "refund"))).first())
        if already is not None:
            return {"skipped": "已结算过"}
        row = (s.query(BudgetLedger)
               .filter(BudgetLedger.job_id == job_id,
                       BudgetLedger.entry == "hold").first())
        pool_id, uid = row.pool_id, row.user_id
        if cancelled:
            from .db import Job
            _j = s.get(Job, job_id)
            kind = (_j.kind if _j else "") or ""
            if kind in TEXT_KINDS:
                # 文本取消收满（用户裁定 2026-10-16）：渠道按 token 实扣、没有
                # 取消概念，而用量行恒为 0 分 —— 看实测只会得出"全退"。
                actual = held
                why = (f"用户取消：文本处理按次计费，取消照收 "
                       f"{pricing.fen_to_yuan(held)} 元")
            else:
                settled = int(s.query(func.coalesce(func.sum(UsageEvent.cost_fen), 0))
                              .filter(UsageEvent.job_id == job_id).scalar() or 0)
                pending, n_pending = _inflight_fen(s, job_id)
                actual = settled + pending
                if actual <= 0:
                    why = "用户取消：没有产生实际花费，预扣全额退还"
                else:
                    why = (f"用户取消：已派发的部分照收，"
                           f"实际 {pricing.fen_to_yuan(actual)} 元"
                           + (f"（含 {n_pending} 个在途任务估值）" if n_pending else "")
                           + f"（预扣 {pricing.fen_to_yuan(held)} 元）")
        elif not ok:
            actual = 0
            why = f"任务失败全额返还（{reason}）" if reason else "任务失败全额返还"
        else:
            actual = int(s.query(func.coalesce(func.sum(UsageEvent.cost_fen), 0))
                         .filter(UsageEvent.job_id == job_id).scalar() or 0)
            if actual <= 0:
                # 没采到用量：**按预扣额收**（保守方向，不会白送钱）。
                # 把 actual 抬到 held 而不是提前 return —— 提前 return 就绕过了
                # 下面那行结算标记，第二次调用又会走一遍。
                actual = held
                why = "无实测用量，按预扣额收取"
            else:
                why = f"结算：预扣 {pricing.fen_to_yuan(held)} 元，"
                why += f"实际 {pricing.fen_to_yuan(actual)} 元"
        # 差额**双向**结算（用户裁定 2026-10-17）：
        #   · 实际 < 预扣 → 退差额（delta > 0）
        #   · 实际 > 预扣 → **补扣**差额（delta < 0），余额不够**允许扣成负数**
        # 此前只退不补：RH 机时远超估算时，超出的部分平台已经付给 RunningHub，
        # 用户却一分没出（实测例：预扣 12 分、实际 600 分、实扣 12 分）。
        #
        # 为什么允许负数而不是"扣到 0 为止"：钱已经花出去了，扣到 0 就是把差额
        # 静默免掉，等于没修。负余额的后果是自然的——`_take` 要求余额 ≥ 预扣额，
        # 负余额的人提交不了新任务，直到上级下拨补平。
        #
        # ⚠️ 补扣**不能**走 `_take`：那是带"余额够"条件的 UPDATE，余额不够时一分不动，
        #    补扣会静默失败。这里必须无条件加减。
        delta = held - actual
        refund = max(0, delta)
        extra = max(0, -delta)
        if extra > 0:
            log.info("[charge] job %s 实际 %d 分 > 预扣 %d 分，补扣 %d 分",
                     job_id, actual, held, extra)
            why += f"；超出预扣，补扣 {pricing.fen_to_yuan(extra)} 元"
        if delta != 0:
            p = s.get(BudgetPool, pool_id)
            if p is None:
                p = BudgetPool(pool_id=pool_id, created_at=_now())
                s.add(p)
            p.balance_fen = int(p.balance_fen or 0) + delta
            p.updated_at = _now()
        # 标记与退款/补扣**同一行**（amount 带符号：正=退、负=补扣），差额为 0 时也写
        # —— 这一行就是"已结算"的唯一凭证。budget.ledger_summary 按 `used -= amount`
        # 汇总，负的补扣正好让"已花"变大，不需要新的 entry 类型。
        s.add(BudgetLedger(id=uuid.uuid4().hex[:16], ts=_now(), pool_id=pool_id,
                           user_id=uid, entry="settle", amount=delta,
                           job_id=job_id, note=why[:255]))
        s.commit()
        return {"held_fen": held, "actual_fen": actual, "refund_fen": refund,
                "extra_fen": extra, "reason": why}


def _inflight_fen(s, job_id: str) -> tuple[int, int]:
    """取消结算时仍处于「已派发、未结算」的上游任务估值。返回 (分, 条数)。

    正常情况下这里应为空：通道在轮询里感知到取消就会就地结算（RH 按等待时长、
    方舟排队中真取消记 0、开跑了守到出片记实测）。走到这里的是残行——
    进程中途退出、或通道还没轮到下一次轮询。

      · RunningHub → 按派发至今的等待时长（与通道侧同一口径）
      · 方舟       → 按官方 token 公式估（分辨率 × 时长），与预扣同一个公式
    """
    from . import usage
    now = datetime.now(timezone.utc)
    fen = 0
    rows = usage.unsettled_dispatches(s, job_id)
    for r in rows:
        if r["channel"] == "runninghub":
            try:
                waited = (now - datetime.fromisoformat(r["ts"])).total_seconds()
            except (TypeError, ValueError):
                waited = 0.0
            fen += pricing.runninghub_cost(max(0.0, waited))
        elif r["channel"] == "mediakit":
            # 火山按**被处理素材时长**计费，不是机时：取消时用派发行上记的
            # media_seconds（提交时 ffprobe 量好写进去的），与实扣同一口径。
            # ⚠️ 没有这一支的话，mediakit 的在途任务在这里估值为 0 ——
            # 用户取消后一分不收，而上游可能已经跑完并计费（2026-11-09）。
            fen += pricing.mediakit_upscale_cost(float(r["media_seconds"] or 0))
        elif pricing.seedance_family(r["model_id"] or ""):
            tok = pricing.seedance_tokens_estimate(r["resolution"],
                                                   float(r["media_seconds"] or 0))
            fen += pricing.seedance_cost(r["model_id"], r["resolution"], tok)
        elif pricing.is_wan(r["model_id"] or ""):
            # 万相：开跑了撤不掉、会照常出片收费 → 按请求时长估（与预扣同一个公式）
            fen += pricing.wan_cost(r["resolution"], float(r["media_seconds"] or 0))
    return fen, len(rows)


def charge_now(kind: str, amount_fen: int, *, desc: str = "",
               project_id: str | None = None) -> int:
    """**同步接口**用：按固定/估算额即时扣一笔，不参与结算。

    用于不走 `POST /v2/jobs` 的 11 条同步旁路（生图、单镜直出、各种文本操作）。
    它们没有 job 行，所以没有"事后按实测结算"这一步；估得准不准直接决定收多少，
    因此这里的估价必须用**确定值**（生图=张数×单价、文本=按操作一次），
    不要用需要事后校正的预扣公式。
    """
    from . import usage
    if not _budget_on() or amount_fen <= 0:
        return 0
    uid = usage.current().user_id
    if not uid:
        return 0
    with get_session() as s:
        u = s.get(UserBudget, uid)
    if _unlimited(u):
        return 0
    # 没账户 / 已停用不再放行（同 should_charge 的说明，2026-10-15）
    _require_account(uid, amount_fen)
    pool_id = _member_pool(uid)
    with get_session() as s:
        if not _take(s, pool_id, amount_fen):
            raise InsufficientCredit(amount_fen, _have(s, pool_id))
        s.add(BudgetLedger(id=uuid.uuid4().hex[:16], ts=_now(), pool_id=pool_id,
                           user_id=uid, entry="spend", amount=-amount_fen,
                           note=(desc or kind)[:255]))
        s.commit()
    return amount_fen


def charge_sync(kind: str, payload: dict | None = None, *,
                desc: str = "", project_id: str | None = None) -> int:
    """同步旁路的**唯一入口**：按 `estimate()` 报价并即时扣掉。

    11 条同步接口全部调它（而不是各自 `charge_now(..., 硬编码金额)`）——
    报价规则集中在一处，日后调价只要改 `estimate()`，不必回每个路由去改数字。
    报价为 0 或用户未登记进组织时直接返回，不抛。
    """
    fen, note = estimate(kind, payload or {})
    if fen <= 0:
        return 0
    return charge_now(kind, fen, desc=desc or note, project_id=project_id)


def my_available_fen(uid: int | None = None) -> int:
    from . import usage
    uid = uid or usage.current().user_id
    if not uid:
        return 0
    with get_session() as s:
        p = s.get(BudgetPool, _member_pool(uid))
        return int(p.balance_fen or 0) if p else 0
