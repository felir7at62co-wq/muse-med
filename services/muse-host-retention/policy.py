"""Validated host retention rules and a reference-aware, non-mutating planner."""

import json
from pathlib import Path
import re
import stat

from inventory import beneath, digest


def load(path):
    """Reject unknown rules, overlapping selectors and unsafe retention roots."""
    value = json.loads(Path(path).read_text())
    required = {'version', 'mode', 'interval_seconds', 'maximum_gap_seconds', 'preview_seconds', 'release_days',
                'log_days', 'rollback_count', 'quarantine_seconds', 'max_delete_bytes', 'max_delete_objects',
                'max_tree_entries', 'release_groups', 'log_roots', 'pins', 'state_dir'}
    if set(value) != required or value['version'] != 1 or value['mode'] not in ('dry-run', 'enabled'):
        raise ValueError('Invalid host retention policy')
    for key in required - {'version', 'mode', 'release_groups', 'log_roots', 'pins', 'state_dir'}:
        if type(value[key]) is not int or value[key] <= 0:
            raise ValueError('Retention numbers must be positive integers')
    if value['preview_seconds'] < 86400 or value['release_days'] < 14 or value['log_days'] < 14 or value['rollback_count'] < 2 or value['quarantine_seconds'] < 86400 or value['maximum_gap_seconds'] < value['interval_seconds']:
        raise ValueError('Retention protection cannot be shortened')
    if not Path(value['state_dir']).is_absolute() or not isinstance(value['pins'], list):
        raise ValueError('Invalid retention state or pins')
    names = set()
    for group in value['release_groups']:
        if set(group) != {'name', 'root', 'pattern', 'required_files'} or group['name'] in names:
            raise ValueError('Invalid release family')
        names.add(group['name'])
        root = Path(group['root'])
        if not root.is_absolute() or root.name != 'releases' or str(root.resolve()) != str(root):
            raise ValueError('Release roots must be real absolute releases directories')
        re.compile(group['pattern'])
        if not group['required_files'] or any(Path(file).is_absolute() or '..' in Path(file).parts for file in group['required_files']):
            raise ValueError('Invalid release requirements')
    for root in value['log_roots']:
        if not Path(root).is_absolute() or Path(root).name not in ('nginx', 'journal') or str(Path(root).resolve()) != root:
            raise ValueError('Only explicit Nginx and journal roots are supported')
    for pin in value['pins']:
        if not any(beneath(pin, group['root']) for group in value['release_groups']):
            raise ValueError('Pins must name releases in the configured roots')
    return value


def policy_hash(policy):
    """Mode changes do not erase the policy that was observed for 24 hours."""
    return digest({key: value for key, value in policy.items() if key != 'mode'})


def plan(snapshot, policy, now):
    """Retain direct references, two rollback candidates per family and their transitive dependencies."""
    if snapshot.get('complete') is not True:
        raise ValueError('An incomplete reference scan cannot produce a cleanup plan')
    releases = snapshot['releases']
    known = {row['path']: row for row in releases if row.get('group')}
    protected = {row['path']: row.get('protected', 'unknown-object') for row in releases if not row.get('group')}
    dependencies = []
    for ref in snapshot['references']:
        owners = [path for path in known if beneath(ref['owner'], path)]
        targets = [path for path in known if beneath(ref['path'], path)]
        for target in targets:
            if not owners:
                protected[target] = 'referenced:' + ref['kind']
            else:
                dependencies.extend((owner, target) for owner in owners if owner != target)
    for row in known.values():
        if not row['required_files_present']:
            protected[row['path']] = 'unverified-build'
    for pin in policy['pins']:
        for path in known:
            if beneath(pin, path) or beneath(path, pin):
                protected[path] = 'operator-pin'
    # Preserve both older rollback choices and recent alternatives. No family is emptied.
    for group in policy['release_groups']:
        members = sorted((row for row in known.values() if row['group'] == group['name'] and row['required_files_present']),
                         key=lambda row: (row['identity']['mtime_ns'], row['path']), reverse=True)
        already_current = any(row['path'] in protected for row in members)
        keep = policy['rollback_count'] if already_current else policy['rollback_count'] + 1
        for row in (row for row in members if row['path'] not in protected):
            if keep <= 0:
                break
            protected[row['path']] = 'rollback-reserve'
            keep -= 1
    changed = True
    while changed:
        changed = False
        for owner, target in dependencies:
            if owner in protected and target not in protected:
                protected[target] = 'retained-version-dependency'
                changed = True
    output = []
    for row in releases:
        reason = 'deployment-in-progress' if snapshot.get('deployment_busy') else protected.get(row['path'])
        if reason is None and now - row['identity']['mtime_ns'] / 1e9 < policy['release_days'] * 86400:
            reason = 'release-retention-period'
        output.append({**row, 'kind': 'release', 'eligible': reason is None, 'reason': reason or 'unreferenced-expired-release'})
    for row in snapshot['logs']:
        reason = None
        if row.get('kind') == 'nginx' and row.get('managed') is not True:
            reason = 'unknown-log-owner'
        elif row['path'] in snapshot['opened']:
            reason = 'open-log-file'
        elif now - row['identity']['mtime_ns'] / 1e9 < policy['log_days'] * 86400:
            reason = 'log-retention-period'
        elif row['kind'] == 'journal' and (not row.get('archived') or row.get('last_entry') is None or now - row['last_entry'] < policy['log_days'] * 86400):
            reason = 'journal-not-proven-expired-and-archived'
        output.append({**row, 'kind': 'log', 'format': row['kind'], 'eligible': reason is None, 'reason': reason or 'expired-closed-log'})
    return output
