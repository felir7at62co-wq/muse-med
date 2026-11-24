#!/usr/bin/env python3
"""Move shipped and applied entries of /opt/muse/cloud/staging/queue.md to staging/shipped/<release>.md.

  finish-queue.py blocks                 print the queue's entries (header, status, commit tokens) and its sha256 as JSON
  finish-queue.py apply < plan.json      plan: {"queueSHA", "release", "sha", "ship": [header], "applied": [header]}
Apply refuses when queue.md changed since `blocks` (compare-and-swap), keeps a backup, and rewrites atomically.
Entries named in neither list stay in the queue unchanged.
"""
import hashlib
import json
import os
import pathlib
import re
import sys
import time

STAGING = pathlib.Path('/opt/muse/cloud/staging')
QUEUE = STAGING / 'queue.md'


def parse(text):
    """Split into the preamble and `## ` entries, ignoring headings inside ``` fences (the template)."""
    preamble, blocks, current, fenced = [], [], None, False
    for line in text.splitlines(keepends=True):
        if line.startswith('```'):
            fenced = not fenced
        if not fenced and line.startswith('## '):
            current = [line]
            blocks.append(current)
        elif current is None:
            preamble.append(line)
        else:
            current.append(line)
    return ''.join(preamble), [''.join(b) for b in blocks]


def describe(block):
    header = block.splitlines()[0][3:].strip()
    status = next((l.split(':', 1)[1].strip() for l in block.splitlines() if l.startswith('status:')), '')
    commit = next((l.split(':', 1)[1].strip() for l in block.splitlines() if l.startswith('commit:')), '')
    return {'header': header, 'status': status, 'commit': commit, 'tokens': list(dict.fromkeys(t for t in re.findall(r'\b[0-9a-f]{7,40}\b', commit) if re.search('[a-f]', t)))}


def write(path, text):
    tmp = path.with_name('.' + path.name + '.tmp')
    tmp.write_text(text, encoding='utf-8')
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def main():
    text = QUEUE.read_text(encoding='utf-8')
    digest = hashlib.sha256(text.encode()).hexdigest()
    preamble, blocks = parse(text)
    if sys.argv[1:] == ['blocks']:
        print(json.dumps({'queueSHA': digest, 'entries': [describe(b) for b in blocks]}, ensure_ascii=False))
        return 0
    if sys.argv[1:] != ['apply']:
        print(__doc__, file=sys.stderr)
        return 64
    plan = json.load(sys.stdin)
    if plan['queueSHA'] != digest:
        print('STOP: queue.md changed since the plan was made; run finish.sh again', file=sys.stderr)
        return 1
    release, short = plan['release'], plan['sha'][:10]
    os.environ['TZ'] = 'Asia/Shanghai'
    time.tzset()
    stamp = time.strftime('%Y-%m-%d %H:%M CST')
    keep, moved = [], []
    for block in blocks:
        header = describe(block)['header']
        if header in plan.get('ship', []):
            moved.append(re.sub(r'(?m)^status:.*$', f'status: shipped in release {release} ({short}), {stamp}', block, count=1))
        elif header in plan.get('applied', []):
            moved.append(re.sub(r'(?m)^status:.*$', lambda m: m.group(0) + f' — recorded with release {release} ({short})', block, count=1))
        else:
            keep.append(block)
    if not moved:
        print('nothing to move')
        return 0
    (STAGING / f'queue.md.before-{short}').write_text(text, encoding='utf-8')
    shipped = STAGING / 'shipped' / f'{release}.md'
    existing = shipped.read_text(encoding='utf-8') if shipped.exists() else f'# Shipped with cloud Muse release {release} ({plan["sha"]})\n\n'
    write(shipped, existing + ''.join(b if b.endswith('\n\n') else b.rstrip('\n') + '\n\n' for b in moved))
    write(QUEUE, preamble.rstrip('\n') + '\n\n' + ''.join(keep).rstrip('\n') + ('\n' if keep else ''))
    print(f'moved {len(moved)} entr{"y" if len(moved) == 1 else "ies"} to {shipped}; {len(keep)} stay in queue.md')
    return 0


if __name__ == '__main__':
    sys.exit(main())
