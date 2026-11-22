"""Gemini 视频反推封装 —— ⛔ 已废弃, 无任何调用方, 请勿在新代码中引用。

视觉理解已全面改用豆包(火山方舟) ``video/doubao_video.py``:
  - 原生视频理解, 不需本地抽帧/降规格, 无 128MB base64 限制
  - 支持 oss_key / video_url 直传, 带计费归属
  - 契约与本模块的 analyze_video_file 对齐, 属 drop-in 替代

2026-09-02 清理: 最后两处调用(clip/asset_service.py、clip/routes.py)与
video/__init__.py 的导出已改指 doubao_video; features/video_routes.py、
tikhub/routes.py 里写死的 "__REDACTED__" 也一并清空
(video_pipeline 的 model 参数传给豆包后本就被忽略, 实际用
config.ark_video_understand_model)。

文件暂时保留仅供查阅历史实现, 后续可整体删除。

---- 以下为原始说明 ----

经实测,让 Gemini 3.1 Pro Preview(经 kegeai 代理)直接输出复杂 JSON schema
(尤其是要求剧本 shots + 正文 full_text 同时产出)时,行为极不稳定:
经常只给 {} / 只给 shots / 只给 characters / 输出被 thinking token 吃掉。

因此这版改为:
1. 只让 Gemini 做它最擅长的事——看完整视频,输出角色清单 + 小说体完整复述。
2. 用简单的分隔符文本格式 (=====CHARACTERS===== / =====FULL_TEXT=====) 替代 JSON,
   鲁棒性显著高于 response_mime_type=application/json。
3. shots(剧本) 留给下游的通用模型(DeepSeek)基于 full_text 生成,
   这是系统现成的章节→剧本流水线,复用即可,不需要 Gemini 再操心。
"""
from __future__ import annotations

import asyncio
import base64
import logging
import mimetypes
import os
import re
from pathlib import Path
from typing import Any

import httpx

from ..config import get_settings

logger = logging.getLogger("video.gemini")


USER_PROMPT_TEMPLATE = """请完整观看这段短剧视频(《{draft_title}》第{episode_order}集),然后严格按以下两段结构输出。

输出格式硬约束:
1. 只输出两段,用 =====CHARACTERS===== 和 =====FULL_TEXT===== 两个分隔符各占一行标识,不要输出任何 JSON、markdown 包裹、解释性文字。
2. 第一段在 =====CHARACTERS===== 下面,每行一个角色,格式为 "代号|角色定位|外貌描述",列数固定为 3,不要加序号,不要加空行。
3. 第二段在 =====FULL_TEXT===== 下面,用小说叙述体,按时间顺序完整复述本集,保留所有台词原话(包括语气词),不要总结、不要跳过任何对话。目标 1500~4500 字。

角色命名硬约束(违反视为失败):
- 不得猜测角色真实姓名;所有角色只能用以下代号:
  男1、男2、男3 ...(男主通常是男1,按首次出场顺序递增)
  女1、女2、女3 ...(女主通常是女1,按首次出场顺序递增)
  老1、老2 ...(中老年难以判断主次时可用)
  童1、童2 ...(未成年)
  路人(非重要群演统一写"路人")
  旁白(画外旁白)
- 同一外貌的角色在 CHARACTERS 段和 FULL_TEXT 段必须用同一个代号。

{known_characters_block}

示例输出(仅示例,实际内容来自本集视频):

=====CHARACTERS=====
男1|男主|黑西装短发,约30岁,神情严肃
女1|女主|白色连衣裙长发,年轻
女2|配角|卷发,穿黑色职业装
=====FULL_TEXT=====
夜晚的写字楼大厅里,男1抱着一个纸箱缓步走出...
"""


def _known_characters_block(known: list[dict]) -> str:
    """把前几集已识别角色塞进 prompt,用于强化跨集代号一致性。"""
    if not known:
        return "(前面没有已识别角色,本集角色请从 男1/女1 开始编号)"
    lines = ["前面各集已识别的角色,请在本集中优先沿用这些代号(仅当出现明显新面孔时才分配新代号):"]
    for c in known:
        alias = c.get("alias", "")
        role = c.get("role", "")
        appearance = c.get("appearance", "")
        if alias:
            lines.append(f"- {alias}({role}): {appearance}")
    return "\n".join(lines)


def _mime_for_video(path: str) -> str:
    ext = Path(path).suffix.lower()
    mapping = {
        ".mp4": "video/mp4",
        ".mov": "video/quicktime",
        ".mkv": "video/x-matroska",
        ".webm": "video/webm",
        ".avi": "video/x-msvideo",
        ".mpeg": "video/mpeg",
        ".mpg": "video/mpeg",
        ".3gp": "video/3gpp",
        ".flv": "video/x-flv",
        ".wmv": "video/x-ms-wmv",
    }
    return mapping.get(ext) or mimetypes.guess_type(path)[0] or "video/mp4"


def _resolve_endpoint(model: str) -> tuple[str, str]:
    """根据 OPENAI_BASE_URL 解析 Gemini 原生端点。返回 (endpoint, api_key)。"""
    s = get_settings()
    base_url = (s.openai_base_url or "").rstrip("/")
    api_key = s.openai_api_key or ""
    if not base_url or not api_key:
        raise RuntimeError("OPENAI_BASE_URL / OPENAI_API_KEY 未配置,无法调用视频模型")
    # kegeai 代理用的是 /v1 的 OpenAI 兼容前缀,Gemini 原生要剥掉后用 /v1beta
    if base_url.endswith("/v1"):
        host = base_url[:-3]
    elif base_url.endswith("/v1/"):
        host = base_url[:-4]
    else:
        host = base_url
    return f"{host}/v1beta/models/{model}:generateContent", api_key


# 合法占位代号模式(用于过滤角色卡中的伪真名)
PLACEHOLDER_RE = re.compile(r"^(?:男|女|老|童)\d+$|^路人$|^旁白$")


def _parse_text_response(text: str, episode_order: int) -> dict[str, Any]:
    """把 Gemini 返回的分隔符文本拆成 {characters, full_text}。

    Gemini 偶尔会把分隔符写成 ====CHARACTERS==== / ===CHARACTERS=== / **CHARACTERS**
    等变体,全部容忍。
    """
    text = (text or "").strip()

    # 去掉意外的 markdown 包裹
    if text.startswith("```"):
        text = text.strip("`").lstrip()
        if text.lower().startswith("text") or text.lower().startswith("plaintext"):
            text = text.split("\n", 1)[1] if "\n" in text else text

    # 找 CHARACTERS / FULL_TEXT 两个分隔符位置(宽松匹配)
    char_pat = re.compile(r"={3,}\s*CHARACTERS\s*={3,}|^\s*#+\s*CHARACTERS\b|\*{2,}\s*CHARACTERS\s*\*{2,}", re.MULTILINE | re.IGNORECASE)
    full_pat = re.compile(r"={3,}\s*FULL[_ ]?TEXT\s*={3,}|^\s*#+\s*FULL[_ ]?TEXT\b|\*{2,}\s*FULL[_ ]?TEXT\s*\*{2,}", re.MULTILINE | re.IGNORECASE)

    char_m = char_pat.search(text)
    full_m = full_pat.search(text)

    chars_block = ""
    text_block = ""

    if char_m and full_m and char_m.end() <= full_m.start():
        chars_block = text[char_m.end():full_m.start()].strip()
        text_block = text[full_m.end():].strip()
    elif full_m and not char_m:
        # 只有 FULL_TEXT 段,CHARACTERS 可能缺失
        text_block = text[full_m.end():].strip()
    elif char_m and not full_m:
        # 只有 CHARACTERS,异常
        chars_block = text[char_m.end():].strip()
    else:
        # 两个都找不到 → 把整个文本当作 full_text
        text_block = text

    # 解析角色清单
    characters: list[dict] = []
    for raw_line in (chars_block or "").splitlines():
        line = raw_line.strip().lstrip("-*• ").strip()
        if not line:
            continue
        # 剔除括号说明、示例行
        if line.startswith("(") or line.startswith("（"):
            continue
        # 必须包含至少一个管道符
        if "|" not in line:
            continue
        parts = [p.strip() for p in line.split("|")]
        alias = parts[0] if parts else ""
        role = parts[1] if len(parts) > 1 else ""
        appearance = parts[2] if len(parts) > 2 else ""
        if not alias:
            continue
        # 只接受占位代号,防止模型偷偷写真名
        if not PLACEHOLDER_RE.match(alias):
            logger.warning("ep=%d 丢弃非法角色代号: %r", episode_order, alias)
            continue
        characters.append({"alias": alias, "role": role or "配角", "appearance": appearance})

    # 去重(按 alias)
    seen: dict[str, dict] = {}
    for c in characters:
        seen.setdefault(c["alias"], c)
    characters = list(seen.values())

    full_text = (text_block or "").strip()

    return {"characters": characters, "full_text": full_text}


def _default_title(full_text: str, episode_order: int) -> str:
    """从正文首行抽出一个短标题作为 episode_title。"""
    if not full_text:
        return f"第{episode_order}集"
    # 取第一个非空行的前 20 字
    for ln in full_text.splitlines():
        ln = ln.strip()
        if ln:
            return ln[:20]
    return f"第{episode_order}集"


def _default_synopsis(full_text: str) -> str:
    """取正文前 80 字当一句话概要。"""
    if not full_text:
        return ""
    clean = re.sub(r"\s+", " ", full_text).strip()
    return clean[:80]


async def analyze_video_file(
    video_path: str,
    draft_title: str,
    episode_order: int,
    known_characters: list[dict] | None = None,
    model: str = "__REDACTED__",   # 已废弃, 无调用方; 视觉理解请用 doubao_video
    timeout_s: int = 600,
) -> dict[str, Any]:
    """把一段视频送给 Gemini,返回 {episode_title, episode_synopsis, characters_in_episode, full_text, shots=[]}

    Raises:
        RuntimeError: HTTP 失败 / 返回空 / 解析后 full_text 仍为空
    """
    endpoint, api_key = _resolve_endpoint(model)
    logger.info("gemini video endpoint=%s model=%s", endpoint, model)

    vpath = Path(video_path)
    if not vpath.exists():
        raise FileNotFoundError(f"video not found: {video_path}")
    size_mb = vpath.stat().st_size / 1024 / 1024
    logger.info("analyze_video_file: path=%s size=%.1fMB ep=%d", video_path, size_mb, episode_order)

    def _read_b64() -> str:
        with open(video_path, "rb") as f:
            return base64.b64encode(f.read()).decode("ascii")

    data_b64 = await asyncio.to_thread(_read_b64)
    mime_type = _mime_for_video(video_path)

    user_prompt = USER_PROMPT_TEMPLATE.format(
        draft_title=draft_title or "未命名",
        episode_order=episode_order,
        known_characters_block=_known_characters_block(known_characters or []),
    )

    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"inline_data": {"mime_type": mime_type, "data": data_b64}},
                    {"text": user_prompt},
                ],
            }
        ],
        "generation_config": {
            "temperature": 0.3,
            "max_output_tokens": 16384,
            # 不使用 response_mime_type,Gemini 对视频+结构化 JSON 联合输出不稳定
        },
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }

    async with httpx.AsyncClient(timeout=timeout_s) as client:
        resp = await client.post(endpoint, json=payload, headers=headers)
        if resp.status_code >= 400:
            snippet = resp.text[:1000]
            raise RuntimeError(f"gemini HTTP {resp.status_code}: {snippet}")
        data = resp.json()

    usage = data.get("usageMetadata") or {}
    candidates = data.get("candidates") or []
    feedback = data.get("promptFeedback") or {}

    if not candidates:
        raise RuntimeError(
            f"gemini 无候选返回(可能被 safety 拦截)。promptFeedback={feedback} usage={usage}"
        )

    cand = candidates[0]
    finish_reason = cand.get("finishReason", "")
    parts = (cand.get("content") or {}).get("parts") or []
    raw_text = "".join(
        str(p.get("text", ""))
        for p in parts
        if isinstance(p, dict) and p.get("text")
    )

    logger.info(
        "gemini ep=%d finishReason=%s text_len=%d usage=%s preview=%r",
        episode_order, finish_reason, len(raw_text), usage, raw_text[:300],
    )

    if not raw_text.strip():
        raise RuntimeError(
            f"gemini 返回空文本。finishReason={finish_reason} usage={usage} "
            f"safetyRatings={cand.get('safetyRatings')} promptFeedback={feedback}"
        )
    if finish_reason and finish_reason not in ("STOP", "MAX_TOKENS", ""):
        raise RuntimeError(f"gemini 异常终止: finishReason={finish_reason} preview={raw_text[:200]!r}")

    parsed = _parse_text_response(raw_text, episode_order)
    full_text = parsed["full_text"]
    characters = parsed["characters"]

    # 内容校验:full_text 至少 200 字才认为有效
    if len(full_text) < 200:
        raise RuntimeError(
            f"gemini 输出过短(len={len(full_text)}),视为失败。finishReason={finish_reason} "
            f"preview={raw_text[:500]!r}"
        )

    episode_title = _default_title(full_text, episode_order)
    episode_synopsis = _default_synopsis(full_text)

    return {
        "episode_title": episode_title,
        "episode_synopsis": episode_synopsis,
        "characters_in_episode": characters,
        "full_text": full_text,
        # shots 留空:交给下游"基于章节生成剧本"流程处理,避免 Gemini 一次要求太多导致不稳定
        "shots": [],
    }
