"""资产/造型的**生图提示词预览**（镜流 ShotFlow 用）。

## 解决什么

框架构建的提示词一直是"用完即弃"的：`run_asset_fill` / `run_one_click_film`
在任务里现拼，直接喂给 `asset_batch`，**不落库**。于是用户在界面上
看不到"刚才那张图到底是用什么提示词生的"，也无从改起。

造型阶段更麻烦——`asset_stages` 根本没有存提示词的列。

## 做法：不落库，按需重算

提示词对 (项目, 角色, 造型, 形象档案, 影调, 画风) 是确定的，而这些**都已落库**
（`assets.profile_json` / `projects.look_json` / `projects.art_style`）。
所以现算一份返回即可，还比快照更贴近当前真实口径。

⚠️ **这里只读不写、也不调 LLM**：形象档案与影调缺失时就按缺失拼（与生成时同样降级），
不在一个"预览"接口里偷偷触发几分钟的档案生成。
"""
from __future__ import annotations

import json
import logging
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..asset_prompt import character_prompt, prop_prompt, scene_prompt
from .. import access   # 多用户隔离：归属校验（2026-10-09）
from ..db import Asset, AssetStage, Project, Shot, get_session
from .. import stage_gate

log = logging.getLogger(__name__)

router = APIRouter(prefix="/v2", tags=["shotflow"])


class InsertShotIn(BaseModel):
    project_id: str
    #: 插在这一镜之后；不给则插到最前
    after_order: Optional[int] = None
    episode: Optional[int] = None
    script_ref: str = ""
    duration_sec: float = 5.0


@router.post("/shots/insert")
def insert_blank_shot(body: InsertShotIn) -> dict:
    """在指定位置插入一个**空白镜头**，供用户自己写提示词 / 挂参考图。

    为什么不复用 `POST /v2/shots/special`：那条路要求必须带 `video_url`
    （它的用途是"把外部成片素材塞进镜头轨"），而这里要的恰恰是一个还没有
    任何素材、等着被生成的空位。

    ⚠️ 插入必须**整体重排 order**。只给新镜头一个中间值（比如 3.5）的话，
    order 就不再是连续整数——而项目里到处都按 order 做区间判断
    （造型阶段的 shot_from/shot_to、音频与字幕的 start_shot_order），
    小数一进来那些区间全部对不上。
    """
    with get_session() as session:
        proj = session.get(Project, body.project_id)
        if not proj:
            raise HTTPException(404, "project not found")

        shots = (session.query(Shot)
                 .filter(Shot.project_id == body.project_id)
                 .order_by(Shot.order).all())

        pos = 0
        if body.after_order is not None:
            for i, s in enumerate(shots):
                if s.order == body.after_order:
                    pos = i + 1
                    break
            else:
                pos = len(shots)

        ep = body.episode
        if ep is None:
            ep = (shots[pos - 1].episode if pos > 0 and shots[pos - 1].episode
                  else (shots[pos].episode if pos < len(shots) else 1)) or 1

        new = Shot(id=uuid.uuid4().hex[:12], project_id=body.project_id,
                   order=0, episode=ep,
                   script_ref=body.script_ref or "（空白镜头，待填写）",
                   duration_sec=body.duration_sec, status="pending")
        shots.insert(pos, new)
        session.add(new)
        # 整体重排：order 必须保持连续整数
        for i, s in enumerate(shots, start=1):
            if s.order != i:
                s.order = i
        session.commit()
        return {"id": new.id, "order": new.order, "episode": new.episode,
                "total": len(shots)}


class PromptPreviewIn(BaseModel):
    project_id: str
    #: 二选一：给 stage_id 就是某一套造型；否则按 kind+name 取资产
    stage_id: Optional[str] = None
    kind: Optional[str] = None
    name: Optional[str] = None


class AdoptImageIn(BaseModel):
    version_no: int


class AssetPromptReviseIn(BaseModel):
    """按**意图**改资产的生图提示词（不是逐字替换）。"""

    #: 资产 id。造型改写暂未开放（见 `prompt_revise.revise_asset_prompt` 的说明）。
    asset_id: str
    #: 用户那句话，例如「衣服换成米色羊毛大衣」「背景去掉霓虹灯」。
    instruction: str
    #: true = 写进 `Asset.prompt`（用户终稿）；false = 只回对照（默认）。
    save: bool = False


def _target_ref(session, project_id: str, *, stage_id: str | None,
                kind: str | None, name: str | None) -> tuple[str, str, str]:
    """把 (stage_id) 或 (kind, name) 统一解析成 (kind, target_id, label)。

    版本表按 `target_id` 索引，而上层有两个入口（造型走 stage_id、资产走
    kind+name），所以必须有**唯一一处**做这个翻译——两处各写一遍，
    迟早有一处把 kind 写错，然后版本记到别的目标下面去。
    """
    if stage_id:
        st = session.get(AssetStage, stage_id)
        # ⚠️ 必须比对 `st.project_id == project_id`（2026-10-09 补）。
        #
        # 中间件只校验了查询串里的 project_id 是你的；stage_id 却是**另一个**
        # 独立参数。不比对的话：带上自己的 project_id + 别人的 stage_id，
        # image-versions 就能读别人的版本历史、adopt-image 就能**改写**别人
        # 造型的图 —— 两道参数各自合法，组合起来越权。
        # 判作"不存在"而不是 403，与 access 模块头 ① 的口径一致。
        if not st or st.deleted_at or st.project_id != project_id:
            # 虚拟段（`__nostage__`）没有库行，是最常见的来源：前端若拿轨道上
            # 合成的段当目标就会走到这。给一句能照做的话，别只说 stage not found。
            raise HTTPException(404, stage_gate.describe_missing(stage_id))
        return "stage", st.id, f"{st.character_name} · {st.stage_name}"
    if not (kind and name):
        raise HTTPException(400, "要么给 stage_id，要么给 kind + name")
    a = (session.query(Asset)
         .filter(Asset.project_id == project_id, Asset.kind == kind,
                 Asset.name == name, Asset.deleted_at.is_(None)).first())
    if not a:
        raise HTTPException(404, "asset not found")
    return a.kind, a.id, a.name


@router.get("/assets/image-versions")
def list_image_versions(project_id: str, stage_id: Optional[str] = None,
                        kind: Optional[str] = None,
                        name: Optional[str] = None) -> dict:
    """某个资产/造型的图片历史版本，新的在前。

    资产生图是花钱的，而"重新生成"此前是**直接覆盖**、旧图找不回来。
    镜头早就有版本历史（shot_versions），资产一直没有——这里补上。
    """
    from ..asset_versions import list_for
    with get_session() as session:
        k, tid, label = _target_ref(session, project_id, stage_id=stage_id,
                                    kind=kind, name=name)
    return {"kind": k, "target_id": tid, "label": label,
            "versions": list_for(tid)}


@router.post("/assets/adopt-image")
def adopt_image_version(project_id: str, body: AdoptImageIn,
                        stage_id: Optional[str] = None,
                        kind: Optional[str] = None,
                        name: Optional[str] = None) -> dict:
    """切到某一版图片：把该版的图、以及**那一版的提示词输入**一起写回资产/造型。

    与镜头 adopt 同一套语义：**切换本身也落一条版本**（`source='adopt'`），
    这样"切错了"还能再切回去——否则用户点错一下就把刚做好的那张弄丢了，
    而它可能花了几分钟的生成时间。

    ## 回退要还的是"输入"，不是当初的"产物"（2026-10-15 修）

    造型的版本行里存着两份文本，此前回退时混用了：
      · `prompt`   = `character_prompt()` 拼出的**复合稿**（实测 857 字）
      · `desc_in`  = 那份稿子的**输入**，即造型的着装描述（"黑色皮夹克"）

    原来把复合稿整个写进 `description`，下一次预览再拿它当输入套一层——
    实测 857 → 1708 字（**1.99×**），**每切一次翻一倍**。用户报"提示词越切越长"
    就是这个。现在只还 `desc_in`。

    ## 无稿版本要明说，不能静默保留上一版（2026-10-15 修）

    上传版、擦字幕/放大版的 `prompt` 是 NULL（prod 上传版 960/960 全为 NULL）。
    原来遇 NULL 直接跳过写回，于是**图换成 v2 了、提示词框还停在上一次的稿上**
    ——正是用户报的"用修改过的提示词出的图，但切换版本后提示词还是旧版"。
    现在把这件事如实回报给前端（`text_state`），由界面告诉用户"这一版没有存稿"，
    而不是让它看起来像那一版的稿。
    """
    from ..asset_versions import get as get_ver, record as _rec
    text_state = "restored"
    with get_session() as session:
        k, tid, label = _target_ref(session, project_id, stage_id=stage_id,
                                    kind=kind, name=name)
        ver = get_ver(tid, body.version_no)
        if not ver:
            raise HTTPException(404, f"版本 {body.version_no} 不存在")
        if not ver.get("image_url"):
            raise HTTPException(400, "该版本没有图片（可能是清空记录）")

        if k == "stage":
            st = session.get(AssetStage, tid)
            if not st:
                raise HTTPException(404, stage_gate.describe_missing(tid))
            st.image_url = ver["image_url"]
            # 换回旧图时描述也跟着回退：造型描述是生图依据，图与描述对不上的话，
            # 下一镜注入的参考图与提示词会互相打架。
            # ⚠️ 只还 `desc_in`（输入）。老行没有这一列时（补列之前的存量）
            # **不拿复合稿顶替**——那正是把描述撑成两倍的元凶。
            # 造型版本行里存着两份文本，能不能回退取决于**存的是哪一份**：
            #   · `desc_in`   = 着装描述（可编辑输入）—— 直接还，永远安全
            #   · `prompt`    = 当初喂给模型的稿。它**可能是复合稿**（`character_prompt()`
            #     的产物，857 字），也可能是描述本身，取决于哪条路落下的：
            #       - `source='ai'`（生成落库）→ 复合稿，**不能**写回描述（会套娃翻倍）
            #       - `source='upload'/'backfill'` → 就是当时的 description，可以还
            #     这个区分是有依据的，不是猜：老 `patch_stage` 传的 `prompt=body.description`，
            #     老 `_gen_and_save` 传的是 `item["prompt"]`（拼好的稿）。
            d = ver.get("desc_in")
            if d is not None:
                st.description = d
            elif ver.get("prompt") is not None and ver.get("source") != "ai":
                st.description = ver["prompt"]
            elif ver.get("prompt") is not None:
                # 只有复合稿、没有单独的输入存档（补 desc_in 之前的生成版本）。
                # **不写回**——写回就是套娃翻倍的老 bug。但仍要如实告诉用户
                # "这一版没有单独存下你填的那部分"，而不是笼统说"没有提示词"
                # （悬浮框里明明能看到一份）。界面按这个值给不同的说法。
                text_state = "composite_only"
            else:
                text_state = "no_text"
            st.source_stage_id = None     # 自己就是源了，解除指针
        else:
            a = session.get(Asset, tid)
            if not a:
                raise HTTPException(404, "asset not found")
            a.image_url = ver["image_url"]
            # 资产的 `prompt` 列本身就是可编辑的整段稿（与版本行的 prompt 同义），
            # 所以这里直接回退；NULL 时同样如实回报，不再静默留旧稿。
            if ver.get("prompt") is not None:
                a.prompt = ver["prompt"]
            else:
                text_state = "no_text"
        session.commit()
        _pid, _url = project_id, ver["image_url"]
        _label = label or ver.get("label")
    # ⚠️ 切回旧版时这条 `adopt` 记录**不会**新增一行：`record()` 会按
    # 「图 + 稿」在**全表**里找到那一版并复用它的版本号，只把"当前采用"的指针
    # 挪过去。此前是每次都无条件追加，prod 实测 45/45 条 adopt 行都是重复 URL，
    # 用户来回切几次就在一个造型上看到四个勾（而且点哪个都取消不掉）。
    vno = _rec(project_id=_pid, kind=k, target_id=tid, image_url=_url,
               prompt=ver.get("prompt"), desc_in=ver.get("desc_in"),
               # 用户点的是哪一版，就认哪一版：存量库里同一份内容可能已有多行
               # （老代码每次都追加），不指名就会命中版本号最大的那条，
               # 表现成"我点了 v2，勾却跳到 v4"。
               prefer_no=body.version_no,
               model_id=ver.get("model_id"), source="adopt", label=_label)
    return {"ok": True, "version_no": body.version_no, "image_url": _url,
            "kind": k, "target_id": tid, "adopted_version": vno,
            "text_state": text_state, "text": ver.get("desc_in") or ver.get("prompt")}


def _profile_of(session, project_id: str, name: str) -> dict | None:
    a = (session.query(Asset)
         .filter(Asset.project_id == project_id, Asset.kind == "character",
                 Asset.name == name, Asset.deleted_at.is_(None)).first())
    if not a or not a.profile_json:
        return None
    try:
        return json.loads(a.profile_json)
    except json.JSONDecodeError:
        return None


@router.post("/assets/prompt-preview")
@access.requires(access.ROLE_VIEWER)
async def prompt_preview(body: PromptPreviewIn) -> dict:
    """返回这个资产/造型**当前**会用的生图提示词。不生成、不落库。

    所以是 `viewer` 档：查看者看得到提示词才能理解"这张图为什么长这样"，
    而它既不花钱也不改数据。**必须显式盖章** —— 写方法的默认档是 editor，
    不盖的话查看者会被自己的查看按钮挡住。
    """
    from ..character_brief import brief_for_image, creature_of, load_brief
    from ..db import desc_of, final_prompt_of
    from ..jobs import _style_of

    with get_session() as session:
        proj = session.get(Project, body.project_id)
        if not proj:
            raise HTTPException(404, "project not found")
        title = proj.title or ""
        try:
            look = json.loads(proj.look_json) if proj.look_json else None
        except json.JSONDecodeError:
            look = None
        style = _style_of(body.project_id)

        if body.stage_id:
            st = session.get(AssetStage, body.stage_id)
            # 比对归属：理由同 `_target_ref` —— body.project_id 已被中间件放行，
            # 但 stage_id 是另一个独立参数，不比对就能读到别人造型的描述与档案。
            if not st or st.deleted_at or st.project_id != body.project_id:
                raise HTTPException(404, stage_gate.describe_missing(body.stage_id))
            # 造型有 ep_from，直接用它读**已落库**的档案（见下方资产分支的注释）
            # ⚠️ `load_brief` 返回的是**单个角色的档案**，而 `brief_for_image`
            # 要的是 {角色名: 档案} 的映射 —— 必须包一层，否则永远拿不到。
            _b = load_brief(body.project_id, st.character_name)
            brief_dict = {st.character_name: _b} if _b else {}
            # 指针行自身无图：提示词按它指向的源造型算，否则会得到一段
            # 与实际那张图无关的描述
            src = st
            if st.source_stage_id:
                s2 = session.get(AssetStage, st.source_stage_id)
                if s2 and not s2.deleted_at and s2.project_id == body.project_id:
                    src = s2
            p = character_prompt(
                title, src.character_name, stage_name=src.stage_name,
                description=src.description,
                brief=brief_for_image(brief_dict, src.character_name),
                creature=creature_of(brief_dict, src.character_name),
                profile=_profile_of(session, body.project_id, src.character_name),
                look=look, style=style, aspect=proj.base_aspect)
            return {"prompt": p, "target": "stage", "stage_id": st.id,
                    "name": f"{st.character_name} · {st.stage_name}",
                    "reused_from": src.id if src is not st else None,
                    "editable_persisted": False}

        if not (body.kind and body.name):
            raise HTTPException(400, "要么给 stage_id，要么给 kind + name")

        a = (session.query(Asset)
             .filter(Asset.project_id == body.project_id, Asset.kind == body.kind,
                     Asset.name == body.name, Asset.deleted_at.is_(None)).first())
        if not a:
            raise HTTPException(404, "asset not found")

        if body.kind == "character":
            # ⚠️ 读**已落库**的档案，不现场调 LLM（2026-10-20 改）。
            #
            # 此前这里 `await character_brief(project_id, ep)`：cache miss 就同步
            # 打一次纯文本调用（实测 8~188s），而它跑在一个 HTTP 请求里。
            # 生产实测 `/fwp/v2/assets/prompt-preview` 504 是 **29 次、每次都
            # 正好 300.00s**（nginx proxy_read_timeout），另有 18 次 499
            # （19~261s 客户端主动放弃）——用户看到的就是"提示词窗口一直加载"。
            #
            # 档案现在由拆解末尾落库（`character_brief.fill_briefs`）。这里只读
            # 一行；没落库的角色（老项目 / 拆解后新增的角色）走空档案，
            # 提示词的其余各层照常给，不会白屏。
            _b = load_brief(body.project_id, a.name)
            brief_dict = {a.name: _b} if _b else {}
            if not brief_dict:
                # 兜底：档案缺失时**只做一次**极短尝试，且带超时。
                # 没有它，老项目的角色永远拿不到性别/年龄，只能等用户重跑拆解。
                #   · 用 `asyncio.wait_for` 卡住上限，绝不让请求挂到 nginx 超时；
                #   · 超时/失败就当没有档案（`brief_for_image` 返回 None），
                #     与改动前「档案拿不到就退回旧行为」一致；
                #   · 成功则落库，下一次预览就是纯读库。
                brief_dict = await _brief_with_deadline(body.project_id, a.name, session)
            p = character_prompt(title, a.name, description=desc_of(a),
                                 brief=brief_for_image(brief_dict, a.name),
                                 creature=creature_of(brief_dict, a.name),
                                 profile=_profile_of(session, body.project_id, a.name),
                                 look=look, style=style, aspect=proj.base_aspect)
        elif body.kind == "prop":
            # 道具走自己的模板（2026-10-08）。不能落到下面的 else ——
            # 那会拿到场景模板：一段"空镜头、画面中空无一人、完整呈现空间布局"
            # 的提示词，用来生一把刀。预览看到的与实际下发的必须是同一份。
            p = prop_prompt(a.name, description=desc_of(a), title=title,
                            look=look, style=style)
        else:
            p = scene_prompt(a.name, description=desc_of(a), title=title,
                             look=look, style=style)
        # 用户改过的整段终稿（`prompt`）非空就以他改的为准；否则用拼装结果。
        # ⚠️ 两个读数口径互斥、都在 `db` 里：
        #   · 终稿走 `final_prompt_of`（会排除存量行里"其实是描述"的 prompt）；
        #   · 描述走 `desc_of`（读 `desc_auto`）。
        # 此前两者共用一列，场景描述一旦写进 `prompt`，这个接口返回的就成了
        # 那 160 字描述片段，画风前缀、构图句、空镜头要求、影调句全部丢失。
        return {"prompt": final_prompt_of(a) or p, "auto_prompt": p,
                "target": "asset", "asset_id": a.id, "name": a.name,
                "editable_persisted": True}


@router.post("/assets/prompt/revise")
async def revise_asset_prompt(body: AssetPromptReviseIn) -> dict:
    """按意图改资产的生图提示词，返回改前改后对照。

    与视频侧（`POST /v2/shots/{id}/prompt/revise`）是同一套语义：
    **先看再决定**，`save=false` 只返回对照不落库。

    实现只在 `prompt_revise.revise_asset_prompt` 一份 —— 超级 Agent 也调它。

    ⚠️ 这里**必须显式盖章 editor**：写方法的默认档就是 editor，但这条端点
    带 `save` 开关，语义上有一半是纯读。盖章是为了让"`save=false` 的预览"
    仍然限定在能改这个项目的人手里 —— 提示词里含角色描述与妆造细节，
    查看者不该靠这条端点把它们整段拉走（`prompt-preview` 已经给了只读能力，
    那条走的是 viewer 档且不给改写）。
    """
    from ..prompt_revise import revise_asset_prompt as _revise

    from ..db import Asset, get_session as _gs
    with _gs() as session:
        a = session.get(Asset, body.asset_id)
        if a is None:
            raise HTTPException(404, "资产不存在")
        pid = a.project_id
    # 归属 + 档位：复用资产对象守卫（路径里没有 project_id，中间件管不到）。
    with _gs() as session:
        access.req_asset(session, body.asset_id)

    instruction = (body.instruction or "").strip()
    if not instruction:
        raise HTTPException(400, "说说要怎么改")
    if len(instruction) > 2000:
        raise HTTPException(400, "改法说明太长（上限 2000 字）")

    out = await _revise(body.asset_id, instruction, save=body.save)
    if not out.get("ok"):
        raise HTTPException(422, out.get("error") or "改写失败")
    out["project_id"] = pid
    return out


#: 预览接口里给"档案没落库"留的兜底预算（秒）。
#:
#: 为什么不干脆不兜底：老项目（拆解末尾补档案之前建的）一个角色都没有
#: `brief_json`，而档案决定「性别 + 年龄段」——没有它，`brief_for_image`
#: 返回 None，女主可能被画成男人（这正是 Q1 修的 bug）。所以留一条窄路。
#:
#: 为什么必须**卡死**：nginx 的 `proxy_read_timeout` 是 300s，而 `llm_timeout`
#: 是 600s —— 超时点不一致时，用户等满 300s 拿到的是 504，而不是"再等等"。
#: 8s 的预算宁可拿不到档案（退回旧行为、和改动前一样），也不能把预览拖成超时。
#: 档案是角色级、一次落库永久有效，所以只有第一次打开该角色会付这 8s。
_BRIEF_PREVIEW_BUDGET = 8.0

#: 同角色并发打开预览时只打一次 LLM（否则双击就花两次钱）。
_BRIEF_FILL_LOCKS: dict[tuple[str, str], "asyncio.Lock"] = {}


async def _brief_with_deadline(project_id: str, name: str, session) -> dict:
    """档案未落库时的窄兜底：带超时跑一次 `character_brief`，成功则落库。

    失败/超时一律返回 `{}`，由 `brief_for_image` 退回"没有档案"的旧行为——
    这条路径**绝不能**让预览接口失败或超时。
    """
    import asyncio

    from ..character_brief import character_brief, save_briefs

    # 找该角色首次出场的集（与 jobs._collect_briefs 同策略）。资产没有 episode 列。
    first_ep = (session.query(Shot.episode)
                .filter(Shot.project_id == project_id,
                        Shot.characters.like(f'%"{name}"%'))
                .order_by(Shot.episode).first())
    ep = first_ep[0] if first_ep else 1

    lock = _BRIEF_FILL_LOCKS.setdefault((project_id, name), asyncio.Lock())
    # 已在别处跑着就**不等它**：等 = 把自己也拖进对方的超时里。
    # 这一次先按无档案渲染，对方跑完后下一次预览就能读到。
    if lock.locked():
        return {}
    async with lock:
        try:
            brief = await asyncio.wait_for(
                character_brief(project_id, ep), timeout=_BRIEF_PREVIEW_BUDGET)
        except (asyncio.TimeoutError, Exception):  # noqa: BLE001 兜底绝不外抛
            return {}
        if not brief:
            return {}
        # ⚠️ 落库放到线程里：`save_briefs` 是同步的 SQLAlchemy 写，
        # 在事件循环里直接调用会卡住整个进程（本项目其它路由也是这个纪律）。
        try:
            await asyncio.to_thread(save_briefs, project_id, brief)
        except Exception as e:  # noqa: BLE001 落库失败不影响本次返回
            log.warning("[brief] 预览时落库失败（本次照常返回）: %r", e)
        return brief
