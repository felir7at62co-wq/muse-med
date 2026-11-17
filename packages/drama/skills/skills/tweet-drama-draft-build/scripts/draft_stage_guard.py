"""Keep active draft materials in place and serialize builds of one draft name.

Windows guards retain kernel handles without delete sharing, rather than relying
on removable marker files. A directory guard prevents moving the stage itself;
call ``protect_file`` for each retained material to prevent its deletion too.
Files created later are not automatically protected from recursive deletion.
"""

import ctypes
from contextlib import ExitStack
import errno
import hashlib
import os
from pathlib import Path


class DraftBuildBusyError(RuntimeError):
    """Another build owns this draft name; do not remove its lock or materials."""


class _WindowsFiles:
    def __init__(self):
        from ctypes import wintypes

        class Overlapped(ctypes.Structure):
            _fields_ = [('Internal', ctypes.c_size_t), ('InternalHigh', ctypes.c_size_t),
                        ('Offset', wintypes.DWORD), ('OffsetHigh', wintypes.DWORD),
                        ('hEvent', wintypes.HANDLE)]

        self.overlapped = Overlapped()
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.create_file = self.kernel.CreateFileW
        self.create_file.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                    ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
                                    wintypes.HANDLE]
        self.create_file.restype = wintypes.HANDLE
        self.close_handle = self.kernel.CloseHandle
        self.close_handle.argtypes = [wintypes.HANDLE]
        self.close_handle.restype = wintypes.BOOL
        self.lock_file = self.kernel.LockFileEx
        self.lock_file.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                                  wintypes.DWORD, wintypes.DWORD,
                                  ctypes.POINTER(Overlapped)]
        self.lock_file.restype = wintypes.BOOL

    def open_guard(self, path, *, directory=False, lock=False):
        # READ|WRITE sharing deliberately excludes FILE_SHARE_DELETE.
        handle = self.create_file(str(path), 0xC0000000 if lock else 0x80000000, 3, None,
                                  4 if lock else 3, 0x02000000 if directory else 0, None)
        if handle == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        return handle

    def acquire(self, handle):
        # LockFileEx is non-reentrant across separately opened handles, including
        # on the same thread; closing the handle also releases the byte lock.
        if not self.lock_file(handle, 3, 0, 1, 0, ctypes.byref(self.overlapped)):
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self, handle):
        if not self.close_handle(handle):
            raise ctypes.WinError(ctypes.get_last_error())


class BuildLease:
    """Hold a nonblocking cross-process lease for one root/name until close.

    The persistent lock file is not a liveness marker and must not be deleted.
    Callers retain this lease until all native children and readback have ended.
    Different draft names have independent leases.
    """

    def __init__(self, drafts_dir, draft_name):
        root = Path(drafts_dir).resolve(strict=True)
        if not root.is_dir():
            raise ValueError('drafts_dir must be an existing directory')
        if not isinstance(draft_name, str) or not draft_name or draft_name in ('.', '..') \
                or any(value in draft_name for value in ('/', '\\', '\0')):
            raise ValueError('draft_name must be a single nonempty directory name')
        target = os.path.normcase(str(root / draft_name))
        digest = hashlib.sha256(target.encode('utf-8')).hexdigest()
        self.path = root / f'.muse-draft-build-{digest}.lock'
        self._handle = None
        self._windows = _WindowsFiles() if os.name == 'nt' else None

    def __enter__(self):
        if self._handle is not None:
            raise RuntimeError('build lease is already held')
        try:
            if self._windows is not None:
                handle = self._windows.open_guard(self.path, lock=True)
                try:
                    self._windows.acquire(handle)
                except BaseException:
                    self._windows.close(handle)
                    raise
            else:
                import fcntl

                handle = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BaseException:
                    os.close(handle)
                    raise
            self._handle = handle
            return self
        except OSError as error:
            busy = getattr(error, 'winerror', None) in (32, 33) if self._windows is not None \
                else error.errno in (errno.EACCES, errno.EAGAIN)
            if busy:
                raise DraftBuildBusyError('this draft is being generated; retain its active materials') from error
            raise

    def close(self):
        """Release only this owner's kernel handle; leave the stable lock file."""
        if self._handle is not None:
            handle, self._handle = self._handle, None
            if self._windows is not None:
                self._windows.close(handle)
            else:
                os.close(handle)

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()


class DraftStageGuard:
    """Prevent Windows stage renames and deletion of explicitly retained files.

    POSIX builds retain their normal file behavior; only BuildLease serializes
    them. This guard changes no ACLs and releases no other operation's handles.
    """

    def __init__(self, stage):
        self.stage = Path(stage).resolve(strict=True)
        if not self.stage.is_dir():
            raise ValueError('stage must be an existing directory')
        self._windows = _WindowsFiles() if os.name == 'nt' else None
        self._cleanup = ExitStack()
        self._entered = False

    def __enter__(self):
        if self._entered:
            raise RuntimeError('stage guard is already held')
        if self._windows is not None:
            handle = self._windows.open_guard(self.stage, directory=True)
            self._cleanup.callback(self._windows.close, handle)
        self._entered = True
        return self

    def protect_file(self, path):
        """Keep an existing regular material inside this stage from unlinking."""
        if not self._entered:
            raise RuntimeError('stage guard must be entered first')
        material = Path(path).resolve(strict=True)
        if not material.is_relative_to(self.stage) or not material.is_file():
            raise ValueError('protected material must be a regular file inside the stage')
        if self._windows is not None:
            handle = self._windows.open_guard(material)
            self._cleanup.callback(self._windows.close, handle)

    def close(self):
        """Release file guards, then the directory guard, after native exit."""
        try:
            self._cleanup.close()
        finally:
            self._entered = False

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()
