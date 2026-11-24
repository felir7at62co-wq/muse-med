#!/usr/bin/env python3
"""Print one SHA-256 over a source tree: every file's relative path, exec bit and content hash, and every symlink's target.

Usage: manifest.py <root> [--list]. The same script runs on the Mac (over `git archive S`) and on the server (over the
reconstructed tree), so equal output means the trees are equal for building. Directories themselves are not recorded.
"""
import hashlib
import os
import sys

root = sys.argv[1]
rows = []
for dirpath, dirnames, filenames in os.walk(root):
    for name in dirnames + filenames:
        path = os.path.join(dirpath, name)
        rel = os.fsencode(os.path.relpath(path, root))
        if os.path.islink(path):
            rows.append(rel + b'\0L\0' + os.fsencode(os.readlink(path)))
        elif os.path.isfile(path):
            digest = hashlib.sha256()
            with open(path, 'rb') as handle:
                for chunk in iter(lambda: handle.read(1 << 20), b''):
                    digest.update(chunk)
            mode = b'x' if os.stat(path).st_mode & 0o100 else b'-'
            rows.append(rel + b'\0F' + mode + b'\0' + digest.hexdigest().encode())
rows.sort()
if '--list' in sys.argv:
    sys.stdout.buffer.write(b'\n'.join(rows) + b'\n')
else:
    print(hashlib.sha256(b'\n'.join(rows)).hexdigest(), len(rows))
