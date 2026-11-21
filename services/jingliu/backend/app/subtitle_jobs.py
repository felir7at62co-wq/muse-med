"""自动字幕（TB-08）：把**实际发声的那条音轨**转写成字幕段落。

## 为什么从 jobs.py 搬出来

它本来就是个**外挂**：`jobs.py` 底部用 `RUNNERS["auto_subtitles"] = ...`
单独补登记，而不是写进 `RUNNERS` 字面量里 —— 那一行就是"它跟上面那批不是
一批"的自白。整块（4 个纯函数 + 1 个 runner + 4 个常量）与 jobs.py 其余部分
只有 5 个符号的往来（`get_job` / `_update` / `set_job_phase` / `get_session` /
`Shot`），搬出来不需要动任何调用方。

搬家的直接动因是架构守卫：`jobs.py` 的行数预算只剩 1 行余量，而「去字幕」
要往 `RUNNERS` 里加两条。守卫的规矩是"要么把东西放到别处，要么先还债再加"
—— 这里选的是还债。**一行逻辑都没改**，纯位移。

`backend/scripts/verify_asr_subtitles.py` 的 import 跟着改到这里：断言跟着
实现走，不是放宽 —— 它钉的三件事（音源选择 / 切句 / 洗标点）一条没少。
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid

from .db import Shot, get_session
# ⚠️ **不在这里** `from .jobs import ...`。模块图必须是单向的：
# jobs（文件末尾）→ subtitle_jobs，反向只能发生在**调用时**。写成模块级
# 双向 import 的话，谁先被 import 谁就炸 —— 实测 `verify_asr_subtitles.py`
# 直接 import 本模块，正好是先炸的那一侧。runner 里那三个符号改用函数内
# import（与它本来就有的 config/db/media 局部 import 同款）。

log = logging.getLogger(__name__)


#: 一条字幕最多放几个字。竖屏 1080 宽、默认字号 48（TextPanel 的 BASE_STYLE）
#: 一行约装 20 个汉字；再长 libass 会折行或顶出安全区。
_CUE_MAX_CHARS = 20
#: 一条字幕最短显示多久。低于这个数眼睛来不及扫到。
_CUE_MIN_SEC = 0.5
#: 断句点。**空格也算**：Whisper 中文分段的 text 常用空格分隔小句
#: （实测 "林小姐 我知道你不想嫁 但我有两个条件"），不认它就切不开。
_CUE_BREAKS = "，。！？；：、,.!?;: …—\n\t "
#: 出字幕前要洗掉的符号。**烧进画面的字幕不带标点**是短剧字幕的通行做法：
#: 一行只有十几个字、停顿由分条本身表达，标点只是占位置的噪点。
#: 想要标点的用户可以在文本面板里自己加（手动添加的字幕一个字都不动）。
#:
#: 只洗"断句/引述"这一类。**刻意保留** `·`（人名里的间隔号，「阿·晨」）、
#: `%`、`+`、`-`、`&`、`#`、`/`、字母与数字 —— 那些是内容，不是标点。
_CUE_DROP_PUNCT = (
    "，。！？；：、…‥—～﹏"                        # 中文断句
    "\"'“”‘’「」『』《》〈〉【】〔〕（）()[]{}"      # 引号与括号
    ",.!?;:"                                       # 半角断句
)


def _wash_punct(s: str) -> str:
    """洗掉标点，只留能读的内容。

    标点位置换成一个空格而不是直接删：句中的停顿（「朋友啊，快坐」）删掉逗号后
    要是粘成「朋友啊快坐」就读不出那个停顿了，留个空格正好是字幕里表达停顿的写法。
    首尾的空格随后被 strip 掉，所以「你就不再是我爹了。」出来就是干净一句。
    """
    out = "".join(" " if ch in _CUE_DROP_PUNCT else ch for ch in s)
    return " ".join(out.split())


def _split_cue(text: str, start: float, span: float) -> list[tuple[str, float, float]]:
    """把 ASR 的一条分段切成若干条**能读完**的字幕。

    返回 [(文本, 起点秒, 时长秒)]，起点相对于传入的 start。

    为什么必须有这一步：ASR 的分段边界是**声学**的（一口气说到哪算一段），
    不是阅读单位。实测 whisper 会把 26 秒 55 个字回成一条
    （「小雨你认识阿晨多久了也不算久那孩子是不是很闷…」），烧进画面就是
    满屏文字糊一片；反过来若那条的 end 缺失，又会变成 0.3 秒一闪而过。
    两种都不是"时间算错了"，是"一条字幕装了不该装的量"。

    切法：按标点/空格切成小句 → 贪心装箱到 ≤ _CUE_MAX_CHARS →
    **洗掉标点** → 时长**按字数比例**分摊。比例分摊只在一条分段内部做，
    跨分段不动，所以整体时间轴仍然锚在 ASR 测出来的声学位置上，不会累积漂移。

    ⚠️ 洗标点必须排在**装箱之后**：标点正是切分的依据（whisper 的标点是
    这里唯一可靠的断句信号，见 asr.py 的实测表），先洗就没得切了；
    也必须排在**分摊时长之前**，否则按洗前的字数分摊、按洗后的字数显示，
    两边不是同一个权重，时长和会对不上原分段跨度。
    """
    text = text.strip()
    if not text:
        return []
    span = max(span, _CUE_MIN_SEC)
    # 短句直接洗完出。注意长度判断用**洗后**的字数：「你就不再是我爹了。」
    # 这种一逗一句的短句洗完更短，没有理由因为标点占了名额而被切开。
    washed = _wash_punct(text)
    if not washed:
        return []                      # 整段只有标点（ASR 偶尔回 "。"）
    if len(washed) <= _CUE_MAX_CHARS:
        return [(washed, start, span)]

    # ① 切小句：断句符跟在前一句尾部（读起来才完整），空格丢掉
    pieces: list[str] = []
    buf = ""
    for ch in text:
        if ch in _CUE_BREAKS:
            if ch.strip():
                buf += ch
            if buf.strip():
                pieces.append(buf.strip())
            buf = ""
        else:
            buf += ch
    if buf.strip():
        pieces.append(buf.strip())

    # ② 没有任何标点的长句（AI 语音常见）只能硬切，否则整条塞不进画面
    flat: list[str] = []
    for pc in pieces:
        while len(pc) > _CUE_MAX_CHARS:
            flat.append(pc[:_CUE_MAX_CHARS])
            pc = pc[_CUE_MAX_CHARS:]
        if pc:
            flat.append(pc)

    # ③ 贪心装箱：能并进一条就并，避免切得过碎（碎字幕比长字幕更难读）。
    #    并的时候若上一句尾部**没有标点**，补一个空格 —— 小句边界原本是空格
    #    （whisper 中文常用空格分句），直接粘起来会变成
    #    「林小姐我知道你不想嫁但我有两个条件」，读起来比切碎更糟。
    chunks: list[str] = []
    for pc in flat:
        if chunks:
            glue = "" if chunks[-1][-1] in _CUE_BREAKS else " "
            if len(chunks[-1]) + len(glue) + len(pc) <= _CUE_MAX_CHARS:
                chunks[-1] += glue + pc
                continue
        chunks.append(pc)
    if not chunks:
        return [(washed, start, span)]

    # ④ 洗标点。装箱已经完成，标点的活儿（提供切分点、保证并句可读）干完了，
    #    留在画面上只是噪点。洗完可能有整条化为空（如小句就是一个 "。"），
    #    直接丢掉；剩下的时长照新字数重新分摊，所以丢掉的那条不会留下空洞。
    chunks = [w for w in (_wash_punct(c) for c in chunks) if w]
    if not chunks:
        return []

    # ⑤ 时长按字数比例分摊
    total = sum(len(c) for c in chunks)
    out: list[tuple[str, float, float]] = []
    t = start
    for c in chunks:
        d = span * len(c) / total
        out.append((c, t, d))
        t += d
    return out


def _pick_asr_source(
    mode: str,
    narration: list[tuple],
    videos: list[tuple],
) -> tuple[list[tuple], bool, str]:
    """选转写音源，返回 (targets, from_video, 人话标签)。

    抽成纯函数是因为**这段判断错过一次，代价是整个模式没有字幕功能**
    （见 run_auto_subtitles 的文档）。它没有 IO，可以直接表驱动验证，
    不必起后端、不必花 ASR 的钱。
    """
    if mode == "drama" or not narration:
        return videos, True, "镜头原声"
    return narration, False, "旁白"


async def _extract_asr_audio(video):
    """把镜头视频的声音剥成 ASR 用的临时文件。

    返回临时文件路径；**该镜头没有音轨时返回 None**（不是故障，是这一镜本来
    就没人说话）；提取失败抛异常（那才是故障，要计入失败数）。

    为什么不把 mp4 原样交给 Whisper（ASRProvider 的 mime 表本来就认 video/mp4）：
      · 一个 720p 镜头几 MB，几百镜就是几 GB 的上传，慢且贵；16kHz 单声道
        mp3 只有几十 KB，对 Whisper 的识别质量没有差别。
      · 25MB 是 provider 会直接抛的硬墙，长镜头撞得到。
      · 先 ffprobe 一次就能筛掉**无音轨**的镜头（AI 生成的视频很常见），
        那些镜头连一次 API 调用都不该花。
    """
    import os
    import tempfile
    from pathlib import Path

    from .media import WORK_DIR, _has_audio, _run

    if not await _has_audio(video):
        return None
    # ⚠️ 临时文件必须落在 **DATA_DIR 之内**（2026-10-23 修）。
    #
    # 此前用 `tempfile.mkstemp()` 落在系统 /tmp，而百炼 Paraformer 只接受
    # **公网 URL**（录音文件识别没有上传接口）。`_public_url` 要求文件能相对
    # DATA_DIR 表达出来才能推桶/拼 9080 地址，/tmp 不在里面 —— 于是每一镜都抛
    # "音频不在素材目录下，无法提供公网地址"，8 镜全挂、一条字幕都没生成。
    #
    # 放 `work/asr-*` 就够了：`work/` 已在 media.py 建好，且刻意不在
    # `tos_dirs`（generated/uploads）里 —— 它不进桶，只在需要公网地址时
    # 由 `_public_url` 的 `storage.put_file` 按需推一次，调用方用完即删。
    #
    # 仍然用 mkstemp（不自己拼名字）：并发跑几十镜时自拼名字会撞。
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(suffix=".mp3", prefix="asr-", dir=str(WORK_DIR))
    os.close(fd)
    out = Path(tmp)
    code, msg = await _run([
        "ffmpeg", "-y", "-i", str(video),
        "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", str(out),
    ], timeout=180.0)
    if code != 0 or not out.exists() or out.stat().st_size == 0:
        out.unlink(missing_ok=True)
        raise RuntimeError(f"提取音轨失败：{(msg or '')[-160:]}")
    return out


#: 一镜里有这么多字的台词没被念出来，就列进「请人看一眼」的清单。
_REVIEW_UNSPOKEN_CHARS = 4
#: 「请人看一眼」的清单最多列多少镜（`review_count` 是全部镜数，各项字数也都是全部的）：
#: 先列和剧本对不上的，最多 `_REVIEW_MISMATCH_MAX` 镜；只按剧本改过字的补到 `_REVIEW_MAX` 镜为止。
#: 整个项目跑一遍时几乎每镜都有改过的字（「2」→「两」、同音字），按镜号截断会把后面对不上的挤掉。
_REVIEW_MAX = 60
_REVIEW_MISMATCH_MAX = 300
#: 任务提示里最多点名几个和剧本对不上的镜头（全部在 `script_check.review` 里）。
_WARN_ORDERS_MAX = 20


def _mismatch_reason(st: dict) -> str | None:
    """这一镜念的和剧本对不上、要请人看一眼的原因；没有就返回 None。

    列进来的：什么都没听到（剧本却有台词）、和剧本差得多（`deviated`）、
    没念出来的台词有 `_REVIEW_UNSPOKEN_CHARS` 个字以上、读音不同而按听到的保留（`differs`）、
    分不出是听错还是念了别的字而按听到的保留（`doubts`，规则见 `subtitle_align`）。
    其余多念的字、零星几个没念的字只记在字数里；剧本里没有台词的镜头由调用方整个任务报一次。
    """
    why = []
    if st.get("unheard"):
        why.append(("视频没有音轨" if st.get("no_audio") else "没有识别出说话声")
                   + f"，剧本里这一镜有 {st['unspoken']} 个字的台词")
    elif st.get("deviated"):
        why.append("念的内容和剧本差得多，没按剧本改")
    elif st.get("unspoken", 0) >= _REVIEW_UNSPOKEN_CHARS:
        why.append(f"剧本里有 {st['unspoken']} 个字的台词没念出来")
    if st.get("differs"):
        why.append("念的字和剧本不同、读音也不同，按听到的保留："
                   + "、".join(f"{d['heard']}（剧本是{d['script']}）" for d in st["differs"]))
    if st.get("doubts"):
        why.append("分不出是听错还是念的就和剧本不同，按听到的保留："
                   + "、".join(_doubt_text(d) for d in st["doubts"]))
    return "；".join(why) or None


def _doubt_text(d: dict) -> str:
    """`doubts` 的一处写给人看：没念的、多念的、对不上的三种说法。"""
    if not d["heard"]:
        return f"没念「{d['script']}」"
    if not d["script"]:
        return f"多念了「{d['heard']}」"
    return f"{d['heard']}（剧本是{d['script']}）"


def _fix_note(st: dict) -> str | None:
    """这一镜按剧本改了哪些字；一处没改返回 None。"""
    if not st.get("fixes"):
        return None
    return "按剧本改了读音相同的字：" + "、".join(f"{f['heard']}→{f['script']}" for f in st["fixes"])


async def run_auto_subtitles(jid: str) -> None:
    """TB-08 自动字幕：把**实际发声的那条音轨**转写成字幕段落。

    payload = {"project_id": "...", "replace": false, "episode": null, "align_script": true}

    - `episode`：只做这一集（`replace` 也只清这一集的自动字幕）；不填 = 整个项目。
    - `align_script`：镜头原声转写完，用这一镜剧本里的台词逐字纠正（`subtitle_align`）：
      读音相同的人名、同音字和数字写法换成剧本的字，时间与断句仍来自声音；没念的台词不补，
      多念的保留。纠正不调语言模型，只在转写镜头原声时做（旁白不纠正）。
      要人看一眼的镜头在结果的 `script_check.review` 里：先列 `_mismatch_reason` 列出的，
      再列只按剧本改过字的（条数上限见 `_REVIEW_MAX`），`review_count` 是全部条数；
      剧本里没有台词的镜头只数在 `no_script_shots` 里，任务的提示里说一次。

    为什么走 job：Whisper 单段几秒到几十秒，一个项目几十条旁白就是分钟级，
    同步接口必撞 nginx 504。

    ## 音源按生产模式选（6.0 修「真人剧几乎没有字幕 / 字幕与音频不匹配」）

    | 模式 | 声音在哪 | 转写对象 |
    |---|---|---|
    | 解说剧 narration | TTS 旁白（audio_clips） | 旁白音频 |
    | **真人剧 drama** | **镜头视频自带的音轨**（seedance 音画一体） | **镜头视频** |

    原实现只转写 audio_clips，且注释把理由写成"AI 生成的镜头视频大多无人声
    （有的连音轨都没有），逐个下载转写既慢又白花钱"。**那个判断只对解说剧成立**
    ——解说剧的镜头视频是无声 b-roll，声音全在 TTS 旁白里。真人剧恰好相反：
    音画由视频模型一体生成，**台词只存在于镜头视频的音轨里，且 audio_clips
    恒为空**。于是真人剧项目走到这里永远是
    「没有可识别的旁白音频。请先在「音频」面板合成 AI 配音。」——
    一句对真人剧根本无法执行的建议（真人剧没有那一步）。

    结果是**真人剧在产品里压根没有字幕生成路径**。用户看到的字幕问题因此都是
    "字幕不是从声音来的"派生出来的：
      · 台词与音频不同步 —— 时间码是按字数估的，不是从声音测的；
      · 明显不是台词的文本成了字幕（如「林语眼神透着轻蔑」）——
        那是剧本里的舞台指示，**从来没有被念出来**；
      · 小说体那几集几乎没有字幕 —— 那种写法里一条 `角色：` 都没有，
        按剧本解析必然什么也解析不出来。

    转写镜头原声一次解决三者：字幕**就是**音频的转写，时间码来自声音本身，
    没被念出来的东西不可能出现在里面，剧本用什么格式写都无所谓。

    时间换算：ASR 给的是"音频内相对秒"，字幕要的是"锚定镜头 + 镜内偏移"。
    旁白自身就锚在某个镜头上，所以直接把 ASR 的相对秒加到旁白的镜内偏移上即可；
    镜头原声的锚点就是该镜头自己，偏移直接用 ASR 的相对秒（**相对**锚定，
    所以按集导出不会整体漂掉前面所有集的时长）。
    """
    from datetime import datetime, timezone

    from .config import get_settings
    from .db import Asset, AudioClip, Project, SubtitleClip
    # 在函数内取而不是模块顶部：见文件头「模块图必须单向」那段。
    from .jobs import _update, get_job, is_cancelled, set_job_phase
    from .media import _probe_duration, ensure_local_async
    from .drama_timing import speaker_of, split_units, spoken_lines
    from .providers.asr import SIMPLIFIED_ZH_PROMPT, pick_asr_provider
    from .subtitle_align import correct_segments

    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload or "{}")
    project_id = p.get("project_id")
    if not project_id:
        _update(jid, status="failed", error="缺少 project_id")
        return

    asr = pick_asr_provider()
    if asr is None:
        from .providers.asr_volc import VolcFlashASR
        volc_error = VolcFlashASR().config_error
        _update(jid, status="failed",
                error=(f"没有可用的语音识别通道，无法自动生成字幕：{volc_error}；"
                       "阿里云百炼 Paraformer（FW_BAILIAN_API_KEY）也未配置")
                if volc_error else
                ("未配置任何语音识别通道，无法自动生成字幕"
                 "（配置 FW_DRAMA_ASR_CONFIG 用火山录音文件识别，"
                 "或 FW_BAILIAN_API_KEY 用阿里云百炼 Paraformer）"))
        return
    episode = p.get("episode")
    episode = int(episode) if episode not in (None, "") else None
    align_script = p.get("align_script", True) is not False

    _update(jid, status="running", progress=1)

    # ---- 选音源 ----
    with get_session() as session:
        proj = session.get(Project, project_id)
        mode = (proj.production_mode or "") if proj else ""
        clips = (session.query(AudioClip)
                 .filter(AudioClip.project_id == project_id,
                         # ⚠️ 原来只认 kind=="tts"。但解说剧的旁白落库用的是
                         # kind="narration"（routes_v2.generate_narration 写入），
                         # 而 kind=="tts" 只有用户在音频面板手工建的那种。
                         # 于是解说剧项目里 targets 恒为空，自动字幕**从未成功过**
                         # ——报的还是"没有可识别的旁白音频，请先合成 AI 配音"，
                         # 用户明明已经合成了，只能反复重试。
                         # 与 run_tts_batch(见 ~2508 行)保持同一套 kind 判定。
                         AudioClip.kind.in_(("tts", "narration")),
                         AudioClip.url.isnot(None),
                         AudioClip.status == "done")
                 .order_by(AudioClip.start_shot_order,
                           AudioClip.start_offset_sec).all())
        narration = [(c.url, c.start_shot_order, float(c.start_offset_sec or 0.0))
                     for c in clips]
        q = session.query(Shot).filter(Shot.project_id == project_id)
        if episode is not None:
            q = q.filter(Shot.episode == episode)
        all_shots = q.order_by(Shot.order).all()
        in_scope = {s.order for s in all_shots}
        # 空字符串的 video_url 照旧进来：下载不到，计进识别失败
        shots = [s for s in all_shots if s.video_url is not None]
        # 停用的镜头不进成片，也就不该有字幕
        videos = [(s.video_url, s.order, 0.0) for s in shots if not s.disabled]
        # 每一镜会被念出来的台词：镜头原声转写完拿它逐字纠正
        lines_of = {s.order: spoken_lines(s.script_ref or "") for s in shots}
        shot_of = {s.order: (s.id, s.episode) for s in shots}
        # 剧里的人名（角色资产、剧本里的说话人）：按剧本改人名时不比声调（见 subtitle_align）
        names = {a.name for a in session.query(Asset).filter(Asset.project_id == project_id,
                                                              Asset.kind == "character")}
        names.update(speaker_of(u.raw) for s in shots for u in split_units(s.script_ref or "")
                     if u.kind in ("dialog", "vo"))
        names.discard("")
        if episode is not None:
            narration = [n for n in narration if n[1] in in_scope]

    # 真人剧一律转写镜头原声：台词只在那里。其余模式优先用旁白，
    # 没有旁白时也退到镜头原声——比报一句"请先合成配音"有用。
    targets, from_video, src_label = _pick_asr_source(mode, narration, videos)

    if not targets:
        set_job_phase(jid, None)
        _update(jid, status="failed",
                error=("没有可识别的镜头视频。请先生成镜头视频后再自动生成字幕。"
                       if from_video else
                       "没有可识别的旁白音频。请先在「音频」面板合成 AI 配音。"))
        return

    if p.get("replace"):
        # 重跑时先清掉上一轮自动生成的（手工加的字幕不动——它们 kind=normal/title）
        with get_session() as session:
            q = session.query(SubtitleClip).filter(SubtitleClip.project_id == project_id,
                                                   SubtitleClip.kind == "subtitle")
            if episode is not None:
                q = q.filter(SubtitleClip.start_shot_order.in_(sorted(in_scope) or [-1]))
            for old in q.all():
                session.delete(old)
            session.commit()

    total = len(targets)
    phase_label = f"正在识别{src_label}"
    set_job_phase(jid, {"key": "asr", "label": phase_label, "done": 0, "total": total})

    # 并发：用**已有**的 settings.default_concurrency（与 ~2900 / ~3252 行同一
    # 口径），不新增开关也不下调任何并发数。原实现是**完全串行**的，真人剧一集
    # 30 镜就要串几分钟；镜头数上百时串行根本跑不完。
    # ⚠️ 若这里成为瓶颈（429/限流），正确解法是加 API KEY / 提配额，不是降并发。
    sem = asyncio.Semaphore(max(1, get_settings().default_concurrency))
    rows: list[tuple[str, int, float, float]] = []   # (text, order, offset, dur)
    checks: dict[int, dict] = {}                      # order -> 按剧本纠正的统计
    check_script = from_video and align_script
    lock = asyncio.Lock()
    done = failed = silent = 0

    async def one(url: str | None, order: int, offset: float) -> None:
        nonlocal done, failed, silent
        try:
            async with sem:
                # 拿到槽位后再查一次取消（同 desub/upscale 的道理）：
                # gather 一次性派发，入口检查第一轮就全过了，之后全堵在这把
                # 信号量上。不在这里补，取消只改状态位、识别照跑照计费。
                if is_cancelled(jid):
                    return
                path = await ensure_local_async(url or "")
                if path is None or not path.exists():
                    failed += 1
                    return
                tmp = None
                try:
                    if from_video:
                        tmp = await _extract_asr_audio(path)
                        if tmp is None:
                            # 无音轨 ≠ 失败：这一镜本来就没人说话（空镜/环境镜）。
                            # 计进 failed 会让"全片只有几个镜有台词"误报成故障。
                            silent += 1
                            if check_script and lines_of.get(order):
                                # 剧本却有台词：请人看一眼
                                checks[order] = {**correct_segments([], lines_of[order])[1],
                                                 "no_audio": True}
                            return
                    segs = await asr.transcribe(
                        tmp or path, prompt=SIMPLIFIED_ZH_PROMPT)
                finally:
                    if tmp is not None:
                        tmp.unlink(missing_ok=True)
                if check_script and (segs or lines_of.get(order)):
                    segs, st = correct_segments(list(segs), lines_of.get(order) or [], names)
                    checks[order] = st

                # 时长兜底：某些返回体既无 segments 也无 duration，end 会是 0。
                # 直接 max(0.3, 0-0) 就是"50 个字闪 0.3 秒"——比没有字幕更糟。
                # 这种情况用素材自身的时长兜住（只在真需要时才 ffprobe）。
                media_sec: float | None = None
                async with lock:
                    for sg in segs:
                        text = (sg.get("text") or "").strip()
                        if not text:
                            continue
                        s0 = float(sg.get("start") or 0.0)
                        span = float(sg.get("end") or 0.0) - s0
                        if span <= 0:
                            if media_sec is None:
                                media_sec = await _probe_duration(path)
                            span = max(0.0, (media_sec or 0.0) - s0)
                        for txt, st, dur in _split_cue(text, offset + s0, span):
                            rows.append((txt, order, st, dur))
        except Exception as e:                      # noqa: BLE001
            log.warning("ASR 失败 %s: %s", url, e)
            failed += 1
        finally:
            done += 1
            set_job_phase(jid, {"key": "asr", "label": phase_label,
                                "done": done, "total": total})
            _update(jid, progress=max(1, min(98, int((done / total) * 100))))

    await asyncio.gather(*(one(u, o, off) for u, o, off in targets))

    made = 0
    if rows:
        # 一次事务写完：并发任务各自开 session 写 SQLite 会撞 database is locked。
        with get_session() as session:
            for text, order, offset, dur in sorted(rows, key=lambda r: (r[1], r[2])):
                session.add(SubtitleClip(
                    id=uuid.uuid4().hex[:12], project_id=project_id,
                    text=text, kind="subtitle",
                    start_shot_order=order, start_offset_sec=offset,
                    duration=dur, style=None,
                    created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                ))
                made += 1
            session.commit()

    set_job_phase(jid, None)

    script_check = None
    mismatch_orders: list[int] = []
    if check_script:
        # 和剧本对不上的镜头、按剧本改过字的镜头都列进来：改过的字要有人能核对。
        # 对不上的排在前面，清单满了先省掉只改过字的（见 `_REVIEW_MAX`）
        mismatched, fix_only = [], []
        fixed_shots = 0
        for order in sorted(checks):
            st = checks[order]
            if st["no_script"]:
                continue
            mismatch, fixed = _mismatch_reason(st), _fix_note(st)
            fixed_shots += fixed is not None
            if mismatch or fixed:
                sid, ep = shot_of.get(order, (None, None))
                (mismatched if mismatch else fix_only).append({
                    "order": order, "episode": ep, "shot_id": sid, "similarity": st["similarity"],
                    "reason": "；".join(w for w in (mismatch, fixed) if w),
                    "fixes": st["fixes"], "differs": st["differs"], "doubts": st["doubts"]})
        review = mismatched[:_REVIEW_MISMATCH_MAX]
        review += fix_only[:max(0, _REVIEW_MAX - len(review))]
        listed_mismatch = min(len(mismatched), _REVIEW_MISMATCH_MAX)
        script_check = {
            "shots": len(checks),
            "fixed_chars": sum(c["fixed"] for c in checks.values()),
            "kept_chars": sum(c["kept"] for c in checks.values()),
            "extra_chars": sum(c["extra"] for c in checks.values()),
            "unspoken_chars": sum(c["unspoken"] for c in checks.values()),
            "fixed_shots": fixed_shots,
            "mismatch_shots": len(mismatched),
            "no_script_shots": sum(c["no_script"] for c in checks.values()),
            "review_count": len(mismatched) + len(fix_only),
            "review": review,
            "omitted_mismatch_shots": len(mismatched) - listed_mismatch,
            "omitted_fix_shots": len(fix_only) - (len(review) - listed_mismatch),
        }
        mismatch_orders = [r["order"] for r in mismatched]

    # 全军覆没要报失败，不能报 done。
    # 原来无论如何都 status="done"：ASR 服务挂了、密钥过期、所有音频都识别失败，
    # 用户看到的仍是一个绿色的"已完成"，字幕轨空空如也 ——
    # 既不知道失败了，也不知道该重试。
    if total and made == 0:
        # 三种"没产出"要分开说，因为处置办法完全不同：
        #   · 全都没音轨 → 这些镜头本来就没有声音，该去看视频模型是否出了音；
        #   · 有失败 → 服务/密钥/网络，重试或查配置；
        #   · 都成功却一个字都没识别出 → 音轨里确实没有人声。
        if silent == total:
            err = (f"自动字幕失败：{total} 个镜头的视频都没有音轨，无法识别台词。"
                   "真人剧的台词来自视频模型生成的原声，请确认生成时开启了音频。")
        elif failed:
            err = (f"自动字幕失败：{failed}/{total} 段{src_label}识别失败，未生成任何字幕。"
                   "请检查 ASR 服务配置后重试")
        else:
            err = f"自动字幕失败：{total} 段{src_label}里没有识别到任何语音"
        _update(jid, status="failed", progress=100, error=err,
                result=json.dumps({"created": 0, "failed": failed, "total": total,
                                   "silent": silent, "source": src_label,
                                   "asr": getattr(asr, "name", None), "episode": episode,
                                   "script_check": script_check},
                                  ensure_ascii=False))
        return

    # 部分失败也要让用户知道（成功但不完整），前端据此提示。
    # 无音轨的镜头单独说：它不是故障，但"少了几镜的字幕"用户是要知道的。
    warn = []
    if failed:
        warn.append(f"{failed}/{total} 段{src_label}识别失败")
    if silent:
        warn.append(f"{silent} 个镜头无音轨（无台词）")
    if script_check and script_check["review_count"]:
        parts = []
        if script_check["mismatch_shots"]:
            named = "、".join(str(o) for o in mismatch_orders[:_WARN_ORDERS_MAX])
            more = " 等" if len(mismatch_orders) > _WARN_ORDERS_MAX else ""
            parts.append(f"{script_check['mismatch_shots']} 个镜头和剧本对不上（镜号 {named}{more}）")
        if script_check["fixed_shots"]:
            parts.append(f"{script_check['fixed_shots']} 个镜头按剧本改了字")
        warn.append("、".join(parts) + "，请看一眼")
    if script_check and script_check["no_script_shots"]:
        warn.append(f"{script_check['no_script_shots']} 个镜头的剧本里没有「角色：台词」格式的台词，"
                    "没有按剧本纠正")
    _update(jid, status="done", progress=100,
            error=("；".join(warn) + "，其余已生成" if warn else None),
            result=json.dumps({"created": made, "failed": failed, "total": total,
                               "silent": silent, "source": src_label,
                               "asr": getattr(asr, "name", None), "episode": episode,
                               "script_check": script_check},
                              ensure_ascii=False))
