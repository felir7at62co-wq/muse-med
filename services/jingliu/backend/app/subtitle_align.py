"""自动字幕的第二步：拿这一镜剧本里的台词，逐字纠正语音识别的结果（2026-11-21）。

用户的设想：「录音文件转写然后通过原剧本字进行纠正……落地成字幕工作流」。

## 为什么要纠正、又为什么不能直接用剧本

视频模型念的就是剧本里的台词，所以剧本是**正确的字**：人名、同音字、数字的写法，
语音识别经常听错（「林晨」听成「林辰」），剧本不会错。

但不能直接把剧本贴上去当字幕：模型有时会少念一句、多念几个字、改几个词，字幕必须是
**真正念出来的**，时间也只能来自声音。所以做法是：时间与句子划分全部沿用识别结果，
只把识别结果里**能和剧本对上**的地方换成剧本的字。

## 规则（逐字对齐，不调语言模型）

先去掉两边的标点与空白，只比较字，用最长公共子序列的办法对齐（`difflib`）：

- 对得上的字：不动；
- 识别多出来、剧本里没有的字（模型自己加的）：保留，计入 `extra`；
- 剧本里有、识别里没有的字（模型没念）：**不补**，计入 `unspoken`；
- 一小段对不上，而且是「夹在对得上的字中间的一小处」，**读音又和剧本那几个字相同**，就换成剧本的字，
  计入 `fixed`，这一处（听到的、剧本的）记进 `fixes`：
  - 一小处：每边不超过 `MAX_FIX` 个字、长短差不超过 `MAX_LEN_GAP`（含数字的放宽到 `MAX_FIX_DIGITS`，
    识别会把「三百一十八万」写成「318万」）；
  - 夹在中间：至少一边紧挨着 `MIN_CONTEXT` 个以上对得上的字，另一边是这一镜的开头 / 结尾，
    或者也有 `MIN_CONTEXT` 个以上对得上的字（不到这么多、但一直连到这一镜开头 / 结尾的也算，
    比如「林辰，你终于回来了」开头的「林」）。这条区分「听错一个名字」和「模型改了说法」：
    「其实根本就不是真的」对剧本「其实我早就知道真的」，对不上的字一处挨一处、中间只隔一个字，
    那是换了说法；整镜一个字都对不上（「好的」对剧本「走吧」），或者对不上的那处一边是开头 / 结尾、
    另一边只有一个对得上的字（「嗯好的」对「嗯走吧」），分不出是听错还是念了别的。这些都不按剧本改；
  - 读音相同：逐字比**带声调**的拼音（`pypinyin` 的 `Style.TONE3`，按上下文的词选多音字的读音：
    「辰」「晨」都是 chen2）。声调不同就是另一个字（「买」「卖」、「想」「像」、「有」「又」），
    按听到的保留。只有两种情况不比声调：
    - 轻声助词：一边是读轻声的「的」「地」「得」「了」（`NEUTRAL_PARTICLES`），和另一边任一读音的
      声母韵母相同就算（「慢慢的」对「慢慢地」）。别的轻声字不算，两边读音一样也不算：「这是你吗」对剧本
      「这是你妈」差的是问句还是陈述；
    - 人名：剧本这几个字落在 `names`（角色名、剧本里的说话人）里，两边的字取全部读音
      （`heteronym=True`）、不比声调，有一个相同就算。识别不认识剧里的人名，会写成读音相近的常用词，
      声调常常不对（「沈母」听成「审木」、「张姐」听成「长姐」）；
    「一」「不」念出来的声调随后一个字变，pypinyin 只给词典里有的词标变调（「一个」给 yi2、「不对」给 bu2，
    「一样」却给 yi1、「不去」给 bu4），它们和别的字一样比声调。
    阿拉伯数字按中文念法比较（「318」念「三百一十八」或「三一八」），「两」「幺」也可以按「二」「一」算。
    读音不同，就是模型念了别的字（「我不想去」对剧本「我很想去」，改了意思就反了），
    按听到的保留，这一处记进 `differs`，交给人看；
  - 否定的字相同：两边含的否定字（`NEGATION`：不、没、别、未、非、无、莫、勿、甭、否）不一样，
    读音再相同也按听到的保留（「这不行啊」对剧本「这步行啊」都是 bu4，剧本人名「梅姐」听成「没姐」也一样）：
    改了就多出或少掉一个否定，听到的也可能就是模型念的；
- 其余对不上的：保留识别结果，识别的字计入 `kept`，剧本那几个字计入 `unspoken`。

按听到的保留的一处，下面几种交给人看，记进 `differs` 或 `doubts`（听到的、剧本的，没有的一边是空字符串）：

- 两边一样长、逐字的声母韵母相同，逐字要么读音相同、要么差的是靠不住的声调（轻声，或者「一」「不」的声调），
  不管旁边有几个对得上的字，记进 `doubts`：分不出是听错还是念了另一个字。读音相同却没改的有两种：
  否定的字不同（「这不行啊」对「这步行啊」），旁边对得上的字不够（「林辰林辰」对「林晨林晨」）；
  差的是靠不住的声调的，如「这是你吗」对「这是你妈」、「我全不要了」对「我全部要了」（bu2 对 bu4）；
- 上一种以外，夹在对得上的字中间的一小处（读音不同，见上），以及两边一样长、逐字的声母韵母相同、
  只差别的声调的一处（「你买不买」对剧本「你卖不卖」），记进 `differs`。「A 不 A」的问句里每个「买」
  旁边只有一个对得上的字，够不上「夹在中间」，可读音不同就是另一个字：要么识别听错了声调、
  字幕把意思说反了，要么模型念的就是另一个字；
- 以上两种以外，里面有否定的字的一处，记进 `doubts`。「他是坏人」对剧本「他不是坏人」只差一个字、
  相似度很高，意思却反了：要么识别漏了「不」、字幕是错的，要么模型把台词念反了、这一镜要重做；
- 以上几种以外，这一镜听到的或剧本的不超过 `SHORT_SHOT` 个字时对不上的一处（「林辰」对「林晨」、
  「你别」对「你走」），记进 `doubts`：这么短的一镜，对不上的字夹不进足够多对得上的字中间，
  分不出是听错还是念了别的。

能改的一处一定改：长短不同的（「318」换成「三百一十八」）整段放在第一个字的位置，其余位置清空，
可以跨识别分段（「年薪3」「18万」→「年薪三百一十八」「万」）。

整镜的相似度（`similarity`，0–1）只数对得上的字，外加能按剧本改的数字（「318」和「三百一十八」
是同一个数，只是写法和字数不同）；能按剧本改的人名、同音字不算对上。相似度低于 `MIN_SIMILARITY`
时整镜不改，标为 `deviated`：那说明念的内容和剧本差得太多（或者对错了镜头），硬改只会把对的字改错。
什么都没听到（没有识别结果，或者只有标点）而剧本有台词时，相似度是 0、标为 `unheard`，
剧本的字全部计入 `unspoken`。

标点、空格保持识别结果的原样：后面切条（`subtitle_jobs._split_cue`）按它们断句。
"""
from __future__ import annotations

import unicodedata
from collections.abc import Iterable
from difflib import SequenceMatcher

from pypinyin import Style, pinyin

#: 一小段对不上时，最多换几个字（每一边）。人名、同音词一般 1–3 个字。
MAX_FIX = 4
#: 含数字的段放宽到几个字（阿拉伯数字与中文数字写法长短差得多）。
MAX_FIX_DIGITS = 10
#: 两边长短最多差几个字还算「同一处听错」。
MAX_LEN_GAP = 2
#: 一处要按剧本改，紧挨着它的对得上的字至少要有几个（规则见模块说明）。
MIN_CONTEXT = 2
#: 整镜相似度低于它就不改。
MIN_SIMILARITY = 0.5
#: 听到的或剧本的不超过这么多字的一镜，按听到的保留的对不上的字都交给人看（规则见模块说明）。
SHORT_SHOT = 3
#: 否定的字：多念、少念或换掉一个，台词的意思就反了；两边的否定字不一样就不按剧本改。
NEGATION = frozenset("不没别未非无莫勿甭否")
#: 读轻声时不比声调的助词（规则见模块说明）。别的轻声字差的是语气：「吗」「妈」、「呢」「呐」。
NEUTRAL_PARTICLES = frozenset("的地得了")

_PUNCT = set("，。！？；：、…‥—～﹏\"'“”‘’「」『』《》〈〉【】〔〕（）()[]{},.!?;:·-")
_DIGIT_NAMES = "零一二三四五六七八九"
#: 比读音之前换成同一个字：数字的另一种念法
_SAME_NUMBER_SOUND = str.maketrans({"两": "二", "幺": "一"})
#: 念出来的声调随后一个字变的字（变调）：pypinyin 给的声调靠不住，只差它们的声调的一处记进 doubts
_SANDHI = frozenset("一不")


def _is_content(ch: str) -> bool:
    return not ch.isspace() and ch not in _PUNCT


def _has_digit(s: str) -> bool:
    return any(c.isdigit() for c in s)


def _four_digits(n: int) -> str:
    """1–9999 的中文念法，开头的「一十」不省（由 `_cardinal` 处理）。"""
    out, gap = "", False
    for value, unit in ((1000, "千"), (100, "百"), (10, "十"), (1, "")):
        d = n // value % 10
        if d == 0:
            gap = bool(out)
            continue
        out += ("零" if gap else "") + _DIGIT_NAMES[d] + unit
        gap = False
    return out


def _cardinal(n: int) -> str:
    """不到一万亿的整数按数目的中文念法：318 → 三百一十八，100050 → 十万零五十。"""
    if n == 0:
        return "零"
    out, gap = "", False
    for unit, group in (("亿", n // 10**8), ("万", n // 10**4 % 10**4), ("", n % 10**4)):
        if group == 0:
            gap = bool(out)
            continue
        out += ("零" if out and (gap or group < 1000) else "") + _four_digits(group) + unit
        gap = False
    return out[1:] if out.startswith("一十") else out


def _spellings(s: str) -> set[str]:
    """`s` 念出来可能的写法：每一串阿拉伯数字按数目念（「318」→「三百一十八」）或逐位念（「三一八」）；
    「两」「幺」另有按「二」「一」写的一种。"""
    out, run = {""}, ""
    for ch in [*s, ""]:
        if ch and unicodedata.decimal(ch, None) is not None:
            run += str(unicodedata.decimal(ch))
            continue
        alts = {""}
        if run:
            alts = {"".join(_DIGIT_NAMES[int(d)] for d in run)}
            if len(run) <= 12 and (len(run) == 1 or run[0] != "0"):
                alts.add(_cardinal(int(run)))
            run = ""
        out = {a + b + ch for a in out for b in alts}
    return out | {x.translate(_SAME_NUMBER_SOUND) for x in out}


def _syllables(s: str) -> list[str]:
    """`s` 逐字在上下文里的读音：带声调的拼音（轻声不带数字），多音字按 pypinyin 的词典选；
    没有读音的字（字母、数字、生僻字）原样返回。"""
    out = [r[0] for r in pinyin(s, style=Style.TONE3, heteronym=False, errors=lambda x: list(x))]
    if len(out) != len(s):              # 对不齐就逐字取（不用上下文），比错位比较安全
        out = [pinyin(ch, style=Style.TONE3, errors=lambda x: list(x))[0][0] for ch in s]
    return out


def _toneless(reading: str) -> str:
    return reading.rstrip("012345")


def _is_neutral(reading: str) -> bool:
    """读轻声（`Style.TONE3` 的轻声不带数字）。"""
    return not reading[-1].isdigit()


def _all_toneless(ch: str) -> set[str]:
    """一个字全部读音的声母韵母（多音字给出全部）。"""
    return {_toneless(r) for r in pinyin(ch, style=Style.TONE3, heteronym=True)[0]}


def _same_sound(x: str, y: str, rx: str, ry: str, in_name: bool) -> bool:
    """听到的字 `x`（上下文读音 `rx`）和剧本的字 `y`（`ry`）是不是同一个音（规则见模块说明）。"""
    if x.translate(_SAME_NUMBER_SOUND) == y.translate(_SAME_NUMBER_SOUND):
        return True
    if rx == x or ry == y:                  # 没有读音的字只认同一个字
        return False
    if in_name:
        return bool(_all_toneless(x) & _all_toneless(y))
    x_neutral, y_neutral = _is_neutral(rx), _is_neutral(ry)
    if (x_neutral and x not in NEUTRAL_PARTICLES) or (y_neutral and y not in NEUTRAL_PARTICLES):
        return False
    if x_neutral:
        return rx in _all_toneless(y)
    if y_neutral:
        return ry in _all_toneless(x)
    return rx == ry


def _cannot_tell_apart(heard: str, script: str, heard_sounds: list[str], script_sounds: list[str],
                       in_name: list[bool]) -> bool:
    """两段一样长、逐字声母韵母相同，逐字要么读音相同，要么差的是靠不住的声调（轻声，或者「一」「不」）：
    分不出是听错了还是念了另一个字（规则见模块说明）。"""
    return _sounds_alike(heard, script) and all(
        _same_sound(x, y, rx, ry, name) or x in _SANDHI or y in _SANDHI
        or _is_neutral(rx) or _is_neutral(ry)
        for x, y, rx, ry, name in zip(heard, script, heard_sounds, script_sounds, in_name))


def _reads_the_same(heard: str, script: str, heard_sounds: list[str], script_sounds: list[str],
                    in_name: list[bool]) -> bool:
    """两段字有没有一种念法逐字读音相同。不含数字时用两段在整句里的读音；
    含数字时比较每一种念法（数字没有多音字，也不会是人名）。"""
    if not (_has_digit(heard) or _has_digit(script)):
        return len(heard) == len(script) and all(
            _same_sound(*pair) for pair in zip(heard, script, heard_sounds, script_sounds, in_name))
    for a in _spellings(heard):
        ra = _syllables(a)
        for b in _spellings(script):
            if len(a) == len(b) and all(_same_sound(x, y, rx, ry, False)
                                        for x, y, rx, ry in zip(a, b, ra, _syllables(b))):
                return True
    return False


def _sounds_alike(heard: str, script: str) -> bool:
    """两段一样长、逐字有相同的声母韵母（不比声调，多音字取全部读音；含数字的不算）。"""
    return (len(heard) == len(script) and not (_has_digit(heard) or _has_digit(script))
            and all((_all_toneless(x) & _all_toneless(y)) - {""} for x, y in zip(heard, script)))


def _name_mask(script: str, names: Iterable[str]) -> list[bool]:
    """剧本的每一个字是不是落在某个人名里（两个字以上的名字才算，单字会把常用字都当成人名）。"""
    mask = [False] * len(script)
    for name in names:
        n = "".join(ch for ch in name if _is_content(ch))
        if len(n) < 2:
            continue
        k = script.find(n)
        while k >= 0:
            mask[k:k + len(n)] = [True] * len(n)
            k = script.find(n, k + 1)
    return mask


def _context_ok(ops: list, k: int, heard_len: int) -> bool:
    """第 k 段有没有被对得上的字夹住：一边至少 `MIN_CONTEXT` 个，另一边是开头 / 结尾或者也对得上。"""
    _tag, i1, i2, _j1, _j2 = ops[k]
    left = ops[k - 1] if k > 0 else None
    right = ops[k + 1] if k + 1 < len(ops) else None
    left_n = left[2] - left[1] if left is not None and left[0] == "equal" else 0
    right_n = right[2] - right[1] if right is not None and right[0] == "equal" else 0
    left_ok = i1 == 0 or left_n >= MIN_CONTEXT or (left_n > 0 and left[1] == 0)
    right_ok = i2 == heard_len or right_n >= MIN_CONTEXT or (right_n > 0 and right[2] == heard_len)
    return left_ok and right_ok and max(left_n, right_n) >= MIN_CONTEXT


def _short_mismatch(ops: list, k: int, heard: str, script: str) -> bool:
    """第 k 段是不是「夹在对得上的字中间的一小处」对不上（还没比读音）。"""
    tag, i1, i2, j1, j2 = ops[k]
    if tag != "replace":
        return False
    got, want = heard[i1:i2], script[j1:j2]
    limit = MAX_FIX_DIGITS if (_has_digit(got) or _has_digit(want)) else MAX_FIX
    return (len(got) <= limit and len(want) <= limit and abs(len(got) - len(want)) <= MAX_LEN_GAP
            and _context_ok(ops, k, len(heard)))


def put_text(chars: list[list[str]], spots: list[tuple[int, int]], want: str) -> None:
    """把 `spots`（`chars[段][字]` 的位置，按顺序）上的字换成 `want`。

    等长时逐字替换；不等长时整段放进第一个字的位置、其余位置清空（「318」→「三百一十八」）。
    `spots` 为空时不动。`correct_segments` 与 `subtitle_cues.apply_decisions` 都用它，规则只有这一处。
    """
    if not spots:
        return
    if len(spots) == len(want):
        for (si, sj), ch in zip(spots, want):
            chars[si][sj] = ch
        return
    (first_seg, first_pos), *rest = spots
    chars[first_seg][first_pos] = want
    for si, sj in rest:
        chars[si][sj] = ""


def correct_segments(segments: list[dict], lines: list[str],
                     names: Iterable[str] = ()) -> tuple[list[dict], dict]:
    """返回 (纠正后的分段, 统计)。分段里只改 `text`，时间与条数不变；改过字的分段去掉 `words`。

    `segments`：识别结果 `[{start, end, text, ...}]`（可以为空）；`lines`：这一镜会被念出来的台词
    （`drama_timing.spoken_lines(script_ref)`）；`names`：这部剧的人名（规则见模块说明）。

    统计：`similarity`（剧本没有台词时为 None）、`fixed`、`kept`、`extra`、`unspoken`（都是字数）、
    `deviated`（听到了内容、但和剧本差得多，整镜没改）、`unheard`（剧本有台词、却什么都没听到）、
    `no_script`（听到了说话声、这一镜剧本里却没有台词）、
    `fixes`（按剧本改的每一处 `{heard, script}`）、
    `differs`（夹在对得上的字中间、读音却不同，或者在哪儿都只差别的声调，而按听到的保留的每一处
    `{heard, script}`）、
    `doubts`（读音相同却没能改、只差轻声或「一」「不」的声调、含否定的字、在很短的一镜里，
    而按听到的保留的每一处 `{heard, script}`，没有的一边是空字符串；先后见模块说明）。
    整镜没改时 `differs`、`doubts` 都为空。
    `spans`：`{fixes, differs, doubts}`，与那三个列表一一对应的 `[i1, i2]`：这一处听到的字在
    识别结果的**字**（去掉标点与空白，按分段顺序连起来）里的位置，左闭右开；听到的一边为空时
    `i1 == i2`，是剧本那几个字应在的位置（`subtitle_cues` 用它定位要人看的那一处）。
    """
    stats = {"similarity": None, "fixed": 0, "kept": 0, "extra": 0, "unspoken": 0,
             "deviated": False, "unheard": False, "no_script": False, "fixes": [], "differs": [],
             "doubts": [], "spans": {"fixes": [], "differs": [], "doubts": []}}
    chars = [list(seg.get("text") or "") for seg in segments]
    #: 识别结果里的每一个字落在哪：(第几段, 段内第几个字符)
    where = [(i, j) for i, seg in enumerate(chars) for j, ch in enumerate(seg) if _is_content(ch)]
    heard = "".join(chars[i][j] for i, j in where)
    script = "".join(ch for line in lines for ch in line if _is_content(ch))
    if not script:
        stats["no_script"] = bool(heard)
        return [dict(s) for s in segments], stats
    if not heard:
        stats.update(similarity=0.0, unheard=True, unspoken=len(script))
        return [dict(s) for s in segments], stats

    ops = SequenceMatcher(None, heard, script, autojunk=False).get_opcodes()
    heard_sounds, script_sounds = _syllables(heard), _syllables(script)
    in_name = _name_mask(script, names)
    short = [_short_mismatch(ops, k, heard, script) for k in range(len(ops))]
    fixable = [ok and set(heard[i1:i2]) & NEGATION == set(script[j1:j2]) & NEGATION
               and _reads_the_same(heard[i1:i2], script[j1:j2], heard_sounds[i1:i2],
                                   script_sounds[j1:j2], in_name[j1:j2])
               for ok, (_tag, i1, i2, j1, j2) in zip(short, ops)]
    matched = sum(i2 - i1 for tag, i1, i2, _j1, _j2 in ops if tag == "equal")
    matched += sum((i2 - i1 + j2 - j1) / 2
                   for (_tag, i1, i2, j1, j2), ok in zip(ops, fixable)
                   if ok and _has_digit(heard[i1:i2] + script[j1:j2]))
    similarity = 2 * matched / (len(heard) + len(script))
    stats["similarity"] = round(similarity, 3)
    if similarity < MIN_SIMILARITY:
        stats["deviated"] = True
        for tag, i1, i2, j1, j2 in ops:
            if tag == "replace":
                stats["kept"] += i2 - i1
            elif tag == "delete":
                stats["extra"] += i2 - i1
            if tag in ("replace", "insert"):
                stats["unspoken"] += j2 - j1
        return [dict(s) for s in segments], stats

    short_shot = min(len(heard), len(script)) <= SHORT_SHOT
    touched: set[int] = set()
    for (tag, i1, i2, j1, j2), near, ok in zip(ops, short, fixable):
        if tag == "equal":
            continue
        got, want = heard[i1:i2], script[j1:j2]
        if not ok:
            if tag == "delete":
                stats["extra"] += len(got)
            else:
                stats["kept"] += len(got)
                stats["unspoken"] += len(want)
            piece = {"heard": got, "script": want}
            # 交给人看的几种，先后照模块说明
            if tag == "replace" and _cannot_tell_apart(got, want, heard_sounds[i1:i2],
                                                       script_sounds[j1:j2], in_name[j1:j2]):
                listed = "doubts"
            elif near or (tag == "replace" and _sounds_alike(got, want)):
                listed = "differs"
            elif NEGATION.intersection(got + want) or (tag == "replace" and short_shot):
                listed = "doubts"
            else:
                continue
            stats[listed].append(piece)
            stats["spans"][listed].append([i1, i2])
            continue
        spots = where[i1:i2]
        put_text(chars, spots, want)
        touched.update(si for si, _ in spots)
        stats["fixed"] += len(want)
        stats["fixes"].append({"heard": got, "script": want})
        stats["spans"]["fixes"].append([i1, i2])

    out = []
    for i, seg in enumerate(segments):
        row = dict(seg)
        if i in touched:
            row["text"] = "".join(chars[i])
            row.pop("words", None)              # 逐字时间对应的是改之前的字
        out.append(row)
    return out, stats
