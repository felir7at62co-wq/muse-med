"""Independent host cleanup audit, 24-hour gate and recoverable quarantine."""

from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import time
import uuid

from inventory import scan, identity, tree, beneath, digest
from policy import load, policy_hash, plan


SCHEMA_VERSION = 1


def code_hash():
    """Bind approval to the exact collector, planner, executor and CLI."""
    value = hashlib.sha256()
    for name in ('inventory.py', 'policy.py', 'engine.py', 'cli.py'):
        value.update(name.encode()); value.update(Path(__file__).with_name(name).read_bytes())
    return value.hexdigest()


def atomic(path, value):
    """Publish owner-only JSON without following an existing target symlink."""
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.parent / ('.' + path.name + '-' + str(uuid.uuid4()))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w') as handle:
            json.dump(value, handle, indent=2); handle.write('\n'); handle.flush(); os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def parent_fd(path):
    """Open each real ancestor without following symlinks; operations stay relative to this descriptor."""
    parent = Path(path).parent
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parent.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = child
        yield fd
    finally:
        os.close(fd)


class Engine:
    """One host timer and all deployment writers share the state directory cleanup.lock."""

    def __init__(self, policy_file, *, reader=scan, clock=time.time):
        self.path = Path(policy_file)
        self.policy = load(self.path)
        self.state = Path(self.policy['state_dir'])
        self.state.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.state.is_symlink() or self.state.resolve() != self.state:
            raise ValueError('Retention state cannot traverse symlinks')
        self.db = sqlite3.connect(self.state/'audit.sqlite3', isolation_level=None)
        self.db.row_factory = sqlite3.Row
        if self.db.execute('PRAGMA user_version').fetchone()[0] not in (0, SCHEMA_VERSION):
            self.db.close(); raise ValueError('Unsupported host audit version')
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('CREATE TABLE IF NOT EXISTS observations (id INTEGER PRIMARY KEY,at REAL NOT NULL,code TEXT NOT NULL,policy TEXT NOT NULL,payload TEXT NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS quarantine (id TEXT PRIMARY KEY,original TEXT NOT NULL,target TEXT NOT NULL,at REAL NOT NULL,state TEXT NOT NULL,facts TEXT NOT NULL)')
        self.db.execute(f'PRAGMA user_version={SCHEMA_VERSION}')
        (self.state/'audit.sqlite3').chmod(0o600)
        self.reader, self.clock = reader, clock
        self.restore_pending=False

    def close(self):
        self.db.close()

    @contextmanager
    def lock(self):
        descriptor = os.open(self.state/'cleanup.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield
        finally:
            os.close(descriptor)

    def observe(self):
        self.policy = load(self.path)
        snapshot = self.reader(self.policy)
        decisions = plan(snapshot, self.policy, self.clock())
        return snapshot, decisions

    def review(self, start=None, end=None, first_id=0, last_id=9223372036854775807):
        """Clock regressions, gaps, errors and changed policy/code reject approval."""
        now = self.clock()
        rows = self.db.execute('SELECT * FROM observations WHERE at>=? AND at<=? AND id>=? AND id<=? ORDER BY id',
            (start if start is not None else now-self.policy['preview_seconds']-self.policy['maximum_gap_seconds'], end if end is not None else now, first_id, last_id)).fetchall()
        if len(rows)<2 or rows[-1]['at']-rows[0]['at']<self.policy['preview_seconds']:
            raise ValueError('preview-too-short')
        for left,right in zip(rows,rows[1:]):
            if not 0<right['at']-left['at']<=self.policy['maximum_gap_seconds']:
                raise ValueError('preview-not-continuous')
        for row in rows:
            value=json.loads(row['payload'])
            if row['code']!=code_hash() or row['policy']!=policy_hash(self.policy) or value.get('mode')!='dry-run' or value.get('error') or value.get('deleted') or value.get('moved'):
                raise ValueError('preview-not-qualified')
        return {'code':code_hash(),'policy':policy_hash(self.policy),'start':rows[0]['at'],'end':rows[-1]['at'],'observations':len(rows),'first_id':rows[0]['id'],'last_id':rows[-1]['id']}

    def approved(self):
        approval=json.loads((self.state/'approval.json').read_text())
        if self.review(approval['start'],approval['end'],approval['first_id'],approval['last_id'])!=approval:
            raise ValueError('approval-mismatch')
        current=load(self.path)
        if current['mode']!='enabled' or policy_hash(current)!=policy_hash(self.policy):
            raise ValueError('cleanup-disabled-or-policy-changed')

    def candidate(self, selected):
        """Reinspect every reference and preserve the exact filesystem generation before mutation."""
        self.approved()
        snapshot, rows=self.observe()
        actual=next((row for row in rows if row['path']==selected['path']),None)
        if actual is None or not actual['eligible'] or actual['identity']!=selected['identity'] or actual.get('hash')!=selected.get('hash'):
            raise ValueError('candidate-changed-or-protected')
        return actual

    def move(self, selected):
        """Quarantine atomically before any irreversible deletion; the move itself is journaled first."""
        actual=self.candidate(selected)
        original=Path(actual['path'])
        root=next((group['root'] for group in self.policy['release_groups'] if group['name']==actual.get('group')),None)
        if root is None:
            root=next(root for root in self.policy['log_roots'] if beneath(str(original),root))
        base=Path(root)/'.muse-retention-quarantine'
        if base.exists() and (base.is_symlink() or base.stat().st_uid!=os.getuid() or base.stat().st_mode&0o077):
            raise ValueError('unsafe-quarantine-root')
        base.mkdir(mode=0o700,exist_ok=True)
        key=str(uuid.uuid4()); directory=base/key; directory.mkdir(mode=0o700)
        target=directory/'payload'
        if base.stat().st_dev!=original.lstat().st_dev:
            raise ValueError('cross-device-quarantine-refused')
        self.db.execute('INSERT INTO quarantine VALUES (?,?,?,?,?,?)',(key,str(original),str(target),self.clock(),'moving',json.dumps(actual)))
        with parent_fd(original) as source_fd,parent_fd(target) as target_fd:
            if identity(original)!=actual['identity']:
                raise ValueError('candidate-replaced-before-move')
            os.rename(original.name,target.name,src_dir_fd=source_fd,dst_dir_fd=target_fd)
        self.db.execute("UPDATE quarantine SET state='quarantined' WHERE id=?",(key,))
        return key

    def referenced_quarantine(self, snapshot):
        """Any new reference restores the entire pending batch, including interdependent versions."""
        pending=self.db.execute("SELECT * FROM quarantine WHERE state NOT IN ('purged','restored')").fetchall()
        for item in pending:
            original,target=item['original'],item['target']
            refs=any(beneath(ref['path'],original) or beneath(ref['path'],target) for ref in snapshot['references'] if not beneath(ref['owner'],target))
            opened=any(beneath(path,target) or beneath(path,original) for path in snapshot['opened'])
            pinned=any(beneath(pin,original) or beneath(original,pin) for pin in self.policy['pins'])
            if refs or opened or pinned:
                return True
        return False

    def reconcile(self, row, *, allow_purge=True):
        """Return a newly referenced quarantined object; never overwrite a replacement at the old path."""
        self.approved()
        original,target=Path(row['original']),Path(row['target'])
        facts=json.loads(row['facts'])
        if row['state']=='purging':
            raise ValueError('uncertain-purge-requires-review')
        if row['state']=='moving':
            if target.exists() and not original.exists():
                self.db.execute("UPDATE quarantine SET state='quarantined' WHERE id=?",(row['id'],))
            else:
                raise ValueError('quarantine-move-needs-review')
        if not target.exists() or target.is_symlink():
            raise ValueError('quarantine-object-missing-or-replaced')
        snapshot,_=self.observe()
        self.restore_pending=self.restore_pending or self.referenced_quarantine(snapshot)
        if self.restore_pending:
            if original.exists() or original.is_symlink():
                raise ValueError('cannot-restore-over-replacement')
            with parent_fd(original) as output_fd,parent_fd(target) as source_fd:
                os.rename(target.name,original.name,src_dir_fd=source_fd,dst_dir_fd=output_fd)
            self.db.execute("UPDATE quarantine SET state='restored' WHERE id=?",(row['id'],))
            return 'restored'
        if not allow_purge or snapshot.get('deployment_busy') or self.clock()-row['at']<self.policy['quarantine_seconds']:
            return 'protected'
        if identity(target)!=facts['identity'] or facts['kind']=='release' and tree(target,self.policy['max_tree_entries'])['hash']!=facts['hash']:
            raise ValueError('quarantined-content-changed')
        # Detect rollback inventory shrinkage after a version was moved.
        if facts['kind']=='release':
            available=[item for item in snapshot['releases'] if item.get('group')==facts['group'] and item.get('required_files_present')]
            if len(available)<self.policy['rollback_count']+1:
                if original.exists():
                    raise ValueError('rollback-reserve-shrank-with-replacement')
                with parent_fd(original) as output_fd,parent_fd(target) as source_fd:
                    os.rename(target.name,original.name,src_dir_fd=source_fd,dst_dir_fd=output_fd)
                self.db.execute("UPDATE quarantine SET state='restored' WHERE id=?",(row['id'],));return 'restored'
        self.approved()
        self.db.execute("UPDATE quarantine SET state='purging' WHERE id=?",(row['id'],))
        with parent_fd(target) as descriptor:
            if facts['kind']=='release':
                if not shutil.rmtree.avoids_symlink_attacks:
                    raise ValueError('safe-directory-removal-unavailable')
                shutil.rmtree(target.name,dir_fd=descriptor)
            else:
                os.unlink(target.name,dir_fd=descriptor)
        self.db.execute("UPDATE quarantine SET state='purged' WHERE id=?",(row['id'],))
        return 'purged'

    def tick(self):
        """Dry-run has no target mutations; incomplete or uncertain work blocks later execution."""
        with self.lock():
            result={'mode':load(self.path)['mode'],'deleted':0,'moved':0,'freed_bytes':0,'restored':0}
            try:
                snapshot,rows=self.observe()
                result.update(mode=self.policy['mode'],reference_count=len(snapshot['references']),reference_hash=digest(snapshot['references']),
                              decisions=[{key:row[key] for key in ('path','kind','eligible','reason','bytes') if key in row} for row in rows])
                atomic(self.state/'latest-inventory.json',snapshot)
                if self.policy['mode']=='enabled':
                    self.approved()
                    pending=self.db.execute("SELECT * FROM quarantine WHERE state NOT IN ('purged','restored') ORDER BY at").fetchall()
                    if any(row['state']=='purging' for row in pending):
                        raise ValueError('uncertain-purge-requires-review')
                    self.restore_pending=self.referenced_quarantine(snapshot)
                    for row in pending:
                        facts=json.loads(row['facts'])
                        allow=result['deleted']<self.policy['max_delete_objects'] and result['freed_bytes']+facts['bytes']<=self.policy['max_delete_bytes']
                        action=self.reconcile(row,allow_purge=allow)
                        if action=='purged': result['deleted']+=1; result['freed_bytes']+=facts['bytes']
                        elif action=='restored': result['restored']+=1
                    budget=0
                    # A restoration requires a fresh planning pass on the next timer invocation.
                    for selected in (row for row in rows if row['eligible'] and not result['restored']):
                        if result['moved']>=self.policy['max_delete_objects']:
                            break
                        if budget+selected['bytes']>self.policy['max_delete_bytes']:
                            continue
                        self.move(selected);result['moved']+=1;budget+=selected['bytes']
            except Exception as error:
                result['error']=type(error).__name__
            self.db.execute('INSERT INTO observations(at,code,policy,payload) VALUES (?,?,?,?)',
                            (self.clock(),code_hash(),policy_hash(self.policy),json.dumps(result)))
            atomic(self.state/'status.json',result)
            return result
