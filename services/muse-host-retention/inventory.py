"""Read host references without exporting process arguments, credentials or configuration bodies."""

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time

PATH = re.compile(r'/[^\s\x00\"\'<>;{},()=]+')
RECEIPTS = {'bundle-inputs.json', 'deployment.json', 'deployment-receipt.json', 'promotion-receipt.json', 'shipment.json', 'manifest.json'}


def digest(value):
    """Stable digest for policy, references and filesystem observations."""
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def identity(path):
    """lstat identity prevents following an object replaced by a symlink."""
    info = Path(path).lstat()
    return {'dev': info.st_dev, 'ino': info.st_ino, 'size': info.st_size,
            'mtime_ns': info.st_mtime_ns, 'mode': info.st_mode}


def beneath(path, root):
    """Match a component, never a string prefix such as releases-old."""
    return path == root or path.startswith(root.rstrip('/') + '/')


def paths(text, roots):
    """Extract only paths in configured retention roots; raw text never reaches reports."""
    found = set()
    for match in PATH.findall(text):
        candidate = match.rstrip(':').removesuffix(' (deleted)')
        if any(beneath(candidate, root) for root in roots):
            found.add(candidate)
            resolved = str(Path(candidate).resolve())
            if resolved != candidate:
                found.add(resolved)
    return sorted(found)


def execute(argv):
    """A failed reference command blocks cleanup instead of implying no references."""
    result = subprocess.run(argv, capture_output=True, text=True, timeout=60,
                            env={**os.environ, 'LC_ALL': 'C', 'SYSTEMD_COLORS': '0'})
    if result.returncode:
        raise RuntimeError('Reference command failed: ' + argv[0])
    return result.stdout


def references(roots, *, proc=Path('/proc'), command=execute):
    """Inspect running processes, installed systemd configuration, Nginx and Docker mounts."""
    refs = []
    def add(kind, owner, values):
        for path in values:
            refs.append({'kind': kind, 'owner': owner, 'path': path})
    # Installed units include disabled services that an operator may start later.
    for base in (Path('/etc/systemd/system'), Path('/etc/nginx')):
        if not base.exists():
            raise RuntimeError('Required configuration root missing')
        for path in base.rglob('*'):
            if path.is_symlink():
                add('configuration-link', str(path), paths(str(path.resolve()), roots))
            elif path.is_file():
                if path.stat().st_size > 2 * 1024**2:
                    raise RuntimeError('Reference configuration exceeds bound')
                try:
                    add('installed-configuration', str(path), paths(path.read_text(), roots))
                except UnicodeError:
                    raise RuntimeError('Reference configuration is not text') from None
    units = command(['systemctl', 'list-units', '--all', '--type=service', '--type=timer', '--type=socket', '--no-legend', '--plain'])
    names = [line.split()[0] for line in units.splitlines() if line.split() and 'muse' in line.split()[0]]
    if names:
        effective = command(['systemctl', 'show', *names, '--property=ExecStart,ExecStartPre,ExecStartPost,WorkingDirectory,RootDirectory,EnvironmentFiles,FragmentPath,DropInPaths'])
        add('effective-systemd', 'systemd', paths(effective, roots))
        # Resolve references carried by environment files without persisting their values.
        for row in effective.splitlines():
            if row.startswith('EnvironmentFiles='):
                for file in PATH.findall(row):
                    p = Path(file)
                    if p.is_file():
                        if p.stat().st_size > 1024**2:
                            raise RuntimeError('Environment reference file exceeds bound')
                        add('environment-file', str(p), paths(p.read_text(), roots))
    add('effective-nginx', 'nginx', paths(command(['nginx', '-T']), roots))
    containers = command(['docker', 'ps', '-aq']).split()
    if containers:
        values = json.loads(command(['docker', 'inspect', *containers]))
        for row in values:
            owner = row['Name']
            for mount in row.get('Mounts', []):
                add('container-mount', owner, paths(mount['Source'], roots))
            # Stopped containers are also protected: their next start must remain possible.
            config = row.get('Config', {})
            add('container-command', owner, paths('\n'.join(config.get('Entrypoint') or []) + '\n' + '\n'.join(config.get('Cmd') or []), roots))
    opened = set()
    for process in proc.iterdir():
        if not process.name.isdigit():
            continue
        try:
            for item in ('cwd', 'exe', 'root'):
                try:
                    target = os.readlink(process / item)
                    add('process-' + item, process.name, paths(target, roots))
                except FileNotFoundError:
                    pass
            add('process-command', process.name, paths((process / 'cmdline').read_bytes().decode(errors='replace'), roots))
            for fd in (process / 'fd').iterdir():
                try:
                    target = os.readlink(fd).removesuffix(' (deleted)')
                    if target.startswith('/'):
                        opened.add(target)
                    add('open-descriptor', process.name, paths(target, roots))
                except FileNotFoundError:
                    pass
        except (FileNotFoundError, ProcessLookupError):
            continue
        # Permission and other errors propagate; an unreadable process is not an absent reference.
    return sorted(refs, key=lambda row: (row['path'], row['kind'], row['owner'])), sorted(opened)


def tree(path, limit):
    """Fingerprint immutable release entries and collect cross-release symlinks without following them."""
    result, links, byte_count = [], [], 0
    for base, directories, files in os.walk(path, followlinks=False):
        for name in sorted(directories + files):
            file = Path(base) / name
            info = identity(file)
            relative = str(file.relative_to(path))
            row = [relative, info]
            if stat.S_ISLNK(info['mode']):
                target = os.readlink(file)
                row.append(target)
                links.append(str(file.resolve()))
            elif stat.S_ISREG(info['mode']):
                byte_count += info['size']
            result.append(row)
            if len(result) > limit:
                raise RuntimeError('Release tree exceeds inspection limit')
    return {'hash': digest(sorted(result)), 'bytes': byte_count, 'links': sorted(set(links)), 'entries': len(result)}


def scan(policy, *, reference_reader=references, command=execute):
    """A complete snapshot is required before any candidate can be selected."""
    roots = sorted(set(group['root'] for group in policy['release_groups']))
    logs = policy['log_roots']
    refs, opened = reference_reader(roots + logs)
    releases, archives = [], []
    for root in roots:
        directory = Path(root)
        if not directory.is_dir() or directory.is_symlink():
            raise RuntimeError('Release root must be an existing real directory')
        for child in sorted(directory.iterdir()):
            if child.is_symlink() or not child.is_dir():
                releases.append({'path': str(child), 'group': None, 'protected': 'unknown-object'})
                continue
            groups = [group for group in policy['release_groups'] if group['root'] == root and re.fullmatch(group['pattern'], child.name)]
            if len(groups) != 1:
                releases.append({'path': str(child), 'group': None, 'protected': 'unknown-family'})
                continue
            group = groups[0]
            entry = {'path': str(child), 'group': group['name'], 'identity': identity(child), **tree(child, policy['max_tree_entries'])}
            entry['required_files_present'] = all((child / file).is_file() for file in group['required_files'])
            entry['metadata'] = []
            for name in RECEIPTS:
                f = child / name
                if f.is_file() and not f.is_symlink():
                    if f.stat().st_size > 2 * 1024**2:
                        raise RuntimeError('Release receipt exceeds inspection limit')
                    raw = f.read_bytes()
                    entry['metadata'].append([name, hashlib.sha256(raw).hexdigest()])
                    # Explicit paths in receipts and rollback scripts remain protected even when historical.
                    for value in paths(raw.decode(), roots):
                        refs.append({'kind': 'release-receipt', 'owner': str(f), 'path': value})
            for value in entry['links']:
                for target in paths(value, roots):
                    refs.append({'kind': 'release-link', 'owner': str(child), 'path': target})
            releases.append(entry)
    for root in logs:
        if not Path(root).is_dir() or Path(root).is_symlink():
            raise RuntimeError('Log root must be an existing real directory')
        for base, directories, files in os.walk(root, followlinks=False):
            for name in files:
                file = Path(base) / name
                if file.is_symlink():
                    continue
                info = identity(file)
                if not stat.S_ISREG(info['mode']):
                    continue
                kind = 'nginx' if root.endswith('/nginx') and re.fullmatch(r'[A-Za-z0-9_.-]+\.log\.[0-9]+(?:\.gz)?', name) else 'journal' if '@' in name and name.endswith('.journal') else None
                if kind:
                    item = {'path': str(file), 'kind': kind, 'identity': info, 'bytes': info['size']}
                    if kind == 'nginx':
                        original = re.sub(r'\.[0-9]+(?:\.gz)?$', '', str(file))
                        item['managed'] = any(ref['kind'] == 'effective-nginx' and ref['path'] == original for ref in refs)
                    if kind == 'journal':
                        header = command(['journalctl', '--header', '--file', str(file)])
                        item['archived'] = bool(re.search(r'^State:\s+ARCHIVED$', header, re.M))
                        tail = re.search(r'^Tail realtime timestamp:.*\(([0-9a-f]+)\)$', header, re.M)
                        item['last_entry'] = int(tail.group(1), 16) / 1000000 if tail else None
                    archives.append(item)
    return {'observed_at': time.time(), 'complete': True, 'references': refs, 'opened': opened,
            'releases': releases, 'logs': archives}
