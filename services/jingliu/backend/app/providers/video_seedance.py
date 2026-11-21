"""火山方舟 Seedance 2.0 / 2.0 mini 视频生成 Provider。

协议（与主平台 volc/client.py 实测一致）：
- 提交: POST {ark}/contents/generations/tasks  body={"model": <ep>, "content": [...]}
- 查询: GET  {ark}/contents/generations/tasks/{id}  完成时 content.video_url
- 参数走官方 text 尾缀语法: --resolution --duration --ratio --audio
- 多图必须每张带 role（first_frame/last_frame/reference_image），否则 400
  —— 天然支持 i2va/fl2va/l2va/full_reference 全部生成模式。
"""
from __future__ import annotations

import asyncio
import logging
import uuid

from ..config import get_settings
from . import http
from ..media import GENERATED_DIR
from .base import (AudioMode, VideoProvider, VideoRequest, VideoResult, VisualMode,
                   sanitize_video_prompt, to_public_url)

log = logging.getLogger(__name__)

_SEEDANCE_ASPECTS = ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9"]

#: 单次请求的**图片总数**上限（含 first_frame / last_frame / reference_image）。
#: 以及**视频 / 音频参考**的上限。
#:
#: ⚠️ 2026-10-06：这三个数改成**按模型区分**。此前 `_MAX_INPUT_IMAGES = 9` 是
#: 模块级常量，2.0 / 2.0-mini / 2.5 三个模型共用，于是 2.5 也被卡在 9 张——
#: 表现是"参考图过多时把多出来的硬丢弃"（submit() 里 `refs[:room]` 静默截断）。
#: 而 2.5 官方的素材上限是 30 图 / 10 视频 / 10 音频，完全够用。
#:
#: 2026-09-23 对 2.0 的实测标定（当时代码里有三个互不相同的数，没一个是实测来的）：
#:   · `max_reference_images = 4`（2026-08-08 接入时写死，注释称"实测后校准"，
#:     但 git 历史显示从未改过）
#:   · `submit()` 里的 `len(images) > 6` 硬拒
#:   · 官方 2.0 文档 `references/api-doc-rules.txt` §五：「图片 0~9 / 视频 0~3 / 音频 0~3」
#: 实测（用 923 项目已入库的可信资产，full_reference 模式提交）：
#:   9 张 → ✅ 接受    11 张 → ✅ 也接受
#: 即**远端比文档更宽松**，没探到硬上限（每次被接受都会真出片计费，故止步）。
#: 2.0 取 9 而不是更大：它是官方文档值、实测可用，且远超实际需要
#: （最密的战斗镜是 5 角色 + 1 场景 = 6 张）。超出文档范围属未定义行为。
#:
#: 2.5 的 30/10/10 来自官方发布口径（字节跳动 Seed，2026-07-31）；
#: 提示词侧的 `@图片1~30` / `@视频1~10` / `@音频1~10` 编号上限同步。
#:
#: ⚠️ **这不代表"送得越多越好"**。官方多模态参考的推荐配置是
#: 「角色图 1-2 张 + 场景图 1 张」；参考图越多是否真的越好**未经验证**。
#: 所以**自动注入**刻意保持克制（仍按每角色 1 张 + 每场景 1 张），
#: 宽出来的名额留给用户手动 `@` —— 用户点名要的那张，才是确定有用的。
#: 已知的只是：4 张时 5 角色的镜头**一张场景图都挤不进去**（923 实测 17/19 镜
#: 场景图为 0，背景因此从铁塔漂成森林），把场景图放进去必然是改善。
_CAPS_2_0 = {"images": 9, "videos": 0, "audios": 3}
_CAPS_2_5 = {"images": 30, "videos": 10, "audios": 10}
#: 兜底：未知模型按 2.0 的保守值走，宁可少送也不能送超了整镜被打回。
_CAPS_DEFAULT = _CAPS_2_0

#: 查询/取片的**连续**失败容忍次数（2026-10-08）。
#:
#: 与 `video_lowcost._MAX_QUERY_ERRORS` 同值同理由：**查询失败 ≠ 任务失败**。
#: 方舟上的任务不会因为一次 5xx 就消失，它照样在跑、照样会出片、照样计费。
#: 所以瞬时错误只该退避重试，攒够次数才认栽。
#:
#: ⚠️ 这里和其他通道有个**根本差别**：方舟的取消接口
#:    （`DELETE /contents/generations/tasks/{id}`，2026-10-16 查官方文档更正——
#:    此前这里写"方舟没有取消接口"是错的）**只对 `queued` 有效**，`running`
#:    状态删不掉。所以 RunningHub 那套"异常就 cancel"在这里大多兑现不了 ——
#:    一旦从 submit() 抛出去，jobs.py 的重试会**再提交一条新任务**，
#:    而旧的那条钱已花、片子还丢了。故本通道的容错目标是"守住同一个 task_id
#:    轮询到底"，而不是"失败后取消干净"。
_MAX_QUERY_ERRORS = 4


class SeedanceVideoProvider(VideoProvider):
    """Seedance 系（火山方舟异步任务通道）。音画一体，支持首帧/尾帧/参考图。"""

    def __init__(self, model_id: str, ep: str, *,
                 min_duration: int = 4, max_duration: int = 15,
                 poll_interval: float = 10.0, poll_max: int = 120) -> None:
        self.model_id = model_id
        self.ep = ep
        self.visual_mode = VisualMode.reference
        self.audio_mode = AudioMode.inline
        # 官方支持 min_duration..max_duration 连续区间（AI 拆镜动态判定时长直接
        # 下发，不取整到档位）。2.0/2.0-mini 上限 15s；2.5 提到 30s。
        #
        # ⚠️ **下限不是 1**：官方文档（api-doc-rules.txt）写「时长 4~16 秒」，
        #    实测 seedance-2.0-mini 的 r2v（带参考图）变体对 3s 直接 400：
        #      InvalidParameter: the specified duration is not supported
        #      for model doubao-seedance-2-0-mini-r2v
        #    原来 duration_slots 从 1 起、submit() 又 `max(1, ...)` 兜底，等于
        #    宣称 1~3s 合法：AI 拆镜或用户手调只要落到 <4s，这一镜生成时必 400，
        #    且是**出片那一刻**才炸、拆镜阶段毫无预警。故下限收到 min_duration。
        #
        # ⚠️ 这个上限**同时决定解说剧的拆镜粒度**：
        #   duration_slots → base.max_seconds() → routes_v2.shot_seconds_cap()
        #   → narration_max_chars() → 拆解提示词的字数上限
        # 所以给 2.5 配 30 之后，拆解会自动按 25~30s 一段设计，
        # 不需要在拆解侧写任何 if model == "seedance-2.5" 的分支。
        self.min_duration = int(min_duration)
        self.duration_slots = list(range(self.min_duration, max_duration + 1))
        self.max_duration = int(max_duration)      # submit() 钳制用，见其内注释
        self.supports_last_frame = False           # 尾帧模式已下线（2026-11-20），帧图当参考图发
        self.aspect_ratios = list(_SEEDANCE_ASPECTS)
        # 见模块级 `_CAPS_2_0` / `_CAPS_2_5` 的记录。注入侧
        # （jobs._auto_inject_refs_detailed）用 max_reference_images 决定**自动**
        # 最多送几张；用户可以手动 @ 到 caps.images 为止（见 _user_ref_budget）。
        #
        # ⚠️ 改这个值影响面很大：923 实测 4 → 9 之后，5 角色的战斗镜从
        # 「4 张全给角色、场景图一张进不去」变成「5 角色 + 1 场景」，
        # 场景参考图覆盖率 0/8 → 8/8，且原本因"按出场顺序截断"每次被砍掉的
        # 荒兽（画面最大的非人形主体）也终于注入得上。
        self._caps = _CAPS_2_5 if model_id == "seedance-2.5" else _CAPS_DEFAULT
        #: **自动注入**的名额。**2026-10-07 起跟 `_caps["images"]` 走**
        #: （2.5 → 30、2.0 → 9），不再写死 9。
        #
        # ⚠️ 这里推翻的是本模块自己 2026-10-06 的一条决策，理由记全：
        #
        # 当时的写法是「自动注入刻意保持克制（每角色 1 张 + 每场景 1 张），
        # 宽出来的名额留给用户手动 @」，依据是官方推荐配置「角色图 1-2 张 +
        # 场景图 1 张」。那条依据**对普通镜头成立**（2-3 个角色），
        # 但它把"够用"和"被截断"混成了同一个数：
        #
        #   一个镜头 3 个角色  → 注入 3 张，远没到 9，正常；
        #   一个镜头 17 个角色 → 还是只注入 9 张，**静默砍掉 8 个**。
        #
        # 生产实测（2026-10-07，1858 个有角色字段的镜头）有 **47 个（2.5%）**
        # 的"角色+场景"数超过 9，最密的到 17；且超得最狠的几个项目全是官方
        # `seedance-2.5` —— 模型能吃 30 张却只送 9 张。用户反馈的
        # "参考图数量超 9 张被舍弃"就是这条，它**不是 bug，是当时的设计**。
        #
        # 现在改成：**能给的自动全给，@ 用剩下的**。用户点名的那张依然优先
        # 于"没进白名单的图"，但不再靠牺牲在场角色来腾名额 ——
        # 一个 17 角色的镜头里，那 17 张都是**基本盘**，不是"多送"。
        #
        # ⚠️ 上限同时受 `max_input_images`（= 同一个 caps 值）约束：
        # 自动注入不会超过模型硬上限，因为 `_auto_inject_refs_detailed`
        # 拿到多少就最多注入多少，而调用方传进来的就是这两个数里合适的那一个。
        self.max_reference_images = self._caps["images"]
        # 参考音频（音色参考）：官方 2.0 支持 0~3 个，2.5 提到 0~10 个。
        # ⚠️ 这里原本写死 False 并在 submit() 里直接 return failed，理由写的是
        #    "音画一体自带声音"——那是把"能自己配音"误当成"不能指定音色"。
        #    后果：给人物上传的音色永远到不了模型，且**静默**（上层只把该镜标失败）。
        #    2026-09-10 实测方舟接口证实支持，报错原文见 _build_audios 注释。
        self.supports_reference_audio = True
        self.max_reference_audios = self._caps["audios"]
        # 官方 2.5 起支持参考视频（0~10 段），但**接入工作未做**：
        # 没有上传通道、没有 VideoRequest 字段、没有 @视频N 编号。
        # 保持 False 是诚实的——宣称 True 会在 submit() 里走到未实现的分支。
        self.supports_reference_video = False
        #: 单次请求的**素材硬上限**（图片含首尾帧）。submit() 据此截断。
        self.max_input_images = self._caps["images"]
        self.poll_interval = poll_interval
        self.poll_max = poll_max
        # 官方方舟是本项目里**唯一**需要"可信资产入库"绕人脸审核的通道，
        # 也**唯一**用 seedance2 提示词框架（见 base.py 的同名字段注释：
        # 这两件事以前靠 model_id 前缀猜，第三方渠道接进来后必须显式声明）。
        # 走统一网关时由网关自动入库，这里关掉（见 config.ark_trusted_assets）。
        self.uses_ark_trusted_assets = bool(get_settings().ark_trusted_assets)
        self.prompt_framework = "seedance2"
        #: 官方通道只有 480p/720p/1080p 三档（submit() 里按 MP 反推）。
        #: **没有 2k** —— 项目里选 2k 出来仍是 1080p，且不报错。所以在这里
        #: 如实声明，前端据此把 2k 列出来但禁用并说明，而不是让用户以为选了就生效。
        self.supported_resolutions = ["480p", "720p", "1080p"]

    def resolution_for(self, megapixels: float | None) -> str | None:
        """与 submit() 里那段映射**逐字一致**（唯一真源，不许各写一份）。

        submit() 的判据是 `mp = req.megapixels or 0.9`，然后
        `≤0.5→480p / ≤1.2→720p / 其余→1080p`。这里必须复刻**同一个数**，
        否则界面上显示"实际按 1080p 出"，而下游按 720p 下发了。
        """
        mp = megapixels or 0.9
        return "480p" if mp <= 0.5 else "720p" if mp <= 1.2 else "1080p"

    def mode_support(self) -> dict[str, dict]:
        """纯文本与全能参考（可带参考音频，无参考视频）。

        首帧 / 首尾帧 / 尾帧三种模式已于 2026-11-20 下线（见 base.GENERATION_MODES）：
        要指定开头或结尾画面，把那张图当参考图给，本通道一律按 `reference_image` 发。

        `reference_audio` 逐模式给：官方明确「不支持"文本+音频"、"纯音频"输入」
        （api-doc-rules.txt「输入素材数量限制」），故 **t2va 不能带音频**——
        纯文本镜头若硬塞音色参考会被接口 400 打回。全能参考至少有一张图，可带。
        """
        return {
            "t2va": {"available": True, "reference_audio": False},
            "full_reference": {"available": True, "reference_audio": True,
                               "reference_video": False},
        }

    def _cfg(self) -> tuple[str, str]:
        s = get_settings()
        key = (s.ark_api_key or "").strip()
        if not key:
            raise RuntimeError("FW_ARK_API_KEY 未配置")
        return key, s.ark_base_url.rstrip("/")

    @staticmethod
    def _build_images(req: VideoRequest) -> list[dict]:
        """组装图片列表，**一律是参考图**（`reference_image`）。

        首帧 / 尾帧角色不再下发（2026-11-20 下线）。出片流程已把镜头上的帧图并进
        `reference_image_urls`；这里对 `first_frame_url` / `last_frame_url` 再兜一层
        （别的调用方直接填了这两项时），同样当参考图发，排在参考图**之后**——
        提示词里的 `@图片N` 是按参考图顺序编的号，帧图插到前面会让编号整体错位。

        URL 一律绝对化：方舟是"把 URL 交给远端自己拉"，相对地址到对端即死链。
        """
        urls = list(req.reference_image_urls or [])
        for frame in (req.first_frame_url, req.last_frame_url):
            if frame and frame not in urls:
                urls.append(frame)
        return [{"url": to_public_url(u), "role": "reference_image"} for u in urls]

    @staticmethod
    def _build_audios(req: VideoRequest, cap: int) -> list[dict]:
        """组装参考音频（音色参考）content 分片。

        形状是 2026-09-10 直接问接口问出来的，两次探测的原文报错：
          1. `{"type":"audio_url_xyz"}` → “supported values are: `text`,
             `image_url`, `audio_url`, `video_url` and `draft_task`”
             —— 确认字段名就是 `audio_url`，与 image_url 同构。
          2. `{"type":"audio_url","audio_url":{...}}`（不带 role）→
             “reference media mode requires audio role to be reference_audio”
             —— 确认 **role 必填且只能是 reference_audio**，漏了就 400。
        文档页当时抓不到（沙箱不放行 docs.volcengine.com），故以接口自身为准。

        URL 同样要绝对化：方舟是把 URL 交给远端自己拉，相对地址到对端即死链。

        ⚠️ 2026-10-06：改为支持**多段**。官方 2.0 是 0~3 段、2.5 是 0~10 段，
        而这里此前只发 `req.reference_audio_url` 一段。多段的价值在于
        `@音频N` 能与不同角色对应（文档 §四：「「角色」说："台词"，音色参考「音频N」」），
        所以上层 `_auto_inject_voice_ref` 里"只取戏份最重那一个"的克制可以放宽
        ——那条注释的前提是"多段无法与角色对应"，有了 @ 编号之后不再成立。

        ⚠️ 2026-10-07：**上限改为显式入参 `cap`**，不再读 `self`。
        前一天那次改动把 `self.max_reference_audios` 写进了这个 `@staticmethod`
        里，于是 `_build_audios` **一进循环头就 NameError**，且因为切片表达式
        先求值，**连"没有音色"的镜头也一样崩** —— 表现就是全项目分镜视频
        100% 生成失败、报 `生成失败·other NameError("name 'self' is not defined")`。
        教训：`@staticmethod` 里出现 `self` 是硬错误，本该被 lint（E0210/F821 类）
        拦下，但本仓既无 lint 也无 CI，一路漏到了生产。已加
        `backend/scripts/check_self_misuse.py` 补上这道闸。改成静态方法**不读任何
        实例状态**，以后不会再退化成依赖 `self`。
        """
        out: list[dict] = []
        # 列表优先，空则回退单值（兼容只填了单值的旧调用方与镜头高级设置）
        urls = list(req.reference_audio_urls or [])
        if not urls and req.reference_audio_url:
            urls = [req.reference_audio_url]
        for u in urls[:cap]:
            pub = to_public_url(u)
            if pub:
                out.append({"type": "audio_url", "audio_url": {"url": pub},
                            "role": "reference_audio"})
        return out

    async def submit(self, req: VideoRequest) -> VideoResult:
        key, base = self._cfg()
        if req.reference_video_url:
            return VideoResult(status="failed", error="Seedance 通道不支持参考视频")

        seconds = int(round((req.duration_ms or 5000) / 1000))
        # ⚠️ 这里原本写死 `min(15, seconds)`，把构造参数 max_duration **只用在
        #    规划侧、请求侧直接忽略**，于是 seedance-2.5 出现了一条静默劈叉：
        #      duration_slots(1..30) → max_seconds() → shot_seconds_cap()
        #        → 拆镜按 25~30s 设计单镜
        #      submit() → 写死钳到 15 → 实际只出 15.07s
        #    2026-09-04 的真人剧验证片实测：29 镜里 **17 镜**计划 16~29s、
        #    实际全是 15.07s，且 145 条字幕里 32 条落在视频结束之后（最长的一镜
        #    计划 29.3s，尾部 14.2s 的台词根本没画面）。全程无任何报错——
        #    因为 Shot.duration_sec 保留的是未钳制的计划值，没人回头对过实测时长。
        #    改为跟着 max_duration 走：2.0/2.0-mini 仍是 15（range(1,16) 最大值），
        #    行为完全不变；只有显式声明了更大上限的通道才会真的下发更长时长。
        #
        # 下限同理跟着 min_duration 走（原来写死 1）：官方最短 4s，传 1~3 会被
        # 接口 400 打回（报错原文见 __init__ 注释）。时间轴上允许存在 2s 的短镜
        # ——那是剪辑自由——但**下发时必须抬到 4s**：出一条 4s 的片再由取片窗口
        # 裁到 2s，远好过整镜生成失败。
        seconds = max(self.min_duration, min(self.max_duration, seconds))
        aspect = req.aspect_ratio if req.aspect_ratio in _SEEDANCE_ASPECTS else "9:16"
        # 分辨率：由项目档位 megapixels 近似映射回 p 档（Seedance 用 p 档语法）
        mp = req.megapixels or 0.9
        resolution = "480p" if mp <= 0.5 else "720p" if mp <= 1.2 else "1080p"

        tail = f" --resolution {resolution} --duration {seconds} --ratio {aspect} --audio true"
        # 净化：拆掉【】(=Seedance 的"烧字幕"语法) + 补无文字约束。见 base.sanitize_video_prompt
        body = sanitize_video_prompt(req.prompt.strip()) or req.prompt.strip()

        images = self._build_images(req)
        # 上限是**图片总数**（含首帧/尾帧），而 `_build_images` 里
        # first_frame / last_frame 同样占位。所以不能只按 reference 数量算：
        # 9 张参考图 + 1 张首帧 = 10 张，照样 400。
        #
        # ⚠️ 原来这里写死 `> 6` 直接判失败，与 max_reference_images(当时是 4)、
        # 与官方文档的 9 三个数互不相同，且超限就整镜失败。
        # 现在改为**截掉多余的 reference_image**：首帧/尾帧是结构性的（决定画面
        # 起止），参考图是一致性辅助，多出来的那几张少送远好过整镜被打回。
        #
        # ⚠️ 2026-10-06：上限改为按模型取（2.0=9，2.5=30）。此前是模块级常量 9，
        # 2.5 也被卡在 9 张，超出的静默丢弃——这就是"参考图过多时硬丢弃"的来源。
        # 正常路径下**不该走到这里**：上层按 caps 已经算好了预算
        # （见 jobs._user_ref_budget），此处只是最后一道防线。
        cap = getattr(self, "max_input_images", _CAPS_DEFAULT["images"])
        if len(images) > cap:
            keep = [i for i in images if i["role"] != "reference_image"]
            refs = [i for i in images if i["role"] == "reference_image"]
            room = max(0, cap - len(keep))
            log.warning("[seedance] 图片总数 %d 超上限 %d（%s），截掉 %d 张参考图",
                        len(images), cap, self.model_id, len(refs) - room)
            images = keep + refs[:room]
        # 参考音频（音色）：官方不收「纯文本+音频」「纯音频」输入
        # （api-doc-rules.txt「输入素材数量限制」），一张图都没有时直接不带——
        # 少一个音色远好过整镜被 400 打回。
        # 上限只在 `_build_audios` 里截一次（cap 传进去）；外面**不再重复切片**——
        # 同一个上限写两处，改一处漏一处的老毛病就是这么来的。
        audios = self._build_audios(req, self.max_reference_audios) if images else []
        if audios:
            # 参考音频只有被提示词**点名**才会当音色用（typical-effect-cases 3.8：
            # 「Prompt 中准确指定参考音频」「整个视频主角的音色必须参考音频1」）。
            # 只送 audio_url 不写这句，模型可能当背景音甚至忽略。恒定只发一段，
            # 故写死"音频1"；接在正文之后、--尾缀之前，不影响 flag 解析。
            body = f"{body.rstrip()}".rstrip("。") + "。整个视频主角的音色必须参考音频1。"

        content: list[dict] = [{"type": "text", "text": f"{body}{tail}"}]
        for img in images:
            part: dict = {"type": "image_url", "image_url": {"url": img["url"]}}
            part["role"] = img["role"]       # 一律 reference_image，单图也显式写
            content.append(part)
        content.extend(audios)

        headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
        try:
            c = http.get(base, timeout=120.0)
            r = await c.post(f"{base}/contents/generations/tasks",
                             headers=headers,
                             json={"model": self.ep, "content": content})
        except Exception as e:  # noqa: BLE001
            return VideoResult(status="failed", error=f"提交失败: {e!r}")
        if r.status_code not in (200, 201):
            return VideoResult(status="failed",
                               error=f"HTTP {r.status_code}: {r.text[:300]}")
        tid = (r.json().get("id") or r.json().get("task_id"))
        if not tid:
            return VideoResult(status="failed", error=f"未返回任务 id: {r.text[:200]}")

        meta = {"ep": self.ep, "resolution": resolution, "duration": seconds,
                "ratio": aspect, "images": [i["role"] for i in images],
                "audios": len(audios)}
        # 轮询至出片（与其他通道行为一致）
        #
        # ⚠️ 这里是**唯一会重复扣费**的一段，2026-10-08 补的保护。
        #    原实现把 `_query` / `_download` 裸放在循环里，而 `_query` 在非 200
        #    时 `raise RuntimeError`。后果不是"这一镜失败"那么轻：
        #
        #      submit() 抛异常 → jobs.py 的 `except Exception: continue`
        #      → 重试循环**再调一次 submit()** → 方舟上开出**第二条任务**，
        #        第一条从未取消、出片后照旧计费。
        #
        #    也就是说：一次瞬时 5xx 就能让同一镜生成两遍、付两份钱，而用户
        #    界面看起来完全正常（只有账单多一行）。
        #    对照：video_runninghub 一直有 try/except + cancel，
        #    video_lowcost 一直有 `_is_transient_query_error` 计数；只有这一条裸着。
        #
        # 为什么**不**照抄 RunningHub 的 `except → cancel(task_id)`：
        #    方舟的 DELETE 只能取消 `queued` 的任务，`running` 删不掉
        #    （2026-10-16 查官方文档更正，此前误写成"没有取消接口"）。
        #    任务一旦开跑就会跑完并计费，所以"异常就取消"大多是无法兑现的承诺。
        #    能做且真正省钱的是：**自己别退出去**。任务已经在跑了，只要守住
        #    这个 task_id 轮询到底，钱就不会白花；一旦抛出去，钱花了、片子还丢了。
        #    故改为"查询失败退避重试，连续失败够多/轮询超时才放弃"。
        from .. import usage as _usage
        # 派发即记账（2026-10-16）：一行「已派发、未结算」。方舟在用户取消后
        # 仍会跑完并计费（running 删不掉），没有这一行，那份钱在账上是空白。
        _usage.record_dispatch("video", task_id=str(tid), model_id=self.model_id,
                               channel="ark", resolution=resolution,
                               media_seconds=seconds)
        qfail = 0                                  # 连续查询失败次数
        cancel_tried = False
        for _ in range(self.poll_max):
            await asyncio.sleep(self.poll_interval)
            # ---- 用户取消（2026-10-16）----
            # 只试一次 DELETE：排队中（queued）→ 真取消，一分不花；
            # 已开跑（running）→ 方舟拒绝，那就**继续守到出片**，按实测 token 收
            # （钱反正已经花了，退出去只会把片子也丢掉）。
            if not cancel_tried and _usage.cancel_requested():
                cancel_tried = True
                if await self._cancel_queued(str(tid), key, base):
                    _usage.settle_dispatch_free("video", task_id=str(tid),
                                                model_id=self.model_id, channel="ark",
                                                reason="排队中被取消")
                    return VideoResult(status="failed", task_id=str(tid),
                                       error="已取消", raw={**meta, "cancelled": True})
                log.info("[seedance] 任务 %s 已开跑、无法取消，继续守到出片", tid)
            try:
                st = await self._query(str(tid), key, base)
            except Exception as e:  # noqa: BLE001
                qfail += 1
                log.warning("[seedance] 查询失败 %d/%d（task=%s）：%s",
                            qfail, _MAX_QUERY_ERRORS, tid, e)
                if qfail >= _MAX_QUERY_ERRORS:
                    return VideoResult(status="failed", task_id=str(tid),
                                       error=f"连续 {qfail} 次查询失败: {e!r}",
                                       raw=meta)
                continue
            qfail = 0
            if st["status"] == "SUCCEEDED" and st.get("video_url"):
                # 记账放在取片**之前**：远端已出片计费，取片失败也改变不了这一点。
                self._record_usage(str(tid), meta, st.get("usage"), ok=True)
                # 出片已在远端完成、**这一份钱已经花了**：下载失败绝不能
                # 让它冒出去触发上游重试。退避重试，够次数仍失败才放弃。
                for attempt in range(_MAX_QUERY_ERRORS):
                    try:
                        local = await self._download(st["video_url"])
                        return VideoResult(status="done", task_id=str(tid),
                                           video_url=local,
                                           duration_ms=seconds * 1000,
                                           raw={**meta, "usage": st.get("usage")})
                    except Exception as e:  # noqa: BLE001
                        log.warning("[seedance] 取片失败 %d/%d（task=%s）：%s",
                                    attempt + 1, _MAX_QUERY_ERRORS, tid, e)
                        if attempt < _MAX_QUERY_ERRORS - 1:
                            await asyncio.sleep(min(10.0, 2.0 ** attempt))
                return VideoResult(status="failed", task_id=str(tid),
                                   error="出片成功但下载失败（已在远端计费，"
                                         "可到方舟控制台取片，或重试本镜）",
                                   raw=meta)
            if st["status"] in ("FAILED", "CANCELLED", "EXPIRED"):
                self._record_usage(str(tid), meta, st.get("usage"), ok=False)
                return VideoResult(status="failed", task_id=str(tid),
                                   error=f"任务 {st['status']}: {st.get('reason', '')[:200]}",
                                   raw=meta)
        return VideoResult(status="failed", task_id=str(tid),
                           error=f"轮询超时(>{int(self.poll_interval * self.poll_max)}s)",
                           raw=meta)

    def _record_usage(self, task_id: str, meta: dict, u: object, ok: bool) -> None:
        """Seedance 用量：按官方 token 价（「不含视频输入」档，2.0/2.5 分开）。"""
        from .. import usage
        u = u if isinstance(u, dict) else {}
        usage.record("video", model_id=self.model_id, channel="ark", ok=ok,
                     task_id=task_id,
                     prompt_tokens=u.get("prompt_tokens"),
                     completion_tokens=u.get("completion_tokens"),
                     total_tokens=u.get("total_tokens"),
                     media_seconds=meta.get("duration"),
                     resolution=meta.get("resolution"),
                     meta={"task_id": task_id, "ratio": meta.get("ratio")})

    @staticmethod
    async def _cancel_queued(task_id: str, key: str, base: str) -> bool:
        """取消一个**排队中**的方舟任务。成功 = 真的没开跑、不会计费。

        官方语义（2026-10-16 查证）：`queued` → 移出队列、转 cancelled；
        `running` → 拒绝；已终态 → 删记录（那不是取消）。所以先查状态，
        只在 queued 时才发 DELETE —— 对已完成的任务发 DELETE 会把记录删掉，
        之后连片子都查不到了。
        """
        try:
            st = await SeedanceVideoProvider._query(task_id, key, base)
            if st.get("status") != "QUEUED":
                return False
            headers = {"Authorization": f"Bearer {key}"}
            c = http.get(base, timeout=30.0)
            r = await c.delete(f"{base}/contents/generations/tasks/{task_id}",
                               headers=headers)
            return r.status_code in (200, 204)
        except Exception as e:  # noqa: BLE001 —— 取消不成就当没取消，继续守
            log.warning("[seedance] 取消任务 %s 失败：%r", task_id, e)
            return False

    @staticmethod
    async def _query(task_id: str, key: str, base: str) -> dict:
        headers = {"Authorization": f"Bearer {key}"}
        c = http.get(base, timeout=60.0)
        r = await c.get(f"{base}/contents/generations/tasks/{task_id}", headers=headers)
        if r.status_code != 200:
            raise RuntimeError(f"查询 HTTP {r.status_code}: {r.text[:200]}")
        d = r.json()
        content = d.get("content") or {}
        return {"status": (d.get("status") or "").upper(),
                "video_url": (content.get("video_url") if isinstance(content, dict) else None)
                             or d.get("video_url"),
                "usage": d.get("usage"),
                "reason": str(d.get("error") or d.get("message") or "")}

    @staticmethod
    async def _download(remote: str) -> str:
        name = f"sd_{uuid.uuid4().hex[:12]}.mp4"
        dest = GENERATED_DIR / name
        # 分组键不能传 remote —— 每条片子的地址都不一样，会按 URL 无限堆积客户端。
        c = http.get("download", timeout=600.0, follow_redirects=True)
        async with c.stream("GET", remote) as resp:
            resp.raise_for_status()
            with dest.open("wb") as w:
                async for chunk in resp.aiter_bytes(1024 * 256):
                    w.write(chunk)
        return f"/fw/media/generated/{name}"

    async def poll(self, task_id: str) -> VideoResult:
        key, base = self._cfg()
        st = await self._query(task_id, key, base)
        if st["status"] == "SUCCEEDED" and st.get("video_url"):
            local = await self._download(st["video_url"])
            return VideoResult(status="done", task_id=task_id, video_url=local)
        if st["status"] in ("FAILED", "CANCELLED", "EXPIRED"):
            return VideoResult(status="failed", task_id=task_id, error=st.get("reason"))
        return VideoResult(status="running", task_id=task_id)
