"""Failure classes and their mapping to the station's reason codes (docs/lvpaopao.md)."""
from __future__ import annotations

TRANSIENT = 'transient'
"""Retry the same call on the same helper generation."""
GENERATION = 'generation'
"""Close this helper generation and retry the run from a fresh preparation."""
HUMAN = 'human'
"""Stop the retry ladder: someone has to act (log in, re-adapt the build, open the mini-program)."""
FATAL = 'fatal'
"""Configuration or installation error; retrying cannot help."""

# Codes from the helper protocol and the plugin bridge (src/jsonl.ts, src/bridge.ts).
TRANSIENT_CODES = frozenset({'busy', 'request-capacity', 'native-timeout', 'target-not-ready', 'capability-not-ready',
                             'request-conflict', 'native-call-timeout'})
HUMAN_CODES = {
    'mac-runtime-build-unsupported': 'build-changed',
    'helper-identity-mismatch': 'build-changed',
    'mac-runtime-home-invalid': 'helper-error',
}
FATAL_CODES = frozenset({'setup-dependency-missing', 'setup-dependency-version-mismatch', 'setup-media-tools-missing',
                         'setup-platform-unsupported', 'setup-python-version-unsupported', 'setup-lifetime-invalid',
                         'setup-callback-limit-invalid', 'setup-directory-invalid', 'setup-resource-invalid',
                         'parameters-invalid', 'operation-not-supported'})
NOT_RUNNING_CODES = frozenset({'mac-isolated-wechat-required', 'mac-runtime-process-changed', 'mac-runtime-ambiguous'})


class CollectError(Exception):
    """A classified collection failure.

    `reason` is a station reason code, `kind` one of TRANSIENT/GENERATION/HUMAN/FATAL, `code` the underlying helper or
    local code, and `message` a short Chinese explanation for the heartbeat.
    """

    def __init__(self, reason: str, kind: str, code: str, message: str = ''):
        super().__init__(code)
        self.reason = reason
        self.kind = kind
        self.code = code
        self.message = message or code


def classify(code: str) -> CollectError:
    """Map a helper error or bootstrap code to a classified failure.

    All operations are read-only, so a generation retry after an unknown outcome is safe.
    """
    if code in TRANSIENT_CODES:
        return CollectError('helper-error', TRANSIENT, code, f'采集组件暂时不可用（{code}）')
    if code in HUMAN_CODES:
        reason = HUMAN_CODES[code]
        text = '微信版本或文件哈希变了，需要重新适配' if reason == 'build-changed' else f'隔离微信的私有目录无效（{code}）'
        return CollectError(reason, HUMAN, code, text)
    if code in FATAL_CODES:
        return CollectError('helper-error', FATAL, code, f'采集端安装或配置有误（{code}）')
    if code in NOT_RUNNING_CODES:
        return CollectError('wechat-not-running', GENERATION, code, f'隔离微信未运行或刚重启（{code}）')
    return CollectError('helper-error', GENERATION, code, f'采集连接中断（{code}）')
