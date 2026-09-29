#!/usr/bin/env python3
"""
drive.py — 全自动播放驱动（用户零点击）
==========================================
为什么需要它：播放地址由微信 native 层下发，**没有任何 HTTP API 能拿到**。
所以必须有人把每一集"播"一次。本脚本让 agent 自己驱动小程序的 UI 来完成这件事。

怎么做到的：微信 PC 版的小程序跑在 Chromium 里，而 **Chromium 会把无障碍树
暴露给 Windows UIA**。于是我们可以：

  · 按**元素名字**精确找到控件（不是猜像素）
  · 读当前集号          Text  name='第28集'
  · 打开选集面板        Text  name='·选集'
  · 点任意一集          Text  name='9'   （选集网格里 6 列整齐排布）
  · 确认点击生效        再读一次 '第N集'

再配合一个关键事实：**这个播放器会自动连播**。
所以整个流程是：打开剧 → 跳到第一个缺的集 → 之后让它自己往下播，
缺哪集就跳哪集，直到收齐。

    python scripts/drive.py --check              # 只读：现在什么状态
    python scripts/drive.py --open               # 打开目标剧
    python scripts/drive.py --goto 9             # 跳到第 9 集
    python scripts/drive.py --auto               # ★ 全自动：跳集+等待+收齐+归档

⚠ 运行期间会**占用鼠标和前台窗口**（Windows 不允许后台进程可靠地驱动前台 UI）。
  跑 --auto 时请不要用这台电脑。窗口被其它程序盖住或被抢焦点会中断驱动。
"""
import os, sys, re, json, time, argparse, subprocess, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

C.force_utf8()

BRIDGE = os.path.join(C.SCRIPTS, "win_bridge.ps1")
_BRIDGE_TMP = tempfile.TemporaryDirectory(prefix="muse-wechat-")
_TMP = os.path.join(_BRIDGE_TMP.name, "bridge.json")

# 选集网格单元格的判定：纯数字 + 高度 >= 24（榜单单号 h≈15~20，统计数字 h≈18，网格 h≈29）
GRID_H_MIN = 24
GRID_H_MAX = 44


# ------------------------------------------------------------------ 桥调用
def _ps(args):
    cmd = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", BRIDGE,
           "-Out", _TMP] + args
    try:
        subprocess.run(cmd, capture_output=True, timeout=60)
    except subprocess.TimeoutExpired:
        return {}
    if not os.path.exists(_TMP):
        return {}
    try:
        return json.load(open(_TMP, encoding="utf-8"))
    finally:
        try:
            os.remove(_TMP)
        except OSError:
            pass


class NoWindow(RuntimeError):
    pass


def dump(window_name="", retries=2, process_filter="", rect_filter=True):
    """返回 (窗口信息, 元素列表)。
    Chromium 惰性建树，必要时多抓一次。
    rect_filter=False 时不做矩形过滤（微信主窗口的元素坐标不受窗口矩形约束）。"""
    last = {}
    for i in range(retries + 1):
        args = ["-Action", "dump"]
        if process_filter:
            args += ["-Filter", process_filter]
        if window_name:
            args += ["-WindowName", window_name]
        d = _ps(args)
        if d.get("ok"):
            if not rect_filter:
                return d, list(d.get("elements") or [])
            x0, y0, w, h = d["rect"]
            inside = [e for e in d["elements"]
                      if x0 <= e["cx"] <= x0 + w and y0 <= e["cy"] <= y0 + h]
            if inside or i == retries:
                return d, inside
            time.sleep(0.5)
        last = d
    raise NoWindow(last.get("error") or "找不到窗口（微信 PC 版里先打开一次该短剧小程序）")


def focus(window_name=""):
    return _ps(["-Action", "focus"] + (["-WindowName", window_name] if window_name else [])).get("foreground", False)


# 点击模式：
#   "bg"  = PostMessage 直接投递给窗口消息队列
#           → **不移动光标、不抢焦点、窗口被别的窗口盖住也行**（默认）
#   "fg"  = SetCursorPos + mouse_event（真实注入，会抢光标/前台）
#           → 用于 bg 不生效时的兜底
CLICK_MODE = "bg"


def click(x, y, action=None):
    act = action or ("postclick" if CLICK_MODE == "bg" else "click")
    # postclick 不支持 -WindowName 过滤时报错也不影响；带上更稳
    for args in ([act, "-WindowName", ""], [act]):
        r = _ps(([args[0]] if len(args) == 1 else args) + ["-X", str(int(x)), "-Y", str(int(y))])
        if r.get("ok"):
            return True
    return False


def scroll(x, y, delta):
    return _ps(["-Action", "scroll", "-X", str(int(x)), "-Y", str(int(y)), "-Delta", str(int(delta))]).get("ok", False)


def key(name):
    return _ps(["-Action", "key", "-Key", name]).get("ok", False)


def screenshot(path):
    ps = ("Add-Type -AssemblyName System.Windows.Forms,System.Drawing;"
          "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;"
          "$bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height);"
          "$g=[System.Drawing.Graphics]::FromImage($bmp);"
          "$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size);"
          f"$bmp.Save('{path}',[System.Drawing.Imaging.ImageFormat]::Png);"
          "$g.Dispose();$bmp.Dispose()")
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, timeout=60)
    return os.path.exists(path)


def video_motion(window_name="", gap=2.5, region=(0.10, 0.55, 0.15, 0.85)):
    """返回视频画面在 gap 秒内的“明显变化像素占比”（%）

    这是闭环的**传感器**：>5% 基本可认为在播放，~0% 就是暂停/卡住。
    避开底部 UI 区（区域参数是窗口高/宽的百分比）。
    """
    try:
        import numpy as np
        import cv2
    except Exception:
        return None
    d, _ = dump(window_name)
    x0, y0, w, h = d["rect"]
    p = os.path.join(_BRIDGE_TMP.name, "shot.png")
    if not screenshot(p):
        return None
    a = cv2.imdecode(np.fromfile(p, dtype=np.uint8), cv2.IMREAD_COLOR)
    time.sleep(gap)
    if not screenshot(p):
        return None
    b = cv2.imdecode(np.fromfile(p, dtype=np.uint8), cv2.IMREAD_COLOR)
    if a is None or b is None:
        return None
    y1, y2 = y0 + int(h * region[0]), y0 + int(h * region[1])
    x1, x2 = x0 + int(w * region[2]), x0 + int(w * region[3])
    ra = a[y1:y2, x1:x2]
    rb = b[y1:y2, x1:x2]
    if ra.size == 0 or ra.shape != rb.shape:
        return None
    return float((cv2.absdiff(ra, rb).max(axis=2) > 25).mean() * 100)


def is_playing(window_name="", gap=2.5, threshold=5.0):
    m = video_motion(window_name, gap)
    return (m is not None and m > threshold), m


# ------------------------------------------------------------------ 元素定位
def find(elems, *, contains=None, equals=None, regex=None, min_h=0, max_h=10 ** 6, min_y=None):
    out = []
    for e in elems:
        nm = e.get("name") or ""
        if not nm:
            continue
        if contains and contains not in nm:
            continue
        if equals is not None and nm != equals:
            continue
        if regex and not re.search(regex, nm):
            continue
        if not (min_h <= e["h"] <= max_h):
            continue
        if min_y is not None and e["cy"] < min_y:
            continue
        out.append(e)
    return out


def current_episode(elems):
    """读播放器上的 '第N集'"""
    for e in elems:
        m = re.match(r"^第(\d+)集$", e.get("name") or "")
        if m:
            return int(m.group(1)), e
    return None, None


def drama_name():
    return C.load_config().get("drama_name") or ""


def in_player(elems):
    ep, _ = current_episode(elems)
    return ep is not None


def find_drama_card(elems, title=None):
    """在榜单/剧场页找目标剧的卡片文字。title 给了就用它，否则用配置里的剧名。"""
    n = title or drama_name()
    if not n:
        return None
    key2 = n[:4]                       # 取前 4 字做模糊匹配（应对省略号截断）
    cands = find(elems, contains=key2)
    if not cands:
        cands = find(elems, contains=n)
    return cands[0] if cands else None


def find_episode_list_button(elems):
    c = find(elems, contains="选集")
    return c[0] if c else None


def find_grid_cell(elems, n):
    """选集网格里的第 n 集单元格（纯数字 + 高度特征过滤掉榜单序号/统计数字）"""
    for e in elems:
        nm = e.get("name") or ""
        if nm == str(n) and GRID_H_MIN <= e["h"] <= GRID_H_MAX:
            return e
    return None


# ------------------------------------------------------------------ 动作
WECHAT_PROC = "Weixin"          # 微信主窗口进程名
PANEL_LABEL = "小程序"          # 侧栏/面板标题


def wechat_window_rect():
    """3 种微信进程名都试（不同版本叫法不同）"""
    for f in ("Weixin", "WeChat", "WeChatAppEx"):
        try:
            d, _ = dump(process_filter=f, rect_filter=False)
            if d.get("rect"):
                return d["rect"], f
        except NoWindow:
            continue
    return None, None


def open_miniapp(name, tries=3):
    """在微信主窗口里点开名为 name 的小程序（先开小程序面板，再点名字）。
    name 就是分享链接里的那一段，例如 '#小程序://绿泡泡短剧/xxx' -> '绿泡泡短剧'。"""
    if not name:
        return False, "没有小程序名字"
    for attempt in range(tries):
        # 先看小程序窗口是否已经开着
        try:
            d, elems = dump(window_name=name)
            return True, f"小程序窗口已打开: {d.get('window')}"
        except NoWindow:
            pass
        # 在主窗口里找小程序面板
        found = False
        for proc in ("Weixin", "WeChat"):
            try:
                d, elems = dump(window_name="微信", process_filter=proc, rect_filter=False)
            except NoWindow:
                try:
                    d, elems = dump(process_filter=proc, rect_filter=False)
                except NoWindow:
                    continue
            # 面板上直接有这个名字？
            hits = find(elems, equals=name)
            if not hits:
                hits = find(elems, contains=name)
            if hits:
                t = hits[0]
                C.say(f"[drive] 在微信主窗口点 '{t['name']}' @({t['cx']},{t['cy']})")
                focus("微信")
                time.sleep(0.4)
                click(t["cx"], t["cy"])
                found = True
                break
            # 面板可能没展开：点侧栏的「小程序」入口
            btn = find(elems, equals=PANEL_LABEL) or find(elems, contains=PANEL_LABEL)
            if btn:
                C.say(f"[drive] 先展开小程序面板 @({btn['cx']},{btn['cy']})")
                focus("微信")
                time.sleep(0.4)
                click(btn["cx"], btn["cy"])
                time.sleep(1.5)
        if not found:
            time.sleep(1.0)
            continue
        # 等小程序窗口出现
        for _ in range(20):
            time.sleep(0.7)
            try:
                d, elems = dump(window_name=name)
                return True, f"已打开小程序: {d.get('window')}"
            except NoWindow:
                continue
        # 退一步：不一定过滤到名字，只要有 WeChatAppEx 窗口就成
        try:
            d, elems = dump()
            return True, f"已打开小程序: {d.get('window')}"
        except NoWindow:
            continue
    return False, f"未能打开小程序 '{name}'（请确认它出现在微信的『最近使用』里）"


def tap_text(text, window_name="", exact=False, index=0):
    """按 UI 文字点击（通用原语）。agent 可以用它自己导航，例如：
        --tap 榜单   →  --tap 漫剧榜  →  --tap <剧名>"""
    d, elems = dump(window_name)
    hits = find(elems, equals=text) if exact else find(elems, contains=text)
    if not hits and not exact:
        hits = find(elems, equals=text)
    if not hits:
        return False, f"窗口里找不到文字 '{text}'"
    if index >= len(hits):
        index = 0
    t = hits[index]
    click(t["cx"], t["cy"])
    time.sleep(1.2)
    return True, f"已点击 '{t['name'][:30]}' @({t['cx']},{t['cy']})  （共 {len(hits)} 个匹配）"


def list_drama_cards(window_name=""):
    """列出小程序首页里看起来像剧名的文字（供 agent 按用户给的名字挑）"""
    d, elems = dump(window_name)
    out = []
    for e in elems:
        nm = (e.get("name") or "").strip()
        if not nm or len(nm) < 3 or len(nm) > 40:
            continue
        if re.fullmatch(r"[\d,.·万集热度年月日:：\-:+ ]+", nm):
            continue
        out.append({"name": nm, "cx": e["cx"], "cy": e["cy"], "type": e["type"]})
    return d, out


def open_drama(window_name="", tries=3, title=None):
    for i in range(tries):
        d, elems = dump(window_name)
        ep, _ = current_episode(elems)
        if ep is not None:
            return True, f"已在播放页（第{ep}集）"
        card = find_drama_card(elems, title)
        if not card:
            return False, "找不到目标剧卡片（先用 --list-dramas 看看首页有哪些剧；或剧名不匹配）"
        click(card["cx"], card["cy"])
        time.sleep(3.0)
        d2, elems2 = dump(window_name)
        ep2, _ = current_episode(elems2)
        if ep2 is not None:
            return True, f"已打开并开始播放（第{ep2}集）"
    return False, "点击剧卡片后没进播放页"


def open_episode_grid(window_name="", tries=3):
    for i in range(tries):
        d, elems = dump(window_name)
        # 已经开着？网格里有高瘦的纯数字
        if any(GRID_H_MIN <= e["h"] <= GRID_H_MAX and re.fullmatch(r"\d+", e.get("name") or "")
               for e in elems):
            return True, elems
        btn = find_episode_list_button(elems)
        if not btn:
            return False, elems
        click(btn["cx"], btn["cy"])
        time.sleep(1.8)
        d2, elems2 = dump(window_name)
        if any(GRID_H_MIN <= e["h"] <= GRID_H_MAX and re.fullmatch(r"\d+", e.get("name") or "")
               for e in elems2):
            return True, elems2
    return False, elems2 if "elems2" in dir() else elems


def goto_episode(n, window_name="", max_scroll=8):
    """打开选集 → 找到第 n 集 → 点击 → 校验集号变了"""
    ok, elems = open_episode_grid(window_name)
    if not ok:
        return False, "打不开选集面板"
    for s in range(max_scroll + 1):
        cell = find_grid_cell(elems, n)
        if cell:
            click(cell["cx"], cell["cy"])
            time.sleep(2.5)
            d2, elems2 = dump(window_name)
            ep, _ = current_episode(elems2)
            if ep == n:
                return True, f"已跳到第{n}集"
            # 有时需要等一下播放器切集
            time.sleep(2.0)
            d3, elems3 = dump(window_name)
            ep3, _ = current_episode(elems3)
            if ep3 == n:
                return True, f"已跳到第{n}集"
            return False, f"点了第{n}集但当前是第{ep3}集"
        # 没找到就往下滚（网格带滚动）
        base = elems[-1] if elems else None
        sx, sy = (1510, 800) if not base else (base.get("cx", 1510), 800)
        scroll(1510, 800, -600)
        time.sleep(0.8)
        d2, elems = dump(window_name)
    return False, f"选集面板里翻不到第{n}集"


# ------------------------------------------------------------------ 自动循环
def run_auto(window_name="", stt=None, max_minutes=0, harvest_interval=None):
    import harvest as H
    import finalize as F

    cfg = C.load_config()
    total = cfg.get("episode_count") or len(C.load_episodes())
    if not total:
        return False, "还没有 drama.json，先跑 discover.py"
    iv = harvest_interval or cfg.get("poll_interval", 3.0)

    # 基线
    b = cfg["buckets"]
    if not b.get("baseline_t"):
        b["baseline_t"] = C.max_url_t(b.get("target"))   # 只按本剧桶校准
        cfg["buckets"] = b
        C.save_config(cfg)
    H.BASELINE_T = b["baseline_t"]
    H.load_durations()

    prefix = C.sanitize(cfg.get("drama_name"))

    def archived():
        import glob
        return {int(os.path.basename(p).split("第")[1][:2])
                for p in glob.glob(os.path.join(C.out_dir(True), f"{prefix}_第*集.mp4"))}

    def missing():
        return [e for e in range(1, total + 1) if e not in archived()]

    try:
        focus(window_name)
        ok, msg = open_drama(window_name, title=drama_name())
        C.say(f"[drive] {msg}")
        if not ok:
            return False, msg
    except NoWindow as e:
        return False, str(e)

    t0 = time.time()
    last_ep = None
    last_change = time.time()
    last_missing = None
    jump_fail = {}

    while True:
        if max_minutes and (time.time() - t0) / 60 > max_minutes:
            C.say(f"[drive] 达到时间上限 {max_minutes} 分钟，收尾")
            break
        # 1) 收割一轮
        try:
            H.scan_once(quiet=True, cfg=b)
        except Exception as e:
            C.say(f"[drive] 收割异常（忽略）: {e}")

        miss = missing()
        if not miss:
            C.say("[drive] 全部集数已归档 ✅")
            break
        if miss != last_missing:
            C.say(f"[drive] 还缺 {len(miss)} 集: {miss[:20]}{'…' if len(miss) > 20 else ''}")
            last_missing = miss

        # 2) 读当前集号
        try:
            d, elems = dump(window_name)
        except NoWindow as e:
            C.say(f"[drive] ⚠ {e}")
            time.sleep(5)
            continue
        ep, _ = current_episode(elems)

        if ep is None:
            C.say("[drive] ⚠ 不在播放页，尝试重新打开")
            ok, msg = open_drama(window_name, title=drama_name())
            C.say(f"[drive] {msg}")
            time.sleep(3)
            continue

        if ep != last_ep:
            last_ep = ep
            last_change = time.time()
            C.say(f"[drive] 当前播放：第{ep}集")

        # 3) 不需要这一集 -> 跳到下一个缺的
        if ep not in miss:
            nxt = miss[0]
            if jump_fail.get(nxt, 0) < 3:
                ok, msg = goto_episode(nxt, window_name)
                C.say(f"[drive] 跳到第{nxt}集: {msg}")
                if ok:
                    jump_fail.pop(nxt, None)
                    last_change = time.time()
                else:
                    jump_fail[nxt] = jump_fail.get(nxt, 0) + 1
                    time.sleep(2)
            else:
                # 跳不过去就让它自然播（可能滚不到那么远的集）
                C.say(f"[drive] 第{nxt}集跳不过去（已试{jump_fail[nxt]}次），改为等它自然播到")
                time.sleep(iv)

        # 4) 卡住检测：集号长时间不变
        stall = time.time() - last_change
        limit = 150
        if stall > limit:
            C.say(f"[drive] ⚠ 第{ep}集已卡 {stall:.0f} 秒，尝试恢复（点画面 / 空格）")
            click(1510, 500)
            time.sleep(0.6)
            key("SPACE")
            last_change = time.time()


        time.sleep(iv)

    # 收尾
    C.say("[drive] 归档中 …")
    try:
        sys.argv = ["finalize.py", "--quiet"]
        F.main()
    except SystemExit:
        pass
    miss = missing()
    return (not miss), (f"已归档 {total - len(miss)}/{total}" + (f"，仍缺 {miss}" if miss else "，全部到齐"))


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", default="", help="小程序窗口标题子串（多窗口时用）")
    ap.add_argument("--title", default="", help="剧目标题（未跑 discover.py 时用，模糊匹配）")
    ap.add_argument("--check", action="store_true", help="只读：报告当前状态")
    ap.add_argument("--playing", action="store_true", help="只读：视频画面是否在动（闭环传感器）")
    ap.add_argument("--fg", action="store_true",
                    help="用真实注入点击（会抢光标/前台）；默认用后台 PostMessage")
    ap.add_argument("--tap", metavar="TEXT", help="按 UI 文字点击（通用导航原语）")
    ap.add_argument("--tap-exact", action="store_true", help="--tap 用精确匹配")
    ap.add_argument("--tap-index", type=int, default=0, help="--tap 多个匹配时取第几个")
    ap.add_argument("--open-miniapp", metavar="NAME",
                    help="在微信里打开指定小程序（名字取自分享链接，如 '绿泡泡短剧'）")
    ap.add_argument("--list-dramas", action="store_true", help="列出小程序首页像剧名的文字")
    ap.add_argument("--open", action="store_true", help="打开目标剧（进到播放页）")
    ap.add_argument("--goto", type=int, help="跳到第 N 集")
    ap.add_argument("--auto", action="store_true", help="全自动：跳集+等待+收齐+归档")
    ap.add_argument("--max-minutes", type=float, default=0)
    args = ap.parse_args()

    # 点击模式：默认后台（不抢光标/前台）
    global CLICK_MODE
    CLICK_MODE = "fg" if args.fg else "bg"
    C.say(f"点击模式: {'前台真实注入' if CLICK_MODE == 'fg' else '后台 PostMessage（不抢光标/焦点）'}")

    if args.playing:
        okp, m = is_playing(args.window)
        if m is None:
            C.say("❌ 测不了（截图或读数失败）")
            return 1
        C.say(f"画面变化 {m:.1f}%  →  {'✅ 在播放' if okp else '❌ 暂停/卡住'}")
        return 0 if okp else 1
    if args.open_miniapp:
        ok, msg = open_miniapp(args.open_miniapp)
        C.say(("[drive] ✅ " if ok else "[drive] ❌ ") + msg)
        if not ok:
            return 1
        if not (args.list_dramas or args.open or args.goto or args.auto):
            return 0

    if args.list_dramas:
        try:
            d, cards = list_drama_cards(args.window)
        except NoWindow as e:
            C.say(f"❌ {e}")
            return 1
        C.say(f"窗口 {d.get('window')}  找到 {len(cards)} 条候选文字：")
        for c in cards:
            C.say(f"   @{c['cx']:>5},{c['cy']:>4} {c['type']:10} {c['name'][:44]}")
        return 0

    if args.tap:
        try:
            ok, msg = tap_text(args.tap, args.window, exact=args.tap_exact,
                               index=args.tap_index)
        except NoWindow as e:
            C.say(f"❌ {e}")
            return 1
        C.say(("[drive] ✅ " if ok else "[drive] ❌ ") + msg)
        return 0 if ok else 1

    title = args.title or drama_name()
    C.say(f"目标剧: {title or '（未设置，先跑 discover.py 或用 --title）'}")

    if args.check or not (args.open or args.goto or args.auto):
        try:
            d, elems = dump(args.window)
        except NoWindow as e:
            C.say(f"❌ {e}")
            return 1
        ep, _ = current_episode(elems)
        C.say(f"窗口   : {d.get('window')}  PID={d.get('pid')}  rect={d.get('rect')}")
        C.say(f"元素   : {d.get('elementCount')} 个（窗口内 {len(elems)}）")
        C.say(f"在播放页: {'是，第 %d 集' % ep if ep is not None else '否'}")
        card = find_drama_card(elems, title)
        C.say(f"剧卡片 : {'@%d,%d %r' % (card['cx'], card['cy'], card['name'][:24]) if card else '未找到'}")
        btn = find_episode_list_button(elems)
        C.say(f"选集钮 : {'@%d,%d' % (btn['cx'], btn['cy']) if btn else '未找到'}")
        grid = [e for e in elems if GRID_H_MIN <= e['h'] <= GRID_H_MAX and re.fullmatch(r"\d+", e.get("name") or "")]
        C.say(f"选集网格: {'已打开，' + str(len(grid)) + ' 个格子' if grid else '未打开'}")
        if args.check:
            return 0

    if args.open:
        focus(args.window)
        ok, msg = open_drama(args.window, title=title)
        C.say(("[drive] " if ok else "[drive] ❌ ") + msg)
        return 0 if ok else 1

    if args.goto:
        focus(args.window)
        ok, msg = open_drama(args.window, title=title)
        C.say(f"[drive] {msg}")
        if not ok:
            return 1
        ok, msg = goto_episode(args.goto, args.window)
        C.say(("[drive] " if ok else "[drive] ❌ ") + msg)
        return 0 if ok else 1

    if args.auto:
        focus(args.window)
        ok, msg = run_auto(args.window, max_minutes=args.max_minutes)
        C.say(("[drive] ✅ " if ok else "[drive] ⚠ ") + msg)
        return 0 if ok else 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
