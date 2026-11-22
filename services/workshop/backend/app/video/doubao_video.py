"""豆包(方舟)视频反推封装 — A线「视频反推剧本」专用(替代 gemini_video)。

设计(2026-07 换引擎):
- 模型: doubao-seed-2-1-pro-260628(方舟原生视频理解), 走 TOS + Files API 整片上传拿 file_id,
  单文件支持最高 2GB, 原画质、完整剧情, 无需本地降帧率/降画质/切片。
- 与旧 gemini 版对齐的对外契约: analyze_video_file(...) 返回
  {episode_title, episode_synopsis, characters_in_episode, full_text, shots=[]}
  使得 video_pipeline 落库逻辑零改动。
- 关键差异(按用户新需求):
  1. 不再切段: 一个上传文件 = 一集, 整片反推。
  2. 角色直接用【真实姓名】(模型能力足够), 不再用 男1/女1 占位代号。
  3. 章节正文要求: 尽可能详尽、忠实、按时间顺序复述, 不设字数上限;
     清晰区分【人物内心OS】/【旁白】/【人物对话】, 正确使用标点符号; 严禁臆测画面外信息。
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

from ..config import get_settings

logger = logging.getLogger("video.doubao")


# ==========================================================================
# 反推提示词(A线专用: 详尽忠实复述 + 真名 + 区分内心OS/旁白/对话 + 不臆测)
# ==========================================================================

_SYSTEM_PROMPT = (
    "你是严谨的短剧视频拉片记录员。你的唯一职责是【如实、完整、按时间顺序转述这段视频里真实发生、"
    "画面与声音中真实呈现的内容】, 输出一份详尽、准确、可直接阅读的剧情文字记录。"
    "你【绝不】推测、脑补、想象或延展任何画面/台词中没有明确呈现的信息。"
)


def _known_characters_block(known: list[dict] | None) -> str:
    """把前面各集已识别的人物(姓名+定位+外貌/服装)拼成"已知人物表", 注入提示词。

    用于串行按集顺序反推时跨集沿用姓名: 本集若出现同一个人(即使本集没喊出名字),
    请依据外貌/服装匹配到已知人物并【沿用其姓名】, 而不是用外观新造一个称呼。
    """
    rows = []
    for c in known or []:
        if not isinstance(c, dict):
            continue
        name = (c.get("alias") or "").strip()
        if not name:
            continue
        role = (c.get("role") or "").strip()
        appearance = (c.get("appearance") or "").strip()
        seg = name
        if role:
            seg += f"({role})"
        if appearance:
            seg += f": {appearance}"
        rows.append("- " + seg)
    if not rows:
        return ""
    return (
        "\n【已知人物表(来自本剧前面各集, 请务必跨集沿用)】\n"
        "以下是本剧此前各集已经确认的人物姓名与外貌特征。本集中若出现同一个人"
        "(依据长相/身形/发型/标志性服饰等判断为同一人), 【必须沿用下表中的姓名】, "
        "即使本集台词/字幕里没有再次喊出他/她的名字, 也不要改用“黑衣男”“女子”这类外观称呼。\n"
        + "\n".join(rows) + "\n"
    )


def _build_user_prompt(draft_title: str, episode_order: int,
                       known_characters: list[dict] | None = None) -> str:
    """构造 A 线详尽复述指令。要求真名(跨集沿用)、区分内心OS/旁白/对话、正确标点、
    描写服装穿搭、不臆测、不限字数。"""
    known_block = _known_characters_block(known_characters)
    return (
        f"请完整观看这段短剧视频(《{draft_title or '未命名'}》第 {episode_order} 集), "
        "然后严格按以下结构输出【两段】, 用 =====CHARACTERS===== 和 =====FULL_TEXT===== "
        "两个分隔符各占一行标识。不要输出任何 JSON、markdown 代码块包裹、额外解释或总结。\n"
        f"{known_block}"
        "\n"
        "【第一段: =====CHARACTERS=====】\n"
        "列出本集出现的主要人物, 每行一个, 格式为 “姓名|角色定位|外貌与服装特征”, 三列, 用竖线 | 分隔, "
        "不要加序号、不要空行。要求:\n"
        "- 直接使用人物在视频中出现的【真实姓名】(台词、字幕、称呼中出现的名字); "
        "若上方【已知人物表】里已有此人, 【必须沿用表中的姓名】(依据长相/身形/发型/服饰判断为同一人); "
        "确实全程未出现姓名、且已知人物表里也没有的次要人物, 才用简洁称谓(如 “女服务员”“老板”“黑衣男”)。\n"
        "- 第三列外貌与服装特征请写清: 发型、体貌、以及本集该人物【所穿的服装/配饰】(颜色、款式、标志性配件)。\n"
        "- 同一个人在两段里必须使用完全一致的称呼。\n"
        "\n"
        "【第二段: =====FULL_TEXT=====】\n"
        "用中文, 按时间顺序【尽可能详尽、完整、忠实】地复述本集从头到尾发生的全部内容。硬性要求:\n"
        "1. 【不设字数上限】: 画面里发生了什么就写什么, 宁可细致也不要概括跳过; 不要总结、不要删减情节。\n"
        "2. 【完整保留台词原话】: 所有人物说出的话都要一字不漏地写出(包括语气词、重复、口头禅), 不要改写、不要转述成“他说了…的意思”。\n"
        "3. 【清晰区分三类内容, 正确使用标点符号】:\n"
        "   - 人物对话: 用 “姓名：「对白原话」” 的格式, 对白放进直角引号「」中, 说话人写在冒号前;\n"
        "   - 人物内心独白(OS/心理活动, 仅当画面/字幕/画外配音明确表现时): 用 “姓名（内心）：『内容』” 的格式, 内心话放进双书名号『』中;\n"
        "   - 旁白(画外解说、字幕旁白): 用 “旁白：内容” 另起一行;\n"
        "   - 画面动作与场景描写: 用普通叙述句直接写(如 “夜色中, 她快步走进公寓, 反手锁上门。”)。\n"
        "   注意逗号、句号、问号、感叹号、省略号的正确使用, 让文字通顺、断句自然、易读。\n"
        "4. 【描写人物的服装、配饰与穿搭】: 人物首次出场、以及【更换场景或换装时】, 用一句自然的叙述交代其当前穿着"
        "(如 “穿着米白色针织衫、戴金丝眼镜的顾承宇快步走来。”); 因为人物在不同环境/时间的服装往往不同, 这些穿搭"
        "变化要如实体现出来, 但仅描述画面里真实可见的, 不要臆造。\n"
        "5. 【严禁臆测、脑补、延展任何画面中没有的元素】, 具体包括:\n"
        "   - 不臆测人物没有明确表现出来的心理、动机、身份来历、前因后果;\n"
        "   - 不编造画面外的背景故事、未发生的情节;\n"
        "   - 不添加 “可能”“也许”“似乎在暗示”“为后文埋下伏笔” 这类推断性描述;\n"
        "   - 某信息画面里没有明确交代, 就【不写】, 有一说一。\n"
        "6. 只客观记录看到/听到的事实, 不做文学渲染、不做主观评价、不在结尾做任何总结或升华; "
        "画面内容讲完就停笔。\n"
        "\n"
        "示例(仅示意格式, 实际内容以视频为准):\n"
        "=====CHARACTERS=====\n"
        "林晚|女主|齐肩短发, 约25岁, 本集身着白色风衣配米色围巾\n"
        "陆西州|男主|身形高大神情冷峻, 本集黑色西装、银色腕表\n"
        "王姐|林晚同事|烫卷发, 藏青色职业套装\n"
        "=====FULL_TEXT=====\n"
        "深夜的写字楼大厅空无一人。身穿白色风衣、抱着纸箱的林晚走出电梯, 脚步很慢。\n"
        "陆西州：「站住。」\n"
        "林晚停下脚步, 回过头。\n"
        "林晚（内心）：『他怎么会在这里？』\n"
        "旁白：三年前的那场变故, 让两人再没说过一句话。\n"
    )


def _fmt_ts(sec: float) -> str:
    """秒 → mm:ss，用于告诉模型本段在整集里的位置。"""
    m, s = divmod(int(sec), 60)
    return f"{m:02d}:{s:02d}"


def _build_segment_prompt(
    draft_title: str, episode_order: int,
    known_characters: list[dict] | None,
    seg_index: int, seg_total: int,
    seg_start: float, seg_dur: float,
    prev_tail: str = "",
) -> str:
    """分段反推的提示词 = 基础提示词 + 本段时间位置 + 上一段结尾衔接。

    为什么要告诉模型"这是第几段":
      不说的话，模型会把每段都当成完整一集来处理——在段首重新交代背景、
      在段尾强行收束总结，拼接后就会出现大量重复铺垫和割裂的"本段结束"感。
      明确位置后，中间段落知道自己是承上启下的，不做开场也不做收尾。
    """
    base = _build_user_prompt(draft_title, episode_order, known_characters)
    head = (
        f"\n\n【⚠️ 本次任务是分段反推：这是第 {seg_index}/{seg_total} 段】\n"
        f"本段对应整集的 {_fmt_ts(seg_start)} - {_fmt_ts(seg_start + seg_dur)}。\n"
    )
    if seg_index == 1:
        head += "本段是全集开头，正常从头开始复述。\n"
    elif seg_index == seg_total:
        head += (
            "本段是全集结尾。请直接从画面当前进行到的地方接着往下写，"
            "【不要】重新交代前情、不要做任何开场铺垫。\n"
        )
    else:
        head += (
            "本段位于全集中间。请直接从画面当前进行到的地方接着往下写：\n"
            "- 【不要】重新交代前情、不要重新介绍已出现过的人物；\n"
            "- 【不要】在本段结尾做总结、收束或「本段到此结束」之类的话；\n"
            "  画面演到哪里就写到哪里，戛然而止是正确的。\n"
        )
    if prev_tail:
        head += (
            f"\n【上一段结尾的最后几句（仅供衔接参考，不要重复写出来）】\n"
            f"…{prev_tail}\n"
            "本段开头若与上述内容重叠（切分时有几秒重叠），请跳过已写过的部分，"
            "从没写过的地方继续。\n"
        )
    return base + head


# ==========================================================================
# 方舟 Files API + Chat 反推
# ==========================================================================

# 注: 这里原有一个 _upload_file_and_wait(无调用者), 已于 2026-08-26 删除。
#
# 它是 volc/client.py:upload_file_and_wait 的旧拷贝, 有两处致命差异:
#   ① 用 s.ark_api_key —— 该 key **没有** TOS 桶授权, 实测传 tos[bucket] 必 403
#      AccessDenied; 真正有授权的是 volc_ark_api_key(_cfg() 用的那个)。
#      项目里存在两个方舟 key, 排查时若误用 ark_api_key 会得出"授权没生效"
#      的错误结论 —— 已经踩过一次。
#   ② 不支持 TOS 桶模式(不传 tos 参数), 大文件仍会撞 512MB 上限。
# 留着这份拷贝, 下次有人接上它就会同时踩这两个坑。真正在跑的是 volc/client.py。


async def _chat_reverse(video_ref: dict, user_prompt: str, *, timeout: float) -> tuple[str, dict]:
    """给定 video_url content 块(file_id 或 url 引用), 调火山官方 seed2.1pro 反推。

    返回 (text, usage)。usage 供计费。已统一走 volc.client(官方 endpoint + 计费口径)。
    """
    from ..volc import client as volc_client
    text, usage = await volc_client.chat_understand(
        video_ref=video_ref,
        system_prompt=_SYSTEM_PROMPT,
        user_prompt=user_prompt,
        timeout=timeout,
    )
    text = (text or "").strip()
    if not text:
        raise RuntimeError("火山视频反推返回空内容")
    return text, (usage or {})


async def _reverse_raw(
    *, local_path: str | None, oss_key: str | None, video_url: str | None,
    user_prompt: str, timeout: float,
) -> tuple[str, dict]:
    """整片反推(优先 Files API 整片上传, 拿不到本地文件时回退 URL 直连)。

    返回 (text, usage)。已统一走火山官方 client(上传 + 理解)。
    """
    s = get_settings()
    fps = s.ark_video_understand_fps
    from ..volc import client as volc_client

    # 主路径: Files API 整片上传(无 50MiB 限制, 原画质)
    tmp_path = None
    file_id: str | None = None
    try:
        path = local_path
        if not path and oss_key:
            import tempfile
            from ..oss import client as _oss
            tf = tempfile.NamedTemporaryFile(delete=False, suffix=".mp4")
            tf.close()
            tmp_path = tf.name
            await asyncio.to_thread(_oss.get_object_to_file, oss_key, tmp_path)
            path = tmp_path
        if path:
            fid = await volc_client.upload_file_and_wait(path, timeout=timeout)
            file_id = fid
            ref = {"file_id": fid, "fps": fps}
            return await _chat_reverse(ref, user_prompt, timeout=timeout)
    except Exception as e:  # noqa: BLE001
        logger.warning("Files API 视频反推失败, 尝试回退 URL 直连(受50MiB限制): %s", str(e)[:200])
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except Exception:  # noqa: BLE001
                pass
        # 上传的文件是一次性消耗品, 用完立即回收, 否则撑满账号配额(见 delete_file 注释)。
        # 必须在 finally: 反推成功/失败/抛异常都要删, 否则失败路径反而泄漏得更多。
        # 删除走 best-effort, 不覆盖上面的返回值或异常。
        if file_id:
            await volc_client.delete_file(file_id)

    # 兜底: URL 直连(受 50MiB 限制)
    ref_url = video_url
    if not ref_url and oss_key:
        from ..oss import client as _oss
        ref_url = _oss.sign_get_url(oss_key, ttl_seconds=3600)
    if not (ref_url and (ref_url.startswith("http://") or ref_url.startswith("https://"))):
        raise RuntimeError("无可用的 local_path/oss_key/video_url, 无法反推")
    ref = {"url": ref_url, "fps": fps}
    return await _chat_reverse(ref, user_prompt, timeout=timeout)


# ==========================================================================
# 解析: 把模型输出的分隔符文本拆成 {characters, full_text}
# ==========================================================================

def _parse_response(text: str) -> dict[str, Any]:
    """拆 =====CHARACTERS===== / =====FULL_TEXT===== 两段。宽松匹配各种分隔符变体。"""
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.strip("`").lstrip()
        low = text.lower()
        if low.startswith("text") or low.startswith("plaintext"):
            text = text.split("\n", 1)[1] if "\n" in text else text

    char_pat = re.compile(
        r"={3,}\s*CHARACTERS\s*={3,}|^\s*#+\s*CHARACTERS\b|\*{2,}\s*CHARACTERS\s*\*{2,}",
        re.MULTILINE | re.IGNORECASE)
    full_pat = re.compile(
        r"={3,}\s*FULL[_ ]?TEXT\s*={3,}|^\s*#+\s*FULL[_ ]?TEXT\b|\*{2,}\s*FULL[_ ]?TEXT\s*\*{2,}",
        re.MULTILINE | re.IGNORECASE)

    char_m = char_pat.search(text)
    full_m = full_pat.search(text)

    chars_block = ""
    text_block = ""
    if char_m and full_m and char_m.end() <= full_m.start():
        chars_block = text[char_m.end():full_m.start()].strip()
        text_block = text[full_m.end():].strip()
    elif full_m and not char_m:
        text_block = text[full_m.end():].strip()
    elif char_m and not full_m:
        chars_block = text[char_m.end():].strip()
    else:
        text_block = text

    characters: list[dict] = []
    for raw_line in (chars_block or "").splitlines():
        line = raw_line.strip().lstrip("-*• ").strip()
        if not line or line.startswith("(") or line.startswith("（"):
            continue
        if "|" not in line:
            continue
        parts = [p.strip() for p in line.split("|")]
        name = parts[0] if parts else ""
        role = parts[1] if len(parts) > 1 else ""
        appearance = parts[2] if len(parts) > 2 else ""
        if not name:
            continue
        # 真名模式: 不再做占位代号白名单过滤; alias 存真名, 供 outline.characters 展示
        characters.append({"alias": name, "role": role or "配角", "appearance": appearance})

    # 去重(按 alias)
    seen: dict[str, dict] = {}
    for c in characters:
        seen.setdefault(c["alias"], c)
    characters = list(seen.values())

    return {"characters": characters, "full_text": (text_block or "").strip()}


def _default_title(full_text: str, episode_order: int) -> str:
    if not full_text:
        return f"第{episode_order}集"
    for ln in full_text.splitlines():
        ln = ln.strip()
        if ln:
            return ln[:20]
    return f"第{episode_order}集"


def _default_synopsis(full_text: str) -> str:
    if not full_text:
        return ""
    clean = re.sub(r"\s+", " ", full_text).strip()
    return clean[:80]


# ==========================================================================
# 对外主入口(契约与旧 gemini_video.analyze_video_file 对齐)
# ==========================================================================

async def _reverse_segmented(
    *, local_path: str, draft_title: str, episode_order: int,
    known_characters: list[dict] | None, timeout: float,
) -> tuple[str, list[dict], dict]:
    """长视频分段反推：无损切分 → 逐段反推 → 拼接。

    返回 (full_text, characters, usage_total)。

    为什么要分段(实测依据, draft 458):
      20 分钟整片 @1fps ≈ 1200 帧, 逼近火山 1280 帧上限、吃满 81920 视频 token,
      模型注意力被稀释, 后 30% 出现严重退化——台词占比从 70% 掉到 0%,
      单行平均长度从 30 字涨到 143 字(整段戏被压成一句概括)。
      切成 5 分钟一段后每段约 300 帧, 每段都在模型的舒适区内。

    注意: 切分是 -c copy 无损的, **不降画质、不降帧率**(反推质量依赖画面细节)。
    """
    from .splitter import split_for_reverse

    work_dir = tempfile.mkdtemp(prefix=f"revseg_{episode_order}_")
    try:
        segs = await split_for_reverse(local_path, work_dir)
        if len(segs) <= 1:
            # 短片直接整片反推, 不走分段(避免徒增拼接损耗)
            prompt = _build_user_prompt(draft_title, episode_order, known_characters)
            text, usage = await _reverse_raw(
                local_path=local_path, oss_key=None, video_url=None,
                user_prompt=prompt, timeout=timeout,
            )
            p = _parse_response(text)
            return p["full_text"], p["characters"], usage

        logger.info("ep=%d 分段反推: 共 %d 段", episode_order, len(segs))
        texts: list[str] = []
        all_chars: list[dict] = []
        seen_names: set[str] = set()
        total_usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

        for seg in segs:
            # 跨段沿用人名: 把已识别的人物表注入下一段提示词,
            # 否则同一个人在不同段会被按外观重新命名(林峰 → "格纹衬衫男")
            merged_known = list(known_characters or []) + all_chars
            prompt = _build_segment_prompt(
                draft_title, episode_order, merged_known,
                seg["index"], len(segs), seg["start"], seg["duration"],
                prev_tail=(texts[-1][-200:] if texts else ""),
            )
            text, usage = await _reverse_raw(
                local_path=seg["path"], oss_key=None, video_url=None,
                user_prompt=prompt, timeout=timeout,
            )
            parsed = _parse_response(text)
            seg_text = (parsed["full_text"] or "").strip()
            if seg_text:
                texts.append(seg_text)
            for c in parsed["characters"]:
                nm = (c.get("alias") or "").strip()
                if nm and nm not in seen_names:
                    seen_names.add(nm)
                    all_chars.append(c)
            for k in total_usage:
                total_usage[k] += int((usage or {}).get(k) or 0)
            logger.info("ep=%d 第%d/%d段完成: %d 字, 累计角色 %d 人",
                        episode_order, seg["index"], len(segs), len(seg_text), len(all_chars))

        return "\n".join(texts), all_chars, total_usage
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


async def analyze_video_file(
    video_path: str | None = None,
    draft_title: str = "",
    episode_order: int = 1,
    known_characters: list[dict] | None = None,  # 保留签名兼容(真名模式下不注入代号约束)
    model: str | None = None,                    # 保留签名兼容(实际用 ark_video_understand_model)
    timeout_s: int = 900,
    *,
    oss_key: str | None = None,
    video_url: str | None = None,
    user_id: int | None = None,                  # 计费归属用户(可空)
    draft_id: int | None = None,                 # 计费关联草稿(可空)
    billing_source: str = "videopipe",           # 计费来源标记
) -> dict[str, Any]:
    """豆包整片反推一集视频, 返回 {episode_title, episode_synopsis, characters_in_episode, full_text, shots=[]}。

    传参三选一(优先级 local_path > oss_key > video_url):
      - video_path: 本地视频文件路径(upload/from-url 入口)
      - oss_key:    TOS 对象 key(from-oss 入口, 内部下载到本地再走 Files API)
      - video_url:  公网直链(兜底, 受 50MiB 限制)

    Raises:
        RuntimeError: 未配置 / HTTP 失败 / 返回空 / 解析后 full_text 过短
    """
    s = get_settings()
    if not (s.ark_api_key or "").strip():
        raise RuntimeError("ARK_API_KEY 未配置, 无法调用豆包视频反推")

    if video_path:
        vp = Path(video_path)
        if not vp.exists():
            raise FileNotFoundError(f"video not found: {video_path}")
        size_mb = vp.stat().st_size / 1024 / 1024
        logger.info("doubao analyze: path=%s size=%.1fMB ep=%d", video_path, size_mb, episode_order)
    else:
        logger.info("doubao analyze: oss_key=%s url=%s ep=%d",
                    oss_key, (video_url or "")[:60], episode_order)

    # oss_key 来源时先下载到本地, 这样 _reverse_segmented 才能切分
    tmp_dl: str | None = None
    local = video_path
    try:
        if not local and oss_key:
            import tempfile
            from ..oss import client as _oss
            tf = tempfile.NamedTemporaryFile(delete=False, suffix=".mp4")
            tf.close()
            tmp_dl = tf.name
            await asyncio.to_thread(_oss.get_object_to_file, oss_key, tmp_dl)
            local = tmp_dl
            sz = Path(local).stat().st_size / 1024 / 1024
            logger.info("ep=%d OSS 下载完成: %.1f MB", episode_order, sz)

        if local:
            full_text, characters, usage = await _reverse_segmented(
                local_path=local,
                draft_title=draft_title,
                episode_order=episode_order,
                known_characters=known_characters,
                timeout=float(timeout_s),
            )
        else:
            # 无本地文件: 回退到 URL 直连整片反推(受 50MiB 限制, 兜底用)
            prompt = _build_user_prompt(draft_title, episode_order, known_characters)
            raw_text, usage = await _reverse_raw(
                local_path=None, oss_key=None, video_url=video_url,
                user_prompt=prompt, timeout=float(timeout_s),
            )
            parsed = _parse_response(raw_text)
            full_text, characters = parsed["full_text"], parsed["characters"]
    finally:
        if tmp_dl:
            try:
                os.unlink(tmp_dl)
            except Exception:  # noqa: BLE001
                pass

    # 计费: 视频理解 token 落库(旁路, 失败不阻断)
    try:
        from ..volc import billing as _billing
        u = _billing.extract_usage({"usage": usage})
        await _billing.record_usage(
            biz_type="video_understand",
            model_key=_billing.MK_VIDEO_UNDERSTAND,
            user_id=user_id,
            source=billing_source,
            ep_id=get_settings().volc_seed21pro_ep,
            prompt_tokens=u["prompt_tokens"],
            completion_tokens=u["completion_tokens"],
            total_tokens=u["total_tokens"],
            draft_id=draft_id,
        )
    except Exception:  # noqa: BLE001
        logger.warning("doubao 反推计费记录失败(不阻断)", exc_info=True)

    logger.info("doubao ep=%d 反推文本长度=%d", episode_order, len(full_text))

    if len(full_text) < 200:
        raise RuntimeError(
            f"豆包反推输出过短(len={len(full_text)}), 视为失败。preview={full_text[:500]!r}"
        )

    return {
        "episode_title": _default_title(full_text, episode_order),
        "episode_synopsis": _default_synopsis(full_text),
        "characters_in_episode": characters,
        "full_text": full_text,
        "shots": [],  # 与旧流程一致: shots 交给下游按章节正文生成
    }
