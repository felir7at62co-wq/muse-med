"""密钥脱敏：存库的报错、任务结果和日志里不能出现密钥。**唯一定义处**。

## 为什么需要

供应商的报错原文会原样进 `jobs.error`、`shots.fail_reason` 等字段，网页任务中心
直接展示；日志里也常带请求地址和异常原文。有的供应商会在报错里回显请求头或
请求体（RunningHub 的 `apiKey` 就放在请求体里），于是密钥会一路落到库里、日志里、
浏览器里。

## 三个入口

- `redact_text`：给人看的报错文本。先替换本服务**已配置的密钥原值**（只留末 4 位，
  方便认出是哪一把），再按形状抹掉 `Bearer …`、`apiKey=…`、`?key=…`、URL 签名等。
- `redact_json_text`：任务结果这类 JSON 文本。已配置的密钥原值处处替换；按形状抹的
  规则只用在 `error` / `message` 一类字段上 —— 结果里的预签名图片地址本身就带签名，
  全量按形状抹会让图片打不开。
- `install_log_redaction`：所有日志在格式化时过一遍 `redact_text`，异常堆栈也一样。

库写入的统一挂点在 `app/db.py`（`before_flush`）；接口报错（`HTTPException` 的 detail）
的统一挂点在 `app/main.py` 的异常处理。不靠每个写报错的地方各自记得调用。
"""
from __future__ import annotations

import json
import logging
import os
import re
from functools import lru_cache

#: 抹掉后留下的占位。
HIDDEN = "[已隐藏]"

#: 名字像密钥的配置项 / 环境变量（`llm_max_tokens`、`tos_key_prefix` 这类不是密钥）。
_SECRET_NAME = re.compile(r"(?i)(key|secret|token|password|passwd|credential|(^|_)ak$|(^|_)sk$)")
_NOT_SECRET_NAME = re.compile(r"(?i)(tokens$|key_prefix$|_model$|_url$|_base$)")
#: 短于这个长度的值不当密钥原值替换，避免把常见短词误抹。
_MIN_SECRET_LEN = 8

_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}"), r"\1 " + HIDDEN),
    (re.compile(r"(?i)((?<![A-Za-z0-9])(?:api[_-]?key|apikey|x-api-key|access[_-]?key(?:[_-]?(?:id|secret))?"
                r"|secret(?:[_-]?(?:key|access[_-]?key))?|client[_-]?secret|app[_-]?secret|password|passwd"
                r"|authorization|token|access[_-]?token|refresh[_-]?token|signature"
                r"|x-(?:tos|amz)-(?:signature|credential|security-token))[\"']?\s*[:=]\s*[\"']?)"
                r"[^\s\"'&,;{}\[\]]{6,}"), r"\1" + HIDDEN),
    (re.compile(r"(?i)([?&](?:key|api_?key|token|access_token|sig)=)[^&\s\"'<>]+"), r"\1" + HIDDEN),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{16,}"), "sk-" + HIDDEN),
    (re.compile(r"\bAKLT[A-Za-z0-9_-]{16,}"), "AKLT" + HIDDEN),
    (re.compile(r"\bLTAI[A-Za-z0-9]{12,}"), "LTAI" + HIDDEN),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"), HIDDEN),
)

#: JSON 里这些字段装的是报错文本，按形状抹的规则也用在它们上面。
_ERROR_FIELDS = frozenset({"error", "err", "errors", "message", "msg", "detail", "reason",
                           "fail_reason", "provider_failure", "exception"})


def _split_values(value: object) -> list[str]:
    if isinstance(value, (list, tuple, set)):
        return [part for item in value for part in _split_values(item)]
    if not isinstance(value, str):
        return []
    return [part for part in re.split(r"[\s,;]+", value) if len(part) >= _MIN_SECRET_LEN]


@lru_cache(maxsize=1)
def known_secrets() -> tuple[str, ...]:
    """本进程已配置的密钥原值，长的在前（先替换长的，免得短值截断长值）。

    来源：`Settings` 里名字像密钥的字段，加上名字像密钥的环境变量（有两处代码
    绕过 Settings 直接读环境变量）。配置变了要调 `known_secrets.cache_clear()`。
    """
    found: set[str] = set()
    try:
        from .config import get_settings
        settings = get_settings()
        for name in type(settings).model_fields:
            if _SECRET_NAME.search(name) and not _NOT_SECRET_NAME.search(name):
                found.update(_split_values(getattr(settings, name, None)))
    except Exception as error:  # noqa: BLE001 —— 配置读不出来也要能按形状脱敏
        logging.getLogger(__name__).warning("密钥脱敏：读取配置失败（%s），只按形状脱敏", type(error).__name__)
    for name, value in os.environ.items():
        if _SECRET_NAME.search(name) and not _NOT_SECRET_NAME.search(name):
            found.update(_split_values(value))
    return tuple(sorted(found, key=len, reverse=True))


def _hide_known(text: str) -> str:
    for secret in known_secrets():
        if secret in text:
            text = text.replace(secret, f"[已隐藏密钥 …{secret[-4:]}]")
    return text


def redact_text(text: str | None) -> str | None:
    """给人看的文本：去掉已配置的密钥原值和形状像密钥、令牌、签名的片段。"""
    if not text:
        return text
    text = _hide_known(text)
    for pattern, replacement in _PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def _redact_value(value: object, under_error: bool) -> object:
    if isinstance(value, str):
        return redact_text(value) if under_error else _hide_known(value)
    if isinstance(value, list):
        return [_redact_value(item, under_error) for item in value]
    if isinstance(value, dict):
        return {key: _redact_value(item, under_error or str(key).lower() in _ERROR_FIELDS)
                for key, item in value.items()}
    return value


def redact_structure(value: object) -> object:
    """已解析的 JSON 值：规则同 `redact_json_text`（接口报错的 detail 用它）。"""
    return _redact_value(value, False)


def redact_json_text(text: str | None) -> str | None:
    """JSON 文本（任务结果等）：密钥原值处处替换，按形状抹只用在报错字段上。

    不是合法 JSON 时只替换密钥原值，原文其余部分不动。内容没变时原样返回，
    不改写 JSON 的格式。
    """
    if not text:
        return text
    hidden = _hide_known(text)
    try:
        value = json.loads(hidden)
    except ValueError:
        return hidden
    redacted = _redact_value(value, False)
    if redacted == value:
        return hidden
    return json.dumps(redacted, ensure_ascii=False)


class _RedactedRecord(logging.LogRecord):
    """日志记录：消息和异常堆栈在格式化时脱敏，对所有 logger 和 handler 都生效。"""

    def getMessage(self) -> str:  # noqa: N802 —— 覆盖标准库方法名
        return redact_text(super().getMessage()) or ""

    @property
    def exc_text(self) -> str | None:
        return self.__dict__.get("_redacted_exc_text")

    @exc_text.setter
    def exc_text(self, value: str | None) -> None:
        self.__dict__["_redacted_exc_text"] = redact_text(value) if isinstance(value, str) else value


_installed = False


def install_log_redaction() -> None:
    """让之后创建的每条日志都脱敏。可重复调用。"""
    global _installed
    if _installed:
        return
    previous = logging.getLogRecordFactory()

    def factory(*args, **kwargs) -> logging.LogRecord:
        record = previous(*args, **kwargs)
        if type(record) is logging.LogRecord:
            exc_text = record.__dict__.pop("exc_text", None)
            record.__class__ = _RedactedRecord
            record.exc_text = exc_text
        return record

    logging.setLogRecordFactory(factory)
    _installed = True
