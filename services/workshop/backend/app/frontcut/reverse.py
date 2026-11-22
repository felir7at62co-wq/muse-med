"""豆包(方舟)视频反推 provider — A/B 两线共用。

实测确认(2026-07-11, 见 docs/PLAN-短视频前贴与飞书反推-API实测.md):
- 端点: POST {ark_base_url}/chat/completions (标准多模态 Chat)
- 模型: doubao-seed-2-1-pro-260628 (原生视频理解, 不需我们本地抽帧)
- 视频输入: messages[].content[] 放 {"type":"video_url","video_url":{"url":<公网直链>,"fps":1}}
- URL 要求: http/https/base64, 必须公网可访问(我们的 TOS 用 oss.sign_get_url 生成)
- 返回: choices[0].message.content
"""
from __future__ import annotations

import asyncio
import logging
import os
import tempfile

from ..config import get_settings

logger = logging.getLogger("frontcut.reverse")

# 反推指令: 让豆包如实转述"视频里实际发生、画面可见"的内容, 生成可当口播旁白的客观叙述。
# ⚠️ 核心约束(2026-07 修复用户反馈): 只描述画面里真实出现的人物、动作、对话、事件,
# 严禁推测、脑补、延展任何画面中没有的元素(人物心理、动机、背景故事、未发生的情节等)。
_REVERSE_SYSTEM = (
    "你是严谨的视频内容记录员。你的唯一职责是【如实转述视频里真实发生、画面可见的内容】, "
    "用第三人称、口语化、适合配音朗读的方式客观讲述。"
    "你【绝不】推测、脑补、想象或延展任何画面中没有明确呈现的信息。"
)


def _build_narration_instruction(target_chars: int | None) -> str:
    """构造'忠实转述视频可见内容'的反推指令; target_chars 为目标字数(约=原片秒数×4)。"""
    length_req = (
        f"字数控制在约 {target_chars} 字(可上下浮动 10%)。\n"
        if target_chars and target_chars > 0 else
        "长度与视频时长相匹配, 把画面里的内容讲完整即可。\n"
    )
    return (
        "请仔细观看这个视频, 然后写一段【可直接用于配音朗读的口播旁白文案】, 要求:\n"
        "1. 【只如实描述画面里真实发生、真实可见的内容】: 人物做了什么动作、说了什么台词、"
        "画面里出现了什么、事件如何推进。用连贯口语化的语言按时间顺序讲清楚。\n"
        "2. 【严禁推测、脑补、延展任何画面中没有的元素】, 具体包括:\n"
        "   - 不要臆测人物的内心想法、情绪动机、心理活动(除非画面/台词明确表现);\n"
        "   - 不要编造画面外的背景故事、人物身份来历、前因后果;\n"
        "   - 不要添加'可能''也许''似乎在想''暗示着''为后文埋下伏笔'这类推断性描述;\n"
        "   - 不要脑补任何视频里没有直接呈现的情节、场景或对话。\n"
        "   如果某个信息画面里没有明确交代, 就【不写】, 宁可简略也不编造。\n"
        "3. 第三人称客观叙述视角, 只陈述看到/听到的事实, 不做文学渲染和主观评价; "
        "不要写成'人物介绍/场景分析'这类分点说明。\n"
        "4. 【结尾严禁总结、升华、点评或剧透】: 画面里的事件讲完就【立刻停笔】, 结束在最后一个"
        "真实画面上。不要在末尾追加任何总结句、感想、主题升华、寓意解读, 也不要出现"
        "'这个视频讲述了…''故事告诉我们…''总的来说…''留给观众思考…''结局令人…'这类收尾/剧透性文字。\n"
        f"5. {length_req}"
        "6. 只输出这段口播文案正文本身, 不要任何标题、分点、序号、括号说明或额外解释。\n"
        "再次强调: 你是在【转述】视频内容, 不是在【创作】故事、更不是在【总结点评】。"
        "只写画面里真实有的, 有一说一, 讲完即止。"
    )


# 首帧画面描述指令: 让豆包只客观描述正片首帧这张图里"看得见的"元素, 供前贴衔接锚点用。
_FIRST_FRAME_SYSTEM = (
    "你是严谨的画面描述员。只客观描述给定图片里真实可见的视觉元素, "
    "绝不推测画面外的信息、剧情或人物心理。"
)
_FIRST_FRAME_INSTRUCTION = (
    "请客观描述这张图片(某视频的第一帧)里【看得见的】视觉内容, 用于让另一段视频的结尾画面与之衔接。"
    "重点描述: 主要人物(外貌/发型/服装/表情/姿态/所在位置)、场景环境(室内外/布景/关键物件)、"
    "画面构图与机位(景别:特写/近景/中景/远景, 人物在画面中的位置)、光线与色调氛围。"
    "【忽略后期叠加元素(重要)】: 画面上的剧名标题、花字、字幕、角色名标注、水印、logo、进度条等"
    "一切后期叠加的文字/图形元素一律【忽略不写】, 只描述实拍画面本身——这段描述将用于指导另一段"
    "视频的画面生成, 后期字幕不属于画面内容。"
    "要求: 只写画面里真实有的, 简洁准确, 一段话100-200字, 不要分点、不要标题、不要推测剧情。"
)


async def _record_understand_usage(usage: dict, *, source: str,
                                    user_id: int | None = None,
                                    draft_id: int | None = None) -> None:
    """把一次视频理解的 usage 落到火山计费(旁路, 失败不阻断)。"""
    try:
        from ..volc import billing as _billing
        u = _billing.extract_usage({"usage": usage or {}})
        await _billing.record_usage(
            biz_type="video_understand",
            model_key=_billing.MK_VIDEO_UNDERSTAND,
            user_id=user_id,
            source=source,
            ep_id=get_settings().volc_seed21pro_ep,
            prompt_tokens=u["prompt_tokens"],
            completion_tokens=u["completion_tokens"],
            total_tokens=u["total_tokens"],
            draft_id=draft_id,
        )
    except Exception:  # noqa: BLE001
        logger.warning("frontcut 反推计费记录失败(不阻断)", exc_info=True)


async def reverse_first_frame(*, image_url: str, timeout: float = 120.0,
                              user_id: int | None = None) -> str:
    """描述正片首帧画面(供前贴'首帧锚点衔接': 让前贴结尾收束到此画面)。

    image_url: 首帧图片的公网可访问 URL(签名 URL 即可)。
    返回一段客观的画面描述; 失败抛异常(调用方降级处理)。已统一走火山官方 client + 计费。
    """
    from ..volc import client as volc_client
    text, usage = await volc_client.chat_understand(
        image_url=image_url,
        system_prompt=_FIRST_FRAME_SYSTEM,
        user_prompt=_FIRST_FRAME_INSTRUCTION,
        timeout=timeout,
    )
    await _record_understand_usage(usage, source="frontcut-firstframe", user_id=user_id)
    text = (text or "").strip()
    if not text:
        raise RuntimeError("首帧描述返回空内容")
    return text


async def _chat_reverse(video_ref: dict, instruction: str, timeout: float,
                        *, user_id: int | None = None, draft_id: int | None = None) -> str:
    """给定 video_url content 块(url 或 file_id 引用), 调火山官方反推, 返回口播文案。已计费。"""
    from ..volc import client as volc_client
    text, usage = await volc_client.chat_understand(
        video_ref=video_ref,
        system_prompt=_REVERSE_SYSTEM,
        user_prompt=instruction,
        timeout=timeout,
    )
    await _record_understand_usage(usage, source="frontcut", user_id=user_id, draft_id=draft_id)
    text = (text or "").strip()
    if not text:
        raise RuntimeError("火山反推返回空内容")
    return text


# 注: 这里原有一个 _upload_file_and_wait 的副本(无调用者), 已于 2026-08-25 删除。
# 它是 volc/client.py:upload_file_and_wait 的旧拷贝, 不支持 TOS 桶模式,
# docstring 还写着"最大 2GB"(实际没传 tos 参数, 走的是 512MB 通道), 留着只会
# 在排查时误导人。真正在跑的是 volc/client.py 那个。



async def reverse_video(
    video_url: str,
    *,
    instruction: str | None = None,
    target_chars: int | None = None,
    fps: float | None = None,
    timeout: float = 600.0,
    local_path: str | None = None,
    oss_key: str | None = None,
) -> str:
    """豆包视频反推, 返回'完整剧情口播文案'。

    ⚠️ 三种传入方式, 上限各不相同(官方文档 82379/1895586, 2026-08-25 实测复核):
      - video_url(URL 直连):        **50 MiB** 硬上限
      - Files API → 方舟托管存储:   **512 MB**(零配置, 默认走这条)
      - Files API → 用户 TOS 桶:    **2 GB**(需 cn-beijing 桶 + 控制台项目授权)

    历史修正: 这段注释原先写"Files API 支持最大 2GB", 但当时代码没传 tos 参数,
    实际走的是 512MB 那条通道。用户上传 1.2 GiB 视频报错, 界面上显示的却是
    "exceeds the limit (50 MiB)" —— 因为 512MB 失败后静默回退到了 URL 直连,
    真实原因只在日志里。别再犯: **大小类失败不要降级**, 降级只会掩盖原因。

    local_path: 本地视频文件路径(优先用它上传 Files API)。
    oss_key: OSS 对象 key(有则下载到本地再走 Files API)。
    video_url: 公网直链(兜底: 无 local_path/oss_key 时用 URL 拉取, 受 50MiB 限制)。
    """
    s = get_settings()
    instr = instruction or _build_narration_instruction(target_chars)
    from ..volc import client as volc_client

    # 主路径: Files API 整片上传(>512MB 时自动切 TOS 桶模式, 上限 2GB)
    tmp_path = None
    try:
        path = local_path
        if not path and oss_key:
            from ..oss import client as _oss
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".mp4")
            tmp.close()
            tmp_path = tmp.name
            await asyncio.to_thread(_oss.get_object_to_file, oss_key, tmp_path)
            path = tmp_path
        if path:
            fid = await volc_client.upload_file_and_wait(path, timeout=timeout)
            ref = {"file_id": fid, "fps": fps if fps is not None else s.ark_video_understand_fps}
            return await _chat_reverse(ref, instr, timeout)
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        # 体积/配额类失败: 回退到 50MiB 的 URL 直连必然也失败, 而且会把真实原因
        # 换成一句误导性的 "exceeds the limit (50 MiB)"。直接抛原始错误。
        if any(k in msg for k in ("512MB", "512 MB", "2 GB", "2GB",
                                  "File size", "exceeds", "ARK_TOS_BUCKET",
                                  "Project Authorization", "cn-beijing")):
            raise
        logger.warning("Files API 反推失败, 回退 URL 直连(受50MiB限制): %s", msg[:200])
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except Exception:  # noqa: BLE001
                pass

    # 兜底: URL 直连(受 50MiB 限制)
    if not (video_url and (video_url.startswith("http://") or video_url.startswith("https://"))):
        raise ValueError("无 local_path/oss_key 且 video_url 非法, 无法反推")
    ref = {"url": video_url, "fps": fps if fps is not None else s.ark_video_understand_fps}
    return await _chat_reverse(ref, instr, timeout)
