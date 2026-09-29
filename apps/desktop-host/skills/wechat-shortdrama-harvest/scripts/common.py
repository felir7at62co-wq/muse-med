"""
common.py — 共享底座：路径 / 配置 / 微信缓存发现 / MP4 工具 / URL 正则
=====================================================================
本文件是唯一一处处理「路径」的地方。脚本位于安装目录，配置、缓存与输出均位于项目工作目录。
"""
import os, sys, json, re, struct, glob, time, ctypes
from ctypes import wintypes
from pathlib import Path

# ------------------------------------------------------------------ 路径
# scripts/common.py -> SKILL_DIR 是 scripts 的上级
SCRIPTS   = os.path.dirname(os.path.abspath(__file__))
SKILL_DIR = os.path.dirname(SCRIPTS)

WORK_ROOT = os.path.abspath(os.environ.get("SHORTDRAMA_WORK") or os.path.join(os.getcwd(), "source", "media", "wechat"))
if Path(WORK_ROOT).resolve().is_relative_to(Path(SKILL_DIR).resolve()):
    raise ValueError("SHORTDRAMA_WORK must be outside the installed skill directory")
CONFIG_F = os.path.join(WORK_ROOT, "config.json")
LOCK_F = os.path.join(WORK_ROOT, "DEPENDENCIES.lock.json")



def sanitize(name: str) -> str:
    """把剧名变成安全的文件名/目录名。
    半角与全角一律替换（全角冒号在 Windows 合法，但会让命名不一致）。"""
    s = (name or "drama").strip()
    s = re.sub(r"[\\/:*?\"<>|]", "-", s)        # 半角非法字符
    s = re.sub(r"[\uff1a\uff0f\uff1f\uff0a]", "-", s)  # ：／？＊
    s = re.sub(r"[\r\n\t]", " ", s)
    s = re.sub(r"-{2,}", "-", s).strip("- .")
    return s[:80] or "drama"


def drama_dir(create=False) -> str:
    """当前剧的工作目录"""
    cfg = load_config()
    p = os.path.join(WORK_ROOT, sanitize(cfg.get("drama_name")))
    if create:
        os.makedirs(p, exist_ok=True)
    return p


def raw_dir(create=False) -> str:
    p = os.path.join(drama_dir(create), "raw")
    if create:
        os.makedirs(p, exist_ok=True)
    return p


def covers_dir(create=False) -> str:
    p = os.path.join(drama_dir(create), "covers")
    if create:
        os.makedirs(p, exist_ok=True)
    return p


def out_dir(create=False) -> str:
    """成品输出目录（可用 config.out_dir 覆盖）"""
    cfg = load_config()
    p = cfg.get("out_dir") or os.path.join(drama_dir(create), "episodes")
    p = os.path.abspath(p)
    if create:
        os.makedirs(p, exist_ok=True)
    return p


def drama_json() -> str:
    return os.path.join(drama_dir(True), "drama.json")


def state_json() -> str:
    return os.path.join(drama_dir(True), "state.json")


# ------------------------------------------------------------------ 配置
DEFAULT_CONFIG = {
    # 由 discover.py 自动填充
    "drama_id":      None,
    "drama_name":    None,
    "episode_count": None,

    # 宿主小程序 appid（点开小程序的那个），用于构造 API 请求
    "host_appid":    None,
    # 内容方 appid
    "src_appid":     None,

    # VOD 桶白名单。留空 = 全靠时长探针自动发现（推荐）
    "buckets":       {"target": [], "rejected": [], "auto_add": True,
                      "all_seen": {}, "baseline_t": 0},

    # 输出目录覆盖（None = <工作区>/episodes）
    "out_dir":       None,

    # 轮询间隔（秒）
    "poll_interval": 3.0,
}


def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    if os.path.exists(CONFIG_F):
        try:
            cfg.update(json.load(open(CONFIG_F, encoding="utf-8")))
        except Exception:
            pass
    # 嵌套结构兜底
    b = dict(DEFAULT_CONFIG["buckets"])
    if isinstance(cfg.get("buckets"), dict):
        b.update(cfg["buckets"])
    cfg["buckets"] = b
    return cfg


def save_config(cfg: dict):
    os.makedirs(WORK_ROOT, exist_ok=True)
    tmp = CONFIG_F + ".tmp"
    json.dump(cfg, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    os.replace(tmp, CONFIG_F)


def load_state() -> dict:
    p = state_json()
    if os.path.exists(p):
        try:
            return json.load(open(p, encoding="utf-8"))
        except Exception:
            pass
    return {"seen": {}, "failed": {}, "finder": {}}


def save_state(st: dict):
    p = state_json()
    tmp = p + ".tmp"
    json.dump(st, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    os.replace(tmp, p)


def load_episodes() -> list:
    """返回 [{"media_no":1,"duration":107,"cover_url":"..."}, ...]"""
    try:
        d = json.load(open(drama_json(), encoding="utf-8"))
        return d.get("list", [])
    except Exception:
        return []


# --------------------------------------------------- 微信缓存发现（跨机器）
# 微信 PC 4.x (xwechat) 与旧版 (WeChat) 都覆盖
_CACHE_HINTS = (
    ("Tencent", "xwechat", "radium", "web", "profiles"),
    ("Tencent", "WeChat", "radium", "web", "profiles"),
)


def wechat_profile_root() -> str:
    """返回 radium/web/profiles 目录；找不到返回 ''"""
    bases = []
    for env in ("APPDATA", "LOCALAPPDATA"):
        root = os.environ.get(env)
        if not root:
            continue
        for hint in _CACHE_HINTS:
            bases.append(os.path.join(root, *hint))
    # Documents 下也可能有（部分版本）
    home = os.path.expanduser("~")
    for hint in _CACHE_HINTS:
        bases.append(os.path.join(home, "Documents", *hint))
    for b in bases:
        if os.path.isdir(b):
            return b
    # 兜底：递归找 profiles（只在常见根下，浅层）
    for env in ("APPDATA", "LOCALAPPDATA"):
        root = os.environ.get(env)
        if not root:
            continue
        for pat in (os.path.join(root, "Tencent", "*", "radium", "web", "profiles"),
                    os.path.join(root, "Tencent", "*", "*", "radium", "web", "profiles")):
            hits = glob.glob(pat)
            if hits:
                return hits[0]
    return ""


def wechat_files_root() -> str:
    """xwechat_files 目录（聊天/视频号原生缓存）"""
    home = os.path.expanduser("~")
    for p in (os.path.join(home, "Documents", "xwechat_files"),
              os.path.join(home, "xwechat_files")):
        if os.path.isdir(p):
            return p
    return ""


# 只扫这些文件：实测 vod 直链只出现在 Chromium 的 stream 文件里，
# 不在 954 个 f_* 数据块里。这让扫描量从 ~238MB 降到 ~19MB。
SCAN_NAMES = re.compile(r"^(data_\d+|index)$")


def cache_files(deep=False):
    """所有待扫描的缓存文件路径"""
    root = wechat_profile_root()
    if not root:
        return []
    out = []
    for cd in glob.glob(os.path.join(root, "*", "Cache", "Cache_Data")):
        for f in glob.glob(os.path.join(cd, "*")):
            if not os.path.isfile(f):
                continue
            if deep or SCAN_NAMES.match(os.path.basename(f)):
                out.append(f)
    return sorted(set(out), key=lambda x: -os.path.getmtime(x))


# ------------------------------------------------- 带共享读的 Windows 文件读取
# 微信独占锁定缓存文件，普通 open() 会 PermissionError。
GENERIC_READ   = 0x80000000
FILE_SHARE_ALL = 0x01 | 0x02 | 0x04          # READ | WRITE | DELETE
OPEN_EXISTING  = 3
INVALID_HANDLE = ctypes.c_void_p(-1).value


def read_shared(path: str) -> bytes:
    """即使文件被微信独占打开也能读出来"""
    try:
        with open(path, "rb") as f:
            return f.read()
    except (PermissionError, OSError):
        pass
    if os.name != "nt":
        raise OSError(f"cannot read {path}")
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateFileW.restype = wintypes.HANDLE
    k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
                                wintypes.HANDLE]
    h = k32.CreateFileW(path, GENERIC_READ, FILE_SHARE_ALL, None,
                        OPEN_EXISTING, 0, None)
    if h == INVALID_HANDLE:
        raise OSError(f"CreateFileW failed: {ctypes.get_last_error()}")
    try:
        size = os.path.getsize(path)
        buf = ctypes.create_string_buffer(size)
        got = wintypes.DWORD(0)
        k32.ReadFile(h, buf, size, ctypes.byref(got), None)
        return buf.raw[:got.value]
    finally:
        k32.CloseHandle(h)


# ------------------------------------------------------------------ MP4 工具
def mp4_meta(path: str) -> dict:
    """无 ffmpeg 解析 mp4：时长 / 分辨率 / 是否完整。
    这些短剧 mp4 是 moov 前置（ftyp→moov→free→mdat），所以只读开头就够。"""
    try:
        with open(path, "rb") as f:
            d = f.read()
    except OSError:
        return {"dur": None, "wh": None, "size": 0, "has_moov": False}
    dur = None
    i = d.find(b"mvhd")
    if i >= 0:
        ver = d[i + 4]
        try:
            if ver == 1:
                ts = struct.unpack(">I", d[i + 24:i + 28])[0]
                dur = struct.unpack(">Q", d[i + 28:i + 36])[0] / ts
            else:
                ts = struct.unpack(">I", d[i + 16:i + 20])[0]
                dur = struct.unpack(">I", d[i + 20:i + 24])[0] / ts
        except (struct.error, ZeroDivisionError):
            dur = None
    wh = None
    j = d.find(b"tkhd")
    if j > 0:
        v = d[j + 4]
        off = j + (100 if v == 1 else 88)
        try:
            wh = (struct.unpack(">I", d[off - 8:off - 4])[0] >> 16,
                  struct.unpack(">I", d[off - 4:off])[0] >> 16)
        except struct.error:
            pass
    return {"dur": round(dur, 2) if dur else None, "wh": wh,
            "size": os.path.getsize(path), "has_moov": b"moov" in d}


def mp4_duration(path: str):
    return mp4_meta(path)["dur"]


def mp4_total_from_boxes(d: bytes):
    """从 box 结构推完整文件大小（用于判断缓存分片是否够）"""
    off = 0
    for _ in range(12):
        if off + 8 > len(d):
            return None
        sz = struct.unpack(">I", d[off:off + 4])[0]
        typ = d[off + 4:off + 8]
        if sz == 1 and off + 16 <= len(d):
            sz = struct.unpack(">Q", d[off + 8:off + 16])[0]
        if sz < 8 or not all(32 <= c < 127 for c in typ):
            return None
        if typ == b"mdat":
            return off + sz
        off += sz
    return None


# ------------------------------------------------------------------ URL 正则
# ① 微信短剧播放器（小程序）：
#   https://<vodappid>.vodplayer|vodpreview.wxamedia.com/<bucket>/<fileid>/f0.mp4?t=&us=&sign=
#   t = 服务端生成 URL 的十六进制 unix 时间戳（时间闸门靠它）
URL_RE = re.compile(
    rb"https://(\d{6,})\.vod(?:player|preview)\.wxamedia\.com/"
    rb"([0-9a-z]+)/([0-9a-z]+)/f\d+\.mp4\?t=([0-9a-f]+)&us=[0-9a-zA-Z]+&sign=[0-9a-f]+"
)
# group(1)=vodappid  group(2)=bucket  group(3)=fileid  group(4)=t(hex)

# ② 视频号原生短剧（Finder）：完全不同的 CDN 与参数体系
#   https://finder*.video.qq.com/<n>/<cgi>/stodownload?encfilekey=..&token=..&idx=1
#   &X-snsvideoflag=xWT113   ← 带这个参数才是【视频】，不带的是封面图(image/jpg)
#   token 是一次性凭证，过期即 400 → 必须发现即下载
FINDER_RE = re.compile(
    rb"https://finder[a-z]*[.]video[.]qq[.]com/\d+/\d+/stodownload\?"
    rb"[^\x00-\x20\"'<>]{10,3000}"
)
FINDER_VIDEO_FLAG = b"X-snsvideoflag"

# ③ 会话凭证（从缓存里捡，用于调 wxadramaplayer API）
SESS_RE  = re.compile(rb"wxa_plugin_session=([A-Za-z0-9_\-]+)")
TICK_RE  = re.compile(rb"wxa_plugin_ticketrandom=([A-Za-z0-9_%\-]+)")
HOST_RE  = re.compile(rb"[?&]appid=(wx[0-9a-f]{16})")
SRC_RE   = re.compile(rb"src_appid=(wx[0-9a-f]{16})")
DRAMA_RE = re.compile(rb"drama_id=(\d+)")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 MicroMessenger/4.1.13.63")


# ------------------------------------------------------------------ 输出
# 控制台 UTF-8：后台重定向到文件时 Python 会用 locale(GBK)，
# 打印 ✓ / ★ 会 UnicodeEncodeError 直接把进程搞死。必须钉死。
def force_utf8():
    for s in ("stdout", "stderr"):
        try:
            getattr(sys, s).reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def say(msg=""):
    try:
        print(msg, flush=True)
    except Exception:
        pass


def load_json(p, default=None):
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return default

def max_url_t(buckets=None):
    """扫描缓存，返回本剧直链里最大的 t（hex 时间戳）。

    为什么必须按【目标桶】作用域：
      全桶统算会被别的小程序一条更晚的 URL 顶到未来，
      把本剧的所有直链都挡在时间闸门之外（实测踩过：基线 0x6aa29221
      比本剧最新直链 0x6aa253f7 晚了 4 个多小时 → 一集都收不到）。
    """
    mx = 0
    want = set(buckets or [])
    for f in cache_files(False):
        try:
            data = read_shared(f)
        except OSError:
            continue
        for m in URL_RE.finditer(data):
            if want and m.group(2).decode() not in want:
                continue
            mx = max(mx, int(m.group(4), 16))
    return mx


def copy_media(source, destination):
    """Publish media without replacing an existing different file."""
    import filecmp
    import shutil
    if os.path.exists(destination):
        if filecmp.cmp(source, destination, shallow=False):
            return
        raise FileExistsError("Different media already exists: " + str(destination))
    with open(source, "rb") as src, open(destination, "xb") as dst:
        shutil.copyfileobj(src, dst)
