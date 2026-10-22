"""Task-local, no-overwrite current-user encrypted media receipts; no network or CLI."""
import atexit
import base64
import ctypes
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
from functools import cache

MAX_FILE_BYTES = 16 * 1024
MAX_URL_BYTES = 8192
FOLDER_NAME = 'secure-media'
FILE_NAME = 'native-media.dpapi.json'
FORMAT = 'windows-dpapi-current-user-v1'
MAC_FILE_NAME = 'native-media.keychain.json'
UI_FORBIDDEN = 1
DWORD = ctypes.c_uint32
BOOL = ctypes.c_int32
PTR = ctypes.c_void_p


class ReceiptFailure(RuntimeError):
    """Sanitized fixed error code; never include a URL, OS error text, or payload."""


@cache
def current_user_protector():
    """Resolve the current platform's protection without changing existing Windows receipts."""
    if sys.platform=='darwin':
        from mac_media_protector import MacCurrentUserKeychain
        protector=MacCurrentUserKeychain()
        atexit.register(protector.close)
        return protector
    return WindowsCurrentUserDpapi()


def _receipt_info(protector):
    return (getattr(protector,'receipt_filename',FILE_NAME),getattr(protector,'receipt_format',FORMAT))


def encrypted_media_path(task_directory):
    """Return this platform's receipt path without loading or accessing a key."""
    return Path(task_directory).resolve()/FOLDER_NAME/(MAC_FILE_NAME if sys.platform=='darwin' else FILE_NAME)


class _Blob(ctypes.Structure):
    _fields_ = [('size', DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]


def _blob(value):
    buffer = (ctypes.c_ubyte * len(value)).from_buffer_copy(value)
    return _Blob(len(value), buffer), buffer


class WindowsCurrentUserDpapi:
    """Current Windows user's DPAPI, with interactive prompts and machine scope disabled."""

    def __init__(self):
        if os.name != 'nt':
            raise ReceiptFailure('windows-dpapi-required')
        self.crypt = ctypes.WinDLL('crypt32', use_last_error=True)
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.advapi = ctypes.WinDLL('advapi32', use_last_error=True)
        self.crypt.CryptProtectData.argtypes = [ctypes.POINTER(_Blob), ctypes.c_wchar_p, ctypes.POINTER(_Blob), PTR, PTR, DWORD, ctypes.POINTER(_Blob)]
        self.crypt.CryptUnprotectData.argtypes = [ctypes.POINTER(_Blob), PTR, ctypes.POINTER(_Blob), PTR, PTR, DWORD, ctypes.POINTER(_Blob)]
        self.crypt.CryptProtectData.restype = self.crypt.CryptUnprotectData.restype = BOOL
        self.kernel.LocalFree.argtypes = [PTR]
        self.kernel.LocalFree.restype = PTR
        self.kernel.GetCurrentProcess.restype = PTR
        self.kernel.CloseHandle.argtypes = [PTR]
        self.advapi.OpenProcessToken.argtypes = [PTR, DWORD, ctypes.POINTER(PTR)]
        self.advapi.GetTokenInformation.argtypes = [PTR, DWORD, PTR, DWORD, ctypes.POINTER(DWORD)]
        self.advapi.ConvertSidToStringSidW.argtypes = [PTR, ctypes.POINTER(ctypes.c_wchar_p)]
        self.advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [ctypes.c_wchar_p, DWORD, ctypes.POINTER(PTR), ctypes.POINTER(DWORD)]
        self.advapi.SetFileSecurityW.argtypes = [ctypes.c_wchar_p, DWORD, PTR]
        self.advapi.GetFileSecurityW.argtypes = [ctypes.c_wchar_p, DWORD, PTR, DWORD, ctypes.POINTER(DWORD)]
        self.advapi.ConvertSecurityDescriptorToStringSecurityDescriptorW.argtypes = [PTR, DWORD, DWORD, ctypes.POINTER(ctypes.c_wchar_p), ctypes.POINTER(DWORD)]

    def _transform(self, value, entropy, decrypt):
        source, source_buffer = _blob(value)
        extra, entropy_buffer = _blob(entropy)
        output = _Blob()
        if decrypt:
            ok = self.crypt.CryptUnprotectData(ctypes.byref(source), None, ctypes.byref(extra), None, None, UI_FORBIDDEN, ctypes.byref(output))
        else:
            ok = self.crypt.CryptProtectData(ctypes.byref(source), 'Muse task media receipt', ctypes.byref(extra), None, None, UI_FORBIDDEN, ctypes.byref(output))
        # Keep ctypes input buffers alive until the synchronous native call returns.
        del source_buffer, entropy_buffer
        if not ok:
            raise ReceiptFailure('dpapi-unprotect-failed' if decrypt else 'dpapi-protect-failed')
        try:
            if not 1 <= output.size <= MAX_FILE_BYTES:
                raise ReceiptFailure('dpapi-output-size-rejected')
            return ctypes.string_at(output.data, output.size)
        finally:
            self.kernel.LocalFree(ctypes.cast(output.data, PTR))

    def protect(self, value, entropy):
        return self._transform(value, entropy, False)

    def unprotect(self, value, entropy):
        return self._transform(value, entropy, True)

    def secure_directory(self, folder):
        """Replace the dedicated receipt directory's DACL with one current-user ACE."""
        token = PTR()
        if not self.advapi.OpenProcessToken(self.kernel.GetCurrentProcess(), 8, ctypes.byref(token)):
            raise ReceiptFailure('receipt-user-token-unavailable')
        sid_text = ctypes.c_wchar_p()
        descriptor = PTR()
        try:
            needed = DWORD()
            self.advapi.GetTokenInformation(token, 1, None, 0, ctypes.byref(needed))
            if not 1 <= needed.value <= 65536:
                raise ReceiptFailure('receipt-user-token-invalid')
            token_buffer = ctypes.create_string_buffer(needed.value)
            if not self.advapi.GetTokenInformation(token, 1, token_buffer, needed, ctypes.byref(needed)):
                raise ReceiptFailure('receipt-user-token-unavailable')
            sid_pointer = ctypes.cast(token_buffer, ctypes.POINTER(PTR))[0]
            if not self.advapi.ConvertSidToStringSidW(sid_pointer, ctypes.byref(sid_text)):
                raise ReceiptFailure('receipt-user-sid-unavailable')
            sddl = 'D:P(A;OICI;FA;;;' + sid_text.value + ')'
            if not self.advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None):
                raise ReceiptFailure('receipt-directory-acl-invalid')
            if not self.advapi.SetFileSecurityW(str(folder), 0x80000004, descriptor):
                raise ReceiptFailure('receipt-directory-acl-failed')
            expected = self._dacl_text(descriptor)
            size = DWORD()
            self.advapi.GetFileSecurityW(str(folder), 4, None, 0, ctypes.byref(size))
            if not 1 <= size.value <= 65536:
                raise ReceiptFailure('receipt-directory-acl-unverified')
            actual = ctypes.create_string_buffer(size.value)
            if not self.advapi.GetFileSecurityW(str(folder), 4, actual, size, ctypes.byref(size)) or self._dacl_text(actual) != expected:
                raise ReceiptFailure('receipt-directory-acl-unverified')
        finally:
            if descriptor.value:
                self.kernel.LocalFree(descriptor)
            if sid_text:
                self.kernel.LocalFree(ctypes.cast(sid_text, PTR))
            self.kernel.CloseHandle(token)

    def _dacl_text(self, descriptor):
        text = ctypes.c_wchar_p()
        if not self.advapi.ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, 4, ctypes.byref(text), None):
            raise ReceiptFailure('receipt-directory-acl-unverified')
        try:
            return text.value
        finally:
            self.kernel.LocalFree(ctypes.cast(text, PTR))


def _binding(value):
    legacy = {'hostAppId', 'srcAppId', 'dramaId', 'serialNo', 'isFirstMediaFree', 'isStraight'}
    episode = {'hostAppId', 'srcAppId', 'dramaId', 'serialNo', 'playAuthorization', 'isStraight'}
    if not isinstance(value, dict) or set(value) not in (legacy, episode):
        raise ReceiptFailure('receipt-binding-invalid')
    for field in ('hostAppId', 'srcAppId'):
        if not isinstance(value[field], str) or re.fullmatch(r'wx[0-9a-f]{16}', value[field]) is None:
            raise ReceiptFailure('receipt-binding-invalid')
    drama_pattern=r'[A-Za-z0-9_-]{1,64}' if set(value)==legacy else r'[A-Za-z0-9._:-]{1,128}'
    if not isinstance(value['dramaId'], str) or re.fullmatch(drama_pattern, value['dramaId']) is None:
        raise ReceiptFailure('receipt-binding-invalid')
    if type(value['serialNo']) is not int or not 1 <= value['serialNo'] <= (1 << 53) - 1 or value['isStraight'] is not True:
        raise ReceiptFailure('receipt-binding-invalid')
    if set(value) == legacy and (value['serialNo'] != 1 or value['isFirstMediaFree'] is not True):
        raise ReceiptFailure('receipt-binding-invalid')
    if set(value) == episode and value['playAuthorization'] != 'native-straight-playback':
        raise ReceiptFailure('receipt-binding-invalid')
    return dict(value)


def _json_bytes(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf8')


def _entropy(binding):
    return hashlib.sha256(b'Muse task-local native media receipt v1\0' + _json_bytes(binding)).digest()


def _folder(task_directory, protector):
    task = Path(task_directory).resolve(strict=True)
    if not task.is_dir():
        raise ReceiptFailure('receipt-task-directory-invalid')
    folder = task / FOLDER_NAME
    folder.mkdir(mode=0o700, exist_ok=True)
    info = folder.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
        raise ReceiptFailure('receipt-directory-link-rejected')
    protector.secure_directory(folder)
    return folder


def _read(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or getattr(info, 'st_file_attributes', 0) & 0x400:
        raise ReceiptFailure('receipt-file-link-rejected')
    if not 1 <= info.st_size <= MAX_FILE_BYTES:
        raise ReceiptFailure('receipt-file-size-rejected')
    raw = path.read_bytes()
    if len(raw) != info.st_size or len(raw) > MAX_FILE_BYTES:
        raise ReceiptFailure('receipt-file-size-rejected')
    return raw


def _load(path, binding, protector):
    try:
        envelope = json.loads(_read(path))
        if not isinstance(envelope, dict) or set(envelope) != {'format', 'ciphertext', 'ciphertextSha256'} or envelope['format'] != _receipt_info(protector)[1]:
            raise ReceiptFailure('receipt-envelope-invalid')
        encrypted = base64.b64decode(envelope['ciphertext'], validate=True)
        if hashlib.sha256(encrypted).hexdigest() != envelope['ciphertextSha256']:
            raise ReceiptFailure('receipt-ciphertext-changed')
        payload = json.loads(protector.unprotect(encrypted, _entropy(binding)))
        if not isinstance(payload, dict) or set(payload) != {'schemaVersion', 'binding', 'createdAtUtc', 'mediaUrl'} or payload['schemaVersion'] != 1 or payload['binding'] != binding:
            raise ReceiptFailure('receipt-payload-invalid')
        _url(payload['mediaUrl'])
        if not isinstance(payload['createdAtUtc'], str) or len(payload['createdAtUtc']) > 40:
            raise ReceiptFailure('receipt-payload-invalid')
        return payload
    except (ValueError, TypeError, KeyError, UnicodeError):
        raise ReceiptFailure('receipt-payload-invalid') from None


def _url(value):
    # Preserve the native address even when downloader policy later rejects its host.
    if not isinstance(value, str) or '\0' in value:
        raise ReceiptFailure('receipt-url-invalid')
    try:
        if not 1 <= len(value.encode('utf8')) <= MAX_URL_BYTES:
            raise ReceiptFailure('receipt-url-invalid')
    except UnicodeError:
        raise ReceiptFailure('receipt-url-invalid') from None


def _summary(path, reused, protector):
    raw = _read(path)
    return {'status': 'encrypted-media-receipt-ready', 'receiptPath': str(path), 'receiptBytes': len(raw), 'receiptSha256': hashlib.sha256(raw).hexdigest(), 'reused': reused, 'protection': _receipt_info(protector)[1], 'currentUser': True, 'machineScope': False, 'uiForbidden': True, 'directoryAccess': 'current-user-only', 'nativeRequestPerformed': False}


def save_media_receipt(task_directory, media_url, binding, *, _protector=None):
    """Seal an already obtained free-episode URL before cleanup; never overwrite another URL.

    task_directory must already exist. binding has exact hostAppId/srcAppId/dramaId,
    Legacy first-episode bindings remain unchanged. Episode bindings require the
    actual serialNo, isStraight=True and playAuthorization=native-straight-playback.
    The return contains no URL.
    _protector is a test dependency port. Production uses Windows DPAPI or Mac Keychain ECIES.
    """
    binding = _binding(binding)
    _url(media_url)
    protector = _protector if _protector is not None else current_user_protector()
    folder = _folder(task_directory, protector)
    path = folder / _receipt_info(protector)[0]
    if path.exists() or path.is_symlink():
        previous = _load(path, binding, protector)
        if previous['mediaUrl'] != media_url:
            raise ReceiptFailure('receipt-already-exists')
        return _summary(path, True, protector)
    payload = {'schemaVersion': 1, 'binding': binding, 'createdAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'mediaUrl': media_url}
    encrypted = protector.protect(_json_bytes(payload), _entropy(binding))
    encoded = _json_bytes({'format': _receipt_info(protector)[1], 'ciphertext': base64.b64encode(encrypted).decode('ascii'), 'ciphertextSha256': hashlib.sha256(encrypted).hexdigest()}) + b'\n'
    if len(encoded) > MAX_FILE_BYTES:
        raise ReceiptFailure('receipt-file-size-rejected')
    temporary = folder / ('.pending-' + secrets.token_hex(12))
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        # Hard-link publication is atomic and fails if another writer already won.
        try:
            os.link(temporary, path)
        except FileExistsError:
            raise ReceiptFailure('receipt-already-exists') from None
    finally:
        temporary.unlink(missing_ok=True)
    return _summary(path, False, protector)


def use_saved_media_url(task_directory, binding, consumer, *, _protector=None):
    """Decrypt only into memory and pass the same URL to a download callback, without native calls.

    consumer must return sanitized download evidence, not the URL. This helper never
    prints, retries, deletes, refreshes the native URL, or falls back after decrypt failure.
    """
    binding = _binding(binding)
    protector = _protector if _protector is not None else current_user_protector()
    folder = _folder(task_directory, protector)
    payload = _load(folder / _receipt_info(protector)[0], binding, protector)
    return consumer(payload['mediaUrl'])
