"""异常 → 用户能看懂的一行话。**唯一定义处**。

## 为什么单独一个模块

`providers/upscale.py` 与 `providers/video_runninghub.py` 都要用，而后者已被
前者导入（`from .video_runninghub import DEFAULT_INSTANCE_TYPE`），谁先导入谁
都会成环。放这里两边都能安全地模块级导入。

## 两条硬规则

1. **禁止 `repr(e)`**（2026-10-15 用户实测）。`f"{e!r}"` 生成
   `RuntimeError('RH upload HTTP 550: ')` 这种 Python 字面量 —— 用户读不懂、
   也不知道该找谁。这条报错真实出现在任务中心的失败原因列里。
2. **`str(e)` 可能是空串**，必须退回类名。httpx 的超时/连接类异常 str() 为空，
   不兜底的话报错栏显示一片空白 —— 比报错更难排查（`jobs.py` 里为同一个坑
   写过注释）。
"""
from __future__ import annotations

from .redact import redact_text


def human_error(e: BaseException, limit: int = 200) -> str:
    """异常 → 一行可读文本（无 repr、无空串）。"""
    msg = str(e).strip()
    if not msg:
        msg = type(e).__name__
    return (redact_text(msg) or msg)[:limit]


#: 上传被拒时值得带出来的响应头。非标准状态码（如 550）的语义常常只留在这里，
#: 而 body 是空的 —— 这正是"看不懂的报错"最常见的成因。
_UPLOAD_HEAD_KEYS = ("server", "cf-ray", "x-request-id", "x-amz-request-id",
                     "content-type", "x-error", "x-reason")


def upload_failed_msg(r, what: str) -> str:
    """上传被上游拒绝时的可排查报错：状态码 + 上游原话 + 关键响应头。

    body 为空时**明确说"没有返回任何内容"**，而不是留一个孤零零的冒号。
    """
    body = (redact_text(r.text or "") or "").strip()
    bits = [f"{what} 上传被上游拒绝（HTTP {r.status_code}"]
    reason = getattr(r, "reason_phrase", "") or ""
    if reason:
        bits.append(f" {reason}")
    bits.append("）")
    out = "".join(bits)
    out += f"｜上游原话：{body[:200]}" if body else "｜上游没有返回任何内容"
    heads = []
    for k in _UPLOAD_HEAD_KEYS:
        v = (r.headers.get(k) or "").strip()
        if v:
            heads.append(f"{k}={v[:80]}")
    if heads:
        out += "｜响应头：" + " ".join(heads)
    return redact_text(out) or out
