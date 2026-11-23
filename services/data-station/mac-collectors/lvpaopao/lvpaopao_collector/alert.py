"""Optional Mac-side Feishu alert through `lark-cli`, used only when the data station itself is unreachable."""
from __future__ import annotations

import hashlib
import os


class Alerter:
    """Sends a text message to the configured chat or user; disabled when neither is configured."""

    def __init__(self, config, mac, log):
        self.config = config
        self.mac = mac
        self.log = log

    @property
    def enabled(self) -> bool:
        """Whether a chat id or user open_id is configured."""
        return bool(self.config['alert']['chatId'] or self.config['alert']['userId'])

    def send(self, text: str) -> bool:
        """Send `text`; returns `True` when lark-cli exited 0 (or alerts are off, so the caller does not retry)."""
        if not self.enabled:
            return True
        alert = self.config['alert']
        target = ['--chat-id', alert['chatId']] if alert['chatId'] else ['--user-id', alert['userId']]
        key = hashlib.sha256(text.encode('utf8')).hexdigest()[:40]
        argv = [alert['larkCli'], 'im', '+messages-send', *target, '--text', text.lstrip('@-'), '--idempotency-key', key]
        env = {'PATH': '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', 'HOME': os.path.expanduser('~')}
        try:
            code = self.mac.run_command(argv, 60, env)
        except OSError as error:
            self.log('warn', f'lark-cli failed: {error}')
            return False
        if code != 0:
            self.log('warn', f'lark-cli exited {code}')
        return code == 0
