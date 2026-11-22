"""settings_backfill — 从已有稿子**反推**设定（世界观 / 角色卡 / 分集契约 / 伏笔）。

## 为什么需要它（2026-09-22 用户提问："这些没法主动补吗"）

「设定」面板上这四块，只有**从零让 AI 生成大纲**的草稿才会有。
实测用户 9 部草稿里 **8 部四块全空**，而其中 7 部有 49–109 集正文 ——
素材一直都在，只是从来没有哪条路径回头去读它。

现有能力的缺口：

| 区块 | 已有 | 为什么不够 |
|---|---|---|
| 世界观 | `import_script.extract_outline_with_ai` | 只在**导入那一刻**跑一次，事后没有入口 |
| 角色卡 | `POST /drafts/{id}/characters/extract` | 它写 `character_registry`，而面板与
|        |                                      | `chapter_gen` / `context_loader` 读的是 `outline.characters` |
| 契约·伏笔 | 只有 `outline_gen` 产出 | 那等于**重新生成大纲**，会盖掉用户的分集计划（破坏性） |

## 本模块的硬规矩：**只填空，绝不覆盖**

这是它与"重新生成大纲"的根本区别，也是它敢给用户一个按钮的前提：

- 逐集契约**逐个键**判断，该集已经有 `core_push` 就不碰 `core_push`；
- `title` / `synopsis` **完全不碰** —— 那是用户的内容，不是推导得出的元数据；
- 世界观 / 角色只在整块为空时才写。

所以重复点它是安全的：第二次只会去补第一次没补上的。

## 契约是"描述"不是"计划"

对已经写完正文的剧，`core_push` / `stakes` / `hook_out` 不是"打算怎么写"，
而是"这一集实际上做了什么"。反推出来的值用于**体检、续写、改编**时保持一致，
所以提示词里要求模型**据实描述**，不许发挥。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

from sqlalchemy import select

from ..db import ScriptChapter, ScriptDraft, ScriptStoryboard, session_scope
from ..models.llm import get_llm

logger = logging.getLogger(__name__)

#: 一次 LLM 调用处理多少集的契约。契约字段很啰嗦，比账本抽取(10)保守一些。
BATCH_EPISODES = 8

#: 反推世界观/角色时，从全剧**均匀采样**的字符预算。
#: ⚠️ 不是"取前 N 字"：角色往往中后段才出场，只读开头会漏人
#: （`character_extract.extract_characters` 内部按前 30000 字截断，
#:   所以这里必须先均匀采样再交给它，让活下来的那 30k 是有代表性的）。
SAMPLE_BUDGET = 120_000

#: 判定"这一集的契约算不算已经有了"所看的键。
_CONTRACT_KEYS = ("core_push", "stakes", "escalation", "hook_out",
                  "must_have", "plant", "payoff",
                  # 2026-11-04：集纲标签。加上来之后，导入的草稿点「补全设定」
                  # 也会一并反推爽点/对手动作/兑现卖点 —— 否则这些集永远缺这一层。
                  "payoff_moment", "opponent_move")

#: 两套集合，**各自维护、互不清理**（语义不同，见下）：
#:   · _SILENT —— 导入时静默反推正在跑；
#:   · _MANUAL —— 用户手动点「补全设定」的那次正在跑。
#:
#: 「忙」= 两者之一在跑，但**两条规则各管一头**：
#:   · 静默启动时看到任一个在跑 → **自己让路**（谁在跑都会补上这两块）；
#:   · 手动点击时只有 _MANUAL 有人在 → 才 409（那才是"你自己连点了两下"）；
#:   · 手动点击时只有静默在跑 → 照常跑。
#:
#: ⚠️ 别合并成一个集合：那样 `end_manual` 会把静默那次还在持有的标记一起清掉，
#:   静默任务还在跑、集合里却没人了 → 后续 spawn 会重复启动、白烧一次调用。
#:   （这正是第一版写错的地方，测试当场打出来了。）
_SILENT: set[int] = set()
_MANUAL: set[int] = set()

#: 持有后台任务引用。**必须**留一个强引用 —— asyncio 只持弱引用，
#: 任务可能在跑完前被 GC 掉（本仓已有的同款教训，见 router.py 的 _LEDGER_TASKS）。
_SILENT_TASKS: set = set()


def begin_manual(draft_id: int) -> bool:
    """手动反推的入口守卫。返回 False = 用户手动那次已在跑，调用方应回 409。"""
    if draft_id in _MANUAL:
        return False
    _MANUAL.add(draft_id)
    return True


def end_manual(draft_id: int) -> None:
    _MANUAL.discard(draft_id)


def spawn_silent_backfill(draft_id: int, provider: str | None = None) -> None:
    """导入后**静默**反推世界观 / 角色卡（不阻塞、不干扰、失败只记日志）。

    用户裁定（2026-10-08）：*"反推人物表/世界观：导入草稿时可以静默触发，
    但是不应该干扰用户其他操作。旧版的导入剧本会锁定页面跑大纲/剧本生成
    而饱受诟病。"*

    ## 三条硬约束，缺一不可
    1. **不阻塞**：`ensure_future` 后立刻返回，导入响应不等它。
       （对比 `/settings/backfill` 那个 shield 端点是同步等待的 ——
       用户手动点可以等，导入不能等。）
    2. **不干扰**：不建 AgentJob、不写 `outline["progress"]`、不置任何"运行中"
       标记 —— 这三样任何一样都会让状态栏冒出一条任务、或在草稿上显示忙碌，
       那就变成"干扰用户操作"了。失败也不弹错（导入本身已经成功，
       反推只是锦上添花，不该让用户看到导入失败）。
    3. **不打架**：写回由 `backfill_settings` 在写事务内**重新读一遍** outline
       再合并、只填空不覆盖 —— 所以这期间用户做的进度/取消标记/账本等并发
       写入不会被整棵 dict 盖掉。

    ⚠️ 只跑 world + characters，**不跑契约**：契约按集反推，61 集要 8 批 LLM
    调用，在导入路径上静默烧掉是越权（钱的事要让用户自己决定）。这两块各一次
    调用，且正是后续生成最缺的锚点。

    ⚠️ 为什么需要它（2026-10-07 事故）：导入草稿的 prompt 里人物表/世界观全空，
    模型没有锚点，一旦某章跑偏就再也拉不回来 —— prod 草稿 2421 第 5-19 集
    整段写成了另一套特工戏。实测用户 9 部草稿里 8 部这三块全空。
    """
    if not draft_id or draft_id in _SILENT or draft_id in _MANUAL:
        # 已经有人在跑（手动或静默）—— 让路，不重复烧钱。
        return

    async def _run() -> None:
        try:
            res = await backfill_settings(draft_id, provider=provider,
                                          parts=("world", "characters"))
            logger.info("silent backfill draft %s: %s", draft_id,
                        (res or {}).get("filled"))
        except Exception as e:  # noqa: BLE001
            logger.warning("silent backfill failed for draft %s: %s", draft_id, e)
        finally:
            _SILENT.discard(draft_id)

    _SILENT.add(draft_id)
    task = asyncio.ensure_future(_run())
    _SILENT_TASKS.add(task)
    task.add_done_callback(_SILENT_TASKS.discard)


def _has(ep: dict, k: str) -> bool:
    """这一集的某个契约键**算不算已经有了**。

    ⚠️ 不能简单用真值判断：`plant: []` 表示"这集确实没有伏笔"，是**结论**不是空缺。
    按真值算的话它永远是"缺"，用户每点一次「补全设定」就会把全本契约重跑一遍，
    纯属重复烧钱（2026-09-22 实测第二次点仍然跑了全部 3 集）。

    规则：列表类型只要**键存在**就算有；字符串要求非空。
    """
    if k not in ep:
        return False
    v = ep[k]
    if isinstance(v, (list, dict)):
        return True
    return bool(str(v or "").strip())


def _json_obj(raw: str) -> dict:
    """从模型输出里抠出 JSON 对象（可能裹着 ```json 或前后废话）。"""
    s = (raw or "").strip()
    s = re.sub(r"^```(?:json)?\s*", "", s)
    s = re.sub(r"\s*```$", "", s)
    try:
        return json.loads(s)
    except Exception:
        m = re.search(r"\{.*\}", s, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                return {}
        return {}


def _shots_to_text(shots: Any) -> str:
    """把一集分镜压成可读文本（没有正文时的二级素材）。"""
    if not isinstance(shots, list):
        return ""
    lines: list[str] = []
    for sh in shots:
        if not isinstance(sh, dict):
            continue
        for el in sh.get("elements") or []:
            if isinstance(el, dict):
                ch = el.get("character")
                content = el.get("content") or el.get("action") or ""
                if ch and content:
                    lines.append(f"{ch}: {content}")
                elif content:
                    lines.append(str(content))
        for k in ("action", "dialogue", "subtitle"):
            v = sh.get(k)
            if isinstance(v, str) and v.strip():
                lines.append(v.strip())
    return "\n".join(lines)


async def _episode_material(draft_id: int) -> tuple[dict[int, str], dict[int, str]]:
    """每集的素材文本 + 每集梗概。

    素材三级回退：正文 → 剧本(分镜) → 大纲梗概。
    与 `router.extract_draft_characters` 的回退阶梯保持一致，
    免得"角色能抽、契约抽不了"这种让人费解的不一致。
    """
    texts: dict[int, str] = {}
    synopses: dict[int, str] = {}
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        outline = dict((d.outline if d else None) or {})
        eps = outline.get("chapters") or outline.get("episodes") or []
        for i, ep in enumerate(eps if isinstance(eps, list) else []):
            if isinstance(ep, dict):
                o = int(ep.get("order") or i + 1)
                syn = str(ep.get("synopsis") or "").strip()
                if syn:
                    synopses[o] = syn

        chs = (await s.execute(
            select(ScriptChapter).where(ScriptChapter.draft_id == draft_id)
            .order_by(ScriptChapter.chapter_order))).scalars().all()
        for c in chs:
            t = (c.full_text or "").strip()
            if t:
                texts[int(c.chapter_order)] = t

        sbs = (await s.execute(
            select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id)
            .order_by(ScriptStoryboard.chapter_order))).scalars().all()
        for sb in sbs:
            o = int(sb.chapter_order)
            if o in texts:
                continue  # 有正文就不用剧本
            t = _shots_to_text(sb.shots_json)
            if t.strip():
                texts[o] = t

    # 三级：梗概兜底（用户的 584/623 这类只有梗概的草稿也要能补契约）
    for o, syn in synopses.items():
        texts.setdefault(o, syn)
    return texts, synopses


def _even_sample(texts: dict[int, str], budget: int) -> str:
    """跨全剧**均匀**取样，拼成一份有代表性的语料。

    每集分到的配额 = budget / 集数，至少 300 字；集数很多时也不会让开头几集
    把预算吃光（这正是"只读前 30000 字会漏掉后期出场角色"的来源）。
    """
    eps = sorted(texts)
    if not eps:
        return ""
    per = max(300, budget // max(1, len(eps)))
    parts = [f"第{o}集\n{texts[o][:per]}" for o in eps]
    return "\n\n".join(parts)[:budget]


# ---------------------------------------------------------------------------
# 世界观
# ---------------------------------------------------------------------------

_WORLD_PROMPT = """你是资深剧本分析师。下面是一部剧的内容片段（跨全剧均匀取样）。
请**据实归纳**它的世界观设定——只写稿子里真实存在的，不要发挥、不要补充没写过的设定。

{corpus}

输出严格 JSON（不要 markdown 包装）：
{{
  "era": "时代/世界背景（如'现代都市''架空古代王朝'）",
  "setting": "核心场景设定（80-150字，写清故事主要发生在什么地方、什么格局里）",
  "rules": ["这个世界成立的关键规则或前提（没有明确规则就给空数组，不要硬编）"]
}}
仅输出 JSON。"""


async def _infer_world(corpus: str, provider: str) -> dict:
    try:
        llm = get_llm("generate", temperature=0.3, provider=provider)
        resp = await llm.ainvoke(_WORLD_PROMPT.format(corpus=corpus))
        obj = _json_obj(getattr(resp, "content", "") or "")
    except Exception as ex:  # noqa: BLE001
        logger.warning("draft 世界观反推失败: %s", ex)
        return {}
    era = str(obj.get("era") or "").strip()
    setting = str(obj.get("setting") or "").strip()
    rules = [str(r).strip() for r in (obj.get("rules") or []) if str(r).strip()]
    if not (era or setting or rules):
        return {}
    return {"era": era, "setting": setting, "rules": rules}


# ---------------------------------------------------------------------------
# 分集契约 + 伏笔
# ---------------------------------------------------------------------------

_CONTRACT_PROMPT = """你是资深剧本分析师。下面是一部剧**已经写好**的若干集内容。
请为每一集**据实归纳**它的结构契约——描述这一集实际做了什么，不是建议它该怎么写。
稿子里没有的东西一律不要编；某项确实没有就给空字符串或空数组。

{episodes}

输出严格 JSON（不要 markdown 包装）：
{{
  "episodes": [
    {{
      "order": 集号,
      "core_push": "本集唯一的核心推进点（一句话，本集所有事件都服务它）",
      "stakes": "本集里失败会失去什么（具体到身份/资格/亲情/自由/性命等；禁止'丢脸''大家会失望'这类空泛说法）",
      "escalation": "本集在哪个维度实质推进了主线（第1集写'建立初始困境'；允许阶段性胜利或局部降温）",
      "hook_out": {{
        "type": "突然揭示|紧急危机|未完成动作|身份反转|两难选择|神秘线索|时间限制|承诺威胁|离奇消失|言外之意",
        "strength": "好奇|关切|迫切|生存|终极",
        "leads_to": "这个结尾直接引发下一集发生什么"
      }},
      "must_have": ["本集实际发生的关键事件（2-4条）"],
      "plant": ["本集埋下、后文才会解释或回收的伏笔（没有则空数组）"],
      "payoff": ["本集回收的、前文埋过的伏笔（没有则空数组）"],
      "payoff_moment": "本集最让观众爽的那一下（写成能被拍出来的画面或台词；本集没有爽点就给空字符串）",
      "opponent_move": "本集里对手具体做了什么（具体的动作或手段；没有对手出场就给空字符串）"
    }}
  ]
}}

要求：
- episodes 必须覆盖上面给出的每一集，order 与给出的集号完全一致。
- plant/payoff 只写**真的**是伏笔的东西；普通情节推进不算伏笔，宁可给空数组。
- 仅输出 JSON，禁止任何前后说明文字。"""


async def _infer_contracts_batch(batch: list[tuple[int, str, str]],
                                 provider: str) -> dict[int, dict]:
    """一批（默认 8 集）的契约反推。batch 元素 = (集号, 梗概, 素材文本)。"""
    blocks = []
    for order, syn, text in batch:
        head = f"## 第{order}集"
        if syn:
            head += f"\n【梗概】{syn}"
        blocks.append(f"{head}\n【内容】{text[:6000]}")
    prompt = _CONTRACT_PROMPT.format(episodes="\n\n".join(blocks))
    try:
        llm = get_llm("generate", temperature=0.3, provider=provider)
        resp = await llm.ainvoke(prompt)
        obj = _json_obj(getattr(resp, "content", "") or "")
    except Exception as ex:  # noqa: BLE001
        logger.warning("契约反推批次失败(集 %s): %s", [b[0] for b in batch], ex)
        return {}

    out: dict[int, dict] = {}
    for e in obj.get("episodes") or []:
        if not isinstance(e, dict):
            continue
        try:
            o = int(e.get("order"))
        except (TypeError, ValueError):
            continue
        rec: dict[str, Any] = {}
        for k in ("core_push", "stakes", "escalation", "payoff_moment", "opponent_move"):
            v = str(e.get(k) or "").strip()
            if v:
                rec[k] = v
        ho = e.get("hook_out")
        if isinstance(ho, dict):
            ho = {k: str(ho.get(k) or "").strip() for k in ("type", "strength", "leads_to")}
            if ho.get("type"):
                rec["hook_out"] = ho
        for k in ("must_have", "plant", "payoff"):
            v = e.get(k)
            if isinstance(v, list):
                items = [str(x).strip() for x in v if str(x).strip()]
                # ⚠️ plant/payoff 允许显式写入空数组 —— "这集没有伏笔"本身就是信息，
                # 写进去之后下次重复点按钮就不会再为它花一次模型调用。
                if items or k in ("plant", "payoff"):
                    rec[k] = items
        if rec:
            out[o] = rec
    return out


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def _missing_blocks(outline: dict) -> dict[str, Any]:
    """看哪几块是空的。返回 {world: bool, characters: bool, contracts: [集号]}"""
    world = outline.get("world") or {}
    world_empty = not (str(world.get("era") or "").strip()
                       or str(world.get("setting") or "").strip()
                       or (world.get("rules") or []))
    chars_empty = not (outline.get("characters") or [])

    eps = outline.get("chapters") or outline.get("episodes") or []
    need: list[int] = []
    for i, ep in enumerate(eps if isinstance(eps, list) else []):
        if not isinstance(ep, dict):
            continue
        o = int(ep.get("order") or i + 1)
        # ⚠️ 逐**键**判断，不是"整集有没有契约"。
        # 按整集判断的话，只要某集有一个 must_have 就会被整集跳过 ——
        # 用户 579 号草稿正是这样：50 集都有 must_have、0 集有 core_push，
        # 结果整本一个字都补不上（2026-09-22 实测发现）。
        if any(not _has(ep, k) for k in _CONTRACT_KEYS):
            need.append(o)
    return {"world": world_empty, "characters": chars_empty, "contracts": need}


#: 反推的**块名**。导入时静默触发只跑前两块 —— 见 `backfill_settings` 的 parts 形参。
#:
#: 2026-11-07：`contracts` 块已摘出默认集合。大纲改成"正文即唯一事实"后，
#: core_push/hook_out/plant/beats 这些契约字段**没有任何读侧了** —— 再花
#: LLM 调用按集反推它们，产出的东西既不进 prompt 也不上界面，纯粹烧钱。
#: 常量与实现都保留（`_infer_contracts_batch` 等），需要恢复时加回这个元组即可。
ALL_PARTS = ("world", "characters")


async def backfill_settings(
    draft_id: int,
    *,
    provider: str | None = None,
    parts: tuple[str, ...] = ALL_PARTS,
) -> dict:
    """从已有稿子反推设定，**只填空**。

    parts: 只反推哪几块。默认全跑（用户手动点「补全设定」时的行为，不改）。
      ⚠️ **导入时静默触发只传 ("world", "characters")** —— 契约是按集反推的，
      61 集要拆成 8 批 LLM 调用，在导入路径上静默跑掉是替用户烧钱。
      而世界观/角色卡各一次调用、且是后续生成最缺的锚点，值得静默补。
      用户原话（2026-10-08）：*"反推人物表/世界观：导入草稿时可以静默触发"* ——
      点名的是这两块，没有契约。

    返回 {filled: {...}, skipped: [...], scanned: N}，供接口做人话回执。
    """
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"filled": {}, "scanned": 0, "skipped": ["草稿不存在"]}
        outline = dict(d.outline or {})
        provider = provider or d.model_provider or "gemini"

    texts, synopses = await _episode_material(draft_id)
    if not texts:
        return {"filled": {}, "scanned": 0,
                "skipped": ["这部剧还没有正文、剧本或分集梗概，没有可以据此反推的内容"]}

    miss = _missing_blocks(outline)
    if "world" not in parts:
        miss["world"] = False
    if "characters" not in parts:
        miss["characters"] = False
    if "contracts" not in parts:
        miss["contracts"] = []
    corpus = _even_sample(texts, SAMPLE_BUDGET)

    # 三块并发。契约那块内部还会再按批并发。
    async def _world_task() -> dict:
        return await _infer_world(corpus, provider) if miss["world"] else {}

    async def _chars_task() -> list[dict]:
        if not miss["characters"]:
            return []
        from .character_extract import extract_characters
        return await extract_characters(corpus, provider=provider,
                                        max_chars=SAMPLE_BUDGET)

    async def _contracts_task() -> dict[int, dict]:
        need = [o for o in miss["contracts"] if o in texts]
        if not need:
            return {}
        batches: list[list[tuple[int, str, str]]] = []
        for k in range(0, len(need), BATCH_EPISODES):
            batches.append([(o, synopses.get(o, ""), texts[o])
                            for o in need[k:k + BATCH_EPISODES]])
        results = await asyncio.gather(
            *[_infer_contracts_batch(b, provider) for b in batches])
        merged: dict[int, dict] = {}
        for r in results:
            merged.update(r)
        return merged

    world, chars, contracts = await asyncio.gather(
        _world_task(), _chars_task(), _contracts_task())

    # ── 写回：**只填空**，逐个键判断 ──────────────────────────────────
    filled = {"world": False, "characters": 0, "contracts": 0}
    from sqlalchemy.orm.attributes import flag_modified
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"filled": filled, "scanned": len(texts), "skipped": ["草稿已被删除"]}
        outline = dict(d.outline or {})

        if world and _missing_blocks(outline)["world"]:
            outline["world"] = world
            filled["world"] = True

        if chars and not (outline.get("characters") or []):
            # 写 `outline.characters` —— 这是 chapter_gen 与 AI 对话上下文读的字段，
            # 也是「设定」面板读的字段。只写 registry 的话两边都看不到（老坑）。
            outline["characters"] = [
                {
                    "name": c.get("name", ""),
                    "role": c.get("stance") or "",
                    "traits": c.get("traits") or [],
                    "appearance": c.get("one_line") or "",
                    "motivation": c.get("motivation") or "",
                }
                for c in chars if c.get("name")
            ]
            filled["characters"] = len(outline["characters"])
            # 顺带把 registry/bible 也补上（续写与改编读的是这两个）
            if not (outline.get("character_registry") or {}).get("characters"):
                from .character_extract import split_registry_bible
                registry, bible = split_registry_bible(chars)
                outline["character_registry"] = registry
                outline["character_bible"] = bible

        if contracts:
            key = "chapters" if outline.get("chapters") else "episodes"
            eps = outline.get(key) or []
            for i, ep in enumerate(eps if isinstance(eps, list) else []):
                if not isinstance(ep, dict):
                    continue
                o = int(ep.get("order") or i + 1)
                rec = contracts.get(o)
                if not rec:
                    continue
                touched = False
                for k, v in rec.items():
                    if _has(ep, k):        # 已有值 → 绝不覆盖
                        continue
                    ep[k] = v
                    touched = True
                if touched:
                    filled["contracts"] += 1
            outline[key] = eps

        d.outline = outline
        flag_modified(d, "outline")
        await s.commit()

    skipped = []
    if not miss["world"]:
        skipped.append("世界观（已有，未改动）")
    if not miss["characters"]:
        skipped.append("角色卡（已有，未改动）")
    if not miss["contracts"]:
        skipped.append("分集契约（各集都已齐全，未改动）")
    return {"filled": filled, "scanned": len(texts), "skipped": skipped}
