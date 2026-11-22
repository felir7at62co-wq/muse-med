"""导入已有剧本 → 转写为剧本的核心逻辑

功能:
1. 解析多种格式(.txt/.docx/.doc/.pdf)
2. 智能切分章节(支持多种分隔符+中文数字)
3. AI辅助提取大纲(总梗概+各集梗概)
4. 角色名自动提取
5. 预览+确认+生成剧本
"""
from __future__ import annotations
import logging
import re
import json
import time
import io
import asyncio
from typing import Any
from fastapi import UploadFile

logger = logging.getLogger("import_script")


# ---------------------------------------------------------------------------
# 0. 文本消毒
# ---------------------------------------------------------------------------
# Postgres 的 text 类型**不接受** \x00（psycopg 报
# `UntranslatableCharacter: unsupported Unicode escape sequence /
#  \x00 cannot be converted to text`），而且这个错是在 flush 时才炸的，
# 表现为整条 /import-script/create 500 —— 用户那边只看到一句「HTTP 500」。
#
# 生产上真实发生过：一个损坏的 .docx 让下面的纯文本兜底把整个 ZIP 二进制
# 解码成了"正文"，`PK\x03\x04…` 一路带到入库。preview 不写库所以是 200，
# 用户一路点到最后一步才失败，还看不出哪里不对（实测一人 8 秒内点了 9 次）。
#
# 所以：**凡是要落库的文本都先过这里**，一处兜住。
_CONTROL_CHARS = {c: None for c in range(0x20) if c not in (0x09, 0x0A, 0x0D)}


def sanitize_text(s: str) -> str:
    """剔除 \\x00 等控制字符（保留 \\t \\n \\r）。非字符串原样返回。"""
    if not isinstance(s, str):
        return s
    return s.translate(_CONTROL_CHARS)


def sanitize_deep(obj):
    """递归消毒 dict/list 里的所有字符串 —— 给 JSON 列（outline）用。

    Postgres 的 jsonb 同样不接受 \\u0000，且报的还是同一个
    UntranslatableCharacter。outline 里既有用户正文的切片（synopsis），
    也有 LLM 的产出，两边都可能带脏字符。
    """
    if isinstance(obj, str):
        return sanitize_text(obj)
    if isinstance(obj, dict):
        return {k: sanitize_deep(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [sanitize_deep(v) for v in obj]
    return obj


def looks_binary(data: bytes) -> bool:
    """字节流看起来是二进制（而不是可读文本）吗？

    两个判据：ZIP 魔数（docx/xlsx 等 OOXML 容器，解析失败说明容器坏了，
    硬当文本读只会读出一堆压缩字节），以及高比例的 \\x00
    （旧版 .doc 之类的真二进制格式改了扩展名）。
    """
    if data[:4] == b"PK\x03\x04":
        return True
    head = data[:4096]
    if not head:
        return False
    return head.count(b"\x00") / len(head) > 0.05


# ---------------------------------------------------------------------------
# 1. 文件解析(支持txt/docx/doc/pdf)
# ---------------------------------------------------------------------------
async def parse_script_file(file: UploadFile) -> str:
    """解析上传的剧本文件,返回纯文本内容"""
    filename = file.filename or "untitled"
    ext = filename.lower().split('.')[-1]
    content_bytes = await file.read()
    
    # 大小检查 (500MB)
    if len(content_bytes) > 500 * 1024 * 1024:
        raise ValueError(f"文件太大({len(content_bytes)//1024//1024}MB),最大500MB")
    
    if ext == 'txt':
        # 编码检测。.txt 也可能是别的东西改的扩展名 —— 先看像不像二进制，
        # 免得把乱码当剧本导进去（后面还会炸在入库上）。
        if looks_binary(content_bytes):
            raise ValueError(
                "这个 .txt 文件的内容看起来不是纯文本（可能是 Word/PDF 改了扩展名）。"
                "请另存为真正的 .txt / .docx，或直接粘贴文本内容。"
            )
        try:
            import chardet
            detected = chardet.detect(content_bytes[:10000])
            encoding = detected.get('encoding') or 'utf-8'
            return sanitize_text(content_bytes.decode(encoding, errors='ignore'))
        except Exception:
            return sanitize_text(content_bytes.decode('utf-8', errors='ignore'))

    elif ext == 'docx':
        from docx import Document
        try:
            doc = Document(io.BytesIO(content_bytes))
            paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
            return sanitize_text('\n\n'.join(paragraphs))
        except Exception as e:
            # docx 解析失败：先判断是不是二进制。
            # 过去这里无条件走"纯文本解码"兜底，于是把 ZIP 字节当正文读了出来，
            # 一路带到 /import-script/create 才炸成 500（见 sanitize_text 注释）。
            # 现在在**预览阶段**就明确拒绝，并告诉用户该怎么办。
            if looks_binary(content_bytes):
                raise ValueError(
                    f"文件无法解析（{e}）。"
                    "这通常是因为文件已损坏，或是旧版 .doc/.wps 直接改了扩展名。"
                    "请用 Word/WPS 打开后「另存为」标准 .docx 再上传，或直接粘贴文本内容。"
                )
            # 不含二进制特征（少数合法边缘情况）才尝试当纯文本
            logger.warning("docx解析失败(%s), 内容不像二进制, 尝试纯文本解码", e)
            try:
                import chardet
                detected = chardet.detect(content_bytes[:10000])
                encoding = detected.get('encoding') or 'utf-8'
                return sanitize_text(content_bytes.decode(encoding, errors='ignore'))
            except Exception:
                raise ValueError(f"文件解析失败: {e}。请确认是有效的.docx文件(非旧版.doc),或尝试粘贴文本方式导入")

    elif ext == 'doc':
        # .doc格式需要 antiword 或 textract,简单方案:用libreoffice转换
        # 这里降级为提示,建议用户转为docx
        raise ValueError("暂不支持.doc格式,请用Word另存为.docx格式后再上传")

    elif ext == 'pdf':
        try:
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(content_bytes))
            return sanitize_text('\n\n'.join(page.extract_text() or '' for page in reader.pages))
        except Exception as e:
            raise ValueError(f"PDF解析失败: {e}")
    
    else:
        raise ValueError(f"不支持的格式: .{ext} (支持: txt/docx/pdf)")


# ---------------------------------------------------------------------------
# 2. 智能切分章节
# ---------------------------------------------------------------------------
_CN_NUM_MAP = {'零':0,'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,
               '百':100,'千':1000,'壹':1,'贰':2,'叁':3,'肆':4,'伍':5,'陆':6,'柒':7,'捌':8,'玖':9}


def _cn_num_to_int(s: str) -> int:
    """中文数字转阿拉伯数字(简易版,支持1-999)"""
    s = s.strip()
    if s.isdigit():
        return int(s)
    # 处理"十X"
    if s == "十":
        return 10
    if s.startswith("十") and len(s) == 2:
        return 10 + _CN_NUM_MAP.get(s[1], 0)
    if "十" in s:
        parts = s.split("十")
        tens = _CN_NUM_MAP.get(parts[0], 1) * 10 if parts[0] else 10
        ones = _CN_NUM_MAP.get(parts[1], 0) if len(parts) > 1 and parts[1] else 0
        return tens + ones
    # 单字符
    if len(s) == 1:
        return _CN_NUM_MAP.get(s, 0)
    return 0


def smart_split_chapters(text: str, *, renumber: bool = True) -> list[dict]:
    """智能识别章节边界
    
    返回: [{"order": 1, "title": "第1集", "content": "..."}, ...]
    
    支持:
    - 第N集/第N话/第N章/第N回 (中文/阿拉伯数字)
    - 长分隔线 ====/****/----
    - 单独行的"标题"格式
    - 长度兜底切分

    Args:
        renumber: 是否把集号**重排成 1..N**。
            True（默认，导入建新草稿用）：整本从第 1 集起，用户原文里写错的
                集号会被拉直。
            False（**粘贴进已有草稿**用）：**保留原文里解析出的集号**。

    ⚠️ 这个开关是 2026-09-22 的真实 bug 修复。原来无条件重排，于是用户
    在工作台粘贴「第73集…第77集」时，五集被改写成 1–5 集，
    直接盖掉开头五集 —— 用户报告"不管第几集都会识别成 1-5 集"。
    重排对"导入整本"是对的（整本必须从 1 起），对"往已有草稿里补一段"
    是灾难性的，所以必须按入口区分，不能一刀切。
    """
    text = text.strip()
    if not text:
        return []
    
    # 模式1: "第X集/章/话/回"
    # ⚠️ 集号后面那一段**不能跨行**取标题。原来的写法是
    #   `[集章节话回幕场])\s*(?:[:：、\.]?\s*([^\n]{0,50}))?`
    # 中间的 `\s*` 会吃掉换行，于是「第1集」独占一行时，标题位抢到的是
    # **下一行正文的前 50 个字**：标题栏被塞进半句台词，正文的第一行反而
    # 从切分点之后才开始，用户看到的是"标题怪怪的 + 开场少一句"。
    # 新写法把标题前的空白限定成**同一行内的空格/制表符**，换行一律不吃。
    #
    # 两套锚点，按"先保守、后激进"两轮试：
    #  ① 行首锚点（strict）：集号必须出现在行首（允许前导空格）。
    #     最不容易误切，适用于绝大多数分集剧本 —— 一集一号、独占一行。
    #  ② 行内锚点（loose）：集号可以出现在**空格后**或**句末标点后**，
    #     用来救"整段一行"的粘贴文本（「第一集 夜访…。 第二集 旧照片…。」），
    #     那种文本用①只会切出一集，标题里塞着半篇正文。
    #     ⚠️ 行内锚点有误切风险，故只在①切不出 ≥2 集时才启用，
    #     并且启用前用 `_looks_like_episode_headers` 核对集号是否递增 ——
    #     正文里"他把第3集翻出来看"这种引用会被这条挡掉。
    _MARK = r'(第\s*([一二三四五六七八九十百千零壹贰叁肆伍陆柒捌玖\d]+)\s*[集章节话回幕场])'
    # 标题位：优先「分隔符（：、.）+ 行内剩余」，否则允许「空格 + 一个短词」。
    # 没分隔符也没空格（集号独占一行）时标题留空，整行归正文。
    #
    # ⚠️ 空格分支必须**收得很紧**，否则会吃掉正文：
    #   `[ \t　]+([^\n]{0,60})?` 遇到「第1集 他推开门，屋里一片黑。」会把整句
    #   当标题，content 变空、整集被下面的 `if content` 丢掉（正文静默少一集）。
    #   所以标题最多 20 字、不含标点/引号，且后面必须跟空格或行尾 ——
    #   「第1集 夜访 陆知衡推开门。」取到"夜访"，标题才立得住；
    #   「第1集 陆知衡推开门走进客厅。」因为整段没有内部空格、判定为正文，标题留空。
    _TAIL = (r'(?:[ \t]*[:：、\.][ \t]*([^\n]{0,60})?'
             r'|[ \t　]+([^。！？；…，、“”「」\n]{1,20})(?=[ \t　]|$))?')
    strict_pat = rf'(?:^|\n)[ \t]*{_MARK}{_TAIL}'
    loose_pat = rf'(?:^|\n|[ \t　]|(?<=[。！？；…])|(?<=[”」』）\)])){_MARK}{_TAIL}'

    def _looks_like_episode_headers(ms: list) -> bool:
        """切出来的集号是否像"分集标记"（递增/不重复），而不是正文里的引用。"""
        if len(ms) < 2:
            return False
        orders = [_cn_num_to_int(m.group(2)) for m in ms]
        if any(o <= 0 for o in orders):
            return False
        increases = sum(1 for a, b in zip(orders, orders[1:]) if b > a)
        return increases >= (len(orders) - 1) * 0.8

    matches = list(re.finditer(strict_pat, text))
    if len(matches) < 2:
        loose = list(re.finditer(loose_pat, text))
        if len(loose) >= 2 and _looks_like_episode_headers(loose):
            matches = loose
    
    if matches:  # 一个标记也认：单集剧本只有"第1集"一个标记，不该退回整段兜底
        chapters = []
        for i, m in enumerate(matches):
            start = m.end()
            end = matches[i+1].start() if i+1 < len(matches) else len(text)
            content = text[start:end].strip()

            order_str = m.group(2)
            order = _cn_num_to_int(order_str)
            if order == 0:
                order = i + 1

            title_part = ((m.group(3) or "") or (m.group(4) or "")).strip()
            title_part = title_part.lstrip(":：、.").strip()
            # 标题统一成"第N集"的阿拉伯数字写法：原文可能是"第一集"，直接沿用会出现
            # 草稿里"第一集 / 第2集"混排；order 是权威集号，标题跟着它走。
            title = f"第{order}集" if order else m.group(1).strip()
            if title_part:
                title = f"{title} {title_part}"

            if content:
                chapters.append({
                    "order": order,
                    "title": title,
                    "content": content,
                    "word_count": len(content),
                })

        # 按order排序
        chapters.sort(key=lambda c: c["order"])
        # 重新编号(防止用户写错) —— 只在"导入整本"时做，见函数 docstring
        if renumber:
            for i, c in enumerate(chapters):
                c["order"] = i + 1
                # order 重排后标题跟着回正，别让标题停在原集号上
                tm = re.match(r'^第\d+集(.*)$', c["title"])
                if tm:
                    c["title"] = f"第{c['order']}集{tm.group(1)}"

        # 有可能一集都没切出来：正文全被标题位吃掉时会走到这里。
        # 这种剧本会一路走到 preview 返回 `chapters: []`，前端一片空白、
        # 用户接着点"创建"再吃一个 400，看不出哪里不对。切不出来就往下走兜底切法。
        if chapters:
            return chapters
    
    # 模式2: 长分隔线
    sep_pattern = r'\n\s*[=*\-_~]{5,}\s*\n'
    if re.search(sep_pattern, text):
        parts = [p.strip() for p in re.split(sep_pattern, text) if p.strip()]
        return [
            {"order": i+1, "title": f"第{i+1}集", "content": p, "word_count": len(p)}
            for i, p in enumerate(parts)
        ]
    
    # 模式3: 长度兜底(每5000字一段)
    if len(text) > 5000:
        return [
            {"order": i+1, "title": f"第{i+1}集", "content": text[i*5000:(i+1)*5000].strip(),
             "word_count": min(5000, len(text) - i*5000)}
            for i in range(0, (len(text) + 4999) // 5000)
        ]
    
    # 单集
    return [{"order": 1, "title": "第1集", "content": text, "word_count": len(text)}]


# ---------------------------------------------------------------------------
# 3. AI提取大纲(总梗概+各集梗概+角色)
# ---------------------------------------------------------------------------
async def extract_outline_with_ai(chapters: list[dict], title: str = "") -> dict:
    """用LLM从已切分的章节中提取大纲信息
    
    返回: {
        "title": str,
        "synopsis": "整剧梗概",
        "characters": [{"name", "role", "appearance"}],
        "world": {"era", "setting"},
        "chapters": [{"order", "title", "synopsis", "must_have", "characters"}]
    }
    """
    from ..models.llm import get_llm
    
    # 取每集前1500字作为摘要原料(防止token超限)
    chapter_summaries = []
    for ch in chapters:
        text_sample = ch["content"][:1500]
        chapter_summaries.append(f"## 第{ch['order']}集 ({ch.get('title', '')})\n{text_sample}")
    
    summary_text = "\n\n".join(chapter_summaries)
    if len(summary_text) > 30000:
        summary_text = summary_text[:30000] + "...(后续省略)"
    
    prompt = f"""你是资深剧本分析师。下面是一部分多集剧本的内容片段,请你提取出大纲信息。

剧本标题: {title or '(未命名)'}
集数: {len(chapters)}集

剧本内容:
{summary_text}

请分析后输出严格JSON(不要markdown包装):
{{
  "title": "推断的剧名(如未明示则保持原标题)",
  "synopsis": "整剧梗概(150-300字,概括主线+主角+核心冲突+结局)",
  "world": {{
    "era": "时代背景",
    "setting": "主要场景",
    "rules": []
  }},
  "characters": [
    {{"name": "人物名", "role": "主角/女主/反派/配角", "appearance": "外貌/服饰简述", "personality": "性格特征"}}
  ],
  "chapters": [
    {{
      "order": 1,
      "title": "本集标题",
      "synopsis": "本集梗概(80-150字)",
      "beats": [
        {{"at": "地点+时间", "who": "本拍在场人物", "action": "具体发生了什么(能被拍出来的动作/台词)", "turn": "这一拍结束时局面变成了什么"}}
      ],
      "must_have": ["关键情节1", "关键情节2", "结尾点"],
      "characters": ["本集出场人物"],
      "core_push": "本集唯一核心推进点(一句话,本集所有事件都服务它)",
      "stakes": "本集失败会失去什么(具体到身份/资格/亲情/自由/传承/机会/信任/性命)",
      "hook_out": {{"type": "突然揭示|紧急危机|未完成动作|身份反转|两难选择|神秘线索|时间限制|承诺威胁|离奇消失|言外之意", "strength": "好奇|关切|迫切|生存|终极", "leads_to": "它直接引发下一集发生什么"}}
    }}
  ]
}}

要求:
- chapters 数组必须正好 {len(chapters)} 项,order 从 1 开始连续
- characters 总数控制在 3-10 人,提取所有有名字的人物
- **beats 是从剧本正文里读出来的、不是编的**:每个 beat 都应当来自这一段剧本里
  真实出现过的场景与动作。一条 beat 一拍,按剧情顺序排。
  `at` 用剧本里写明的场景(如"医院走廊 夜")。**不要遗漏**剧中真实发生的场次。
- 这是**据实提取**,不是创作:正文里没有的人物、事件、反转一律不要写。
- 仅输出 JSON,禁止任何前后说明文字"""
    
    llm = get_llm("generate", temperature=0.3)
    resp = await llm.ainvoke(prompt)
    raw = (getattr(resp, "content", "") or "").strip()
    
    # 解析JSON
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    
    try:
        data = json.loads(raw)
    except Exception:
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        if m:
            data = json.loads(m.group(0))
        else:
            raise ValueError("LLM返回的JSON无法解析")
    
    # 标准化
    if not isinstance(data, dict):
        raise ValueError("outline不是dict")
    
    # 确保chapters数量匹配
    out_chapters = data.get("chapters") or []
    if len(out_chapters) != len(chapters):
        # 长度不一致,补齐或截断
        out_chapters = out_chapters[:len(chapters)]
        while len(out_chapters) < len(chapters):
            i = len(out_chapters)
            out_chapters.append({
                "order": i + 1,
                "title": chapters[i].get("title", f"第{i+1}集"),
                "synopsis": chapters[i]["content"][:150],
                "must_have": [],
                "characters": [],
            })
    
    # 重新编号
    for i, c in enumerate(out_chapters):
        c["order"] = i + 1
    
    data["chapters"] = out_chapters
    return data


# ---------------------------------------------------------------------------
# 4. 角色名快速提取(规则+AI双管)
# ---------------------------------------------------------------------------
def extract_character_names_fast(text: str, max_names: int = 30) -> list[str]:
    """快速提取角色名(基于规则,用于预览)
    
    规则:
    - 中文姓名(2-4字)
    - 出现≥3次
    - 排除常见非人名词(地名/动作/...)
    """
    # 简单中文人名模式
    pattern = r'[\u4e00-\u9fa5]{2,4}'
    candidates = re.findall(pattern, text)
    
    # 计数
    from collections import Counter
    counter = Counter(candidates)
    
    # 排除常见非人名词
    blacklist = {
        '什么','怎么','这个','那个','可是','但是','因为','所以','如果','虽然',
        '已经','正在','现在','刚才','现场','地方','时候','一切','所有','大家',
        '一下','一些','一直','非常','马上','立刻','突然','忽然','明白','知道',
        '看到','听到','想到','说道','回答','回应','沉默','点头','摇头',
        '他们','她们','我们','你们','自己','别人','所以','然后','后来','之后',
        '今天','明天','昨天','早上','晚上','下午','上午','开始','结束',
    }
    
    names = []
    for name, count in counter.most_common(100):
        if count < 2:
            break
        if name in blacklist:
            continue
        if any(c.isdigit() for c in name):
            continue
        names.append(name)
        if len(names) >= max_names:
            break
    
    return names
