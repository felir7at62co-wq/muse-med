#!/usr/bin/env python3
"""Exports the Muse-account-to-Feishu links the data station needs, and nothing else.

Runs as root on the server from /srv/muse-data-web/runtime/ (see deploy/muse-data-feishu-links.timer). Reads the Muse account file, which also holds
password hashes, and writes only username, account ID, disabled flag and Feishu app ID / open_id per account to a
station-readable file, atomically, mode 0640 root:muse-data-web. Prints counts only.

Usage: export-muse-feishu-links.py [ACCOUNTS_JSON] [OUTPUT_JSON]
"""
import grp
import json
import os
import sys
import tempfile
from datetime import datetime, timezone

source = sys.argv[1] if len(sys.argv) > 1 else '/var/lib/muse/accounts/accounts.json'
target = sys.argv[2] if len(sys.argv) > 2 else '/srv/muse-data-web/access/muse-feishu-links.json'

with open(source, encoding='utf-8') as handle:
    accounts = json.load(handle)['accounts']
links = []
for account in accounts:
    feishu = [{'appId': str(item.get('appId', '')), 'openId': str(item.get('openId', ''))}
              for item in account.get('feishuIdentities') or [] if item.get('openId')]
    if feishu:
        links.append({'username': account['username'], 'accountId': account['id'], 'disabled': bool(account.get('disabled')), 'feishu': feishu})
document = {'version': 1, 'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'accounts': links}

directory = os.path.dirname(target)
descriptor, temporary = tempfile.mkstemp(dir=directory, prefix='.muse-feishu-links-')
try:
    with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
        json.dump(document, handle, ensure_ascii=False)
    os.chown(temporary, 0, grp.getgrnam('muse-data-web').gr_gid)
    os.chmod(temporary, 0o640)
    os.replace(temporary, target)
except BaseException:
    os.unlink(temporary)
    raise
print(f'linked accounts: {len(links)} of {len(accounts)}')
