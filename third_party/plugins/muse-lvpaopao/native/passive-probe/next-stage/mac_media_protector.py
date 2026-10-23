"""Encrypt native media receipts with a nonextractable current-user Keychain key."""
from __future__ import annotations

import ctypes as c
import fcntl
import hmac
import os
from pathlib import Path
import stat
import sys
from secure_media_receipt import ReceiptFailure


class MacProtectionFailure(ReceiptFailure):
    """Fixed local protection failure; native error text is never returned."""


class MacCurrentUserKeychain:
    """Apple ECIES SHA256/AES-GCM with the private key held in the login Keychain."""
    receipt_format='macos-keychain-ecies-sha256-aesgcm-v1'
    receipt_filename='native-media.keychain.json'
    def __init__(self, *, _tag=b'local.muse.lvpaopao.media-receipt.v1', _lock_directory=None):
        if sys.platform!='darwin':raise MacProtectionFailure('mac-keychain-required')
        self.cf=c.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
        self.sec=c.CDLL('/System/Library/Frameworks/Security.framework/Security')
        self.owned=[];self.key=None
        p=c.c_void_p;l=c.c_long
        self.cf.CFRelease.argtypes=[p]
        self.cf.CFDataCreate.argtypes=[p,p,l];self.cf.CFDataCreate.restype=p
        self.cf.CFDataGetLength.argtypes=[p];self.cf.CFDataGetLength.restype=l
        self.cf.CFDataGetBytePtr.argtypes=[p];self.cf.CFDataGetBytePtr.restype=p
        self.cf.CFNumberCreate.argtypes=[p,c.c_int,p];self.cf.CFNumberCreate.restype=p
        self.cf.CFDictionaryCreate.argtypes=[p,p,p,l,p,p];self.cf.CFDictionaryCreate.restype=p
        self.sec.SecItemCopyMatching.argtypes=[p,c.POINTER(p)];self.sec.SecItemCopyMatching.restype=c.c_int32
        self.sec.SecKeyCreateRandomKey.argtypes=[p,c.POINTER(p)];self.sec.SecKeyCreateRandomKey.restype=p
        self.sec.SecKeyCopyPublicKey.argtypes=[p];self.sec.SecKeyCopyPublicKey.restype=p
        self.sec.SecKeyIsAlgorithmSupported.argtypes=[p,c.c_int,p];self.sec.SecKeyIsAlgorithmSupported.restype=c.c_bool
        for name in ('SecKeyCreateEncryptedData','SecKeyCreateDecryptedData'):
            method=getattr(self.sec,name);method.argtypes=[p,p,p,c.POINTER(p)];method.restype=p
        lock_directory=Path(_lock_directory) if _lock_directory is not None else Path.home()/'Library/Application Support/Muse/lvpaopao'
        lock_directory.mkdir(mode=0o700,parents=True,exist_ok=True)
        self.secure_directory(lock_directory)
        descriptor=os.open(lock_directory/'receipt-key.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        try:
            info=os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_nlink!=1 or info.st_mode&0o077:raise MacProtectionFailure('mac-key-lock-invalid')
            fcntl.flock(descriptor,fcntl.LOCK_EX)
            self._load_key(_tag)
        except Exception:
            self.close();raise
        finally:os.close(descriptor)

    def _constant(self,name,library=None):
        return c.c_void_p.in_dll(library or self.sec,name).value

    def _hold(self,value):
        if not value:raise MacProtectionFailure('mac-keychain-allocation-failed')
        self.owned.append(value);return value

    def _data(self,value):
        return self._hold(self.cf.CFDataCreate(None,c.create_string_buffer(value),len(value)))

    def _dictionary(self,items):
        keys=(c.c_void_p*len(items))(*[self._constant(k) for k,v in items])
        values=(c.c_void_p*len(items))(*[v for k,v in items])
        return self._hold(self.cf.CFDictionaryCreate(None,keys,values,len(items),c.addressof(c.c_byte.in_dll(self.cf,'kCFTypeDictionaryKeyCallBacks')),c.addressof(c.c_byte.in_dll(self.cf,'kCFTypeDictionaryValueCallBacks'))))

    def _load_key(self,tag):
        true=self._constant('kCFBooleanTrue',self.cf)
        tag_data=self._data(tag)
        query=self._dictionary([('kSecClass',self._constant('kSecClassKey')),('kSecAttrKeyType',self._constant('kSecAttrKeyTypeECSECPrimeRandom')),('kSecAttrApplicationTag',tag_data),('kSecReturnRef',true),('kSecUseAuthenticationUI',self._constant('kSecUseAuthenticationUIFail'))])
        found=c.c_void_p();status=self.sec.SecItemCopyMatching(query,c.byref(found))
        if status==0 and found.value:self.key=self._hold(found.value)
        elif status==-25300:
            size=c.c_int32(256);number=self._hold(self.cf.CFNumberCreate(None,3,c.byref(size)))
            private=self._dictionary([('kSecAttrIsPermanent',true),('kSecAttrApplicationTag',tag_data),('kSecAttrIsExtractable',self._constant('kCFBooleanFalse',self.cf))])
            attributes=self._dictionary([('kSecAttrKeyType',self._constant('kSecAttrKeyTypeECSECPrimeRandom')),('kSecAttrKeySizeInBits',number),('kSecPrivateKeyAttrs',private)])
            error=c.c_void_p();key=self.sec.SecKeyCreateRandomKey(attributes,c.byref(error))
            if error.value:self.cf.CFRelease(error)
            if not key:raise MacProtectionFailure('mac-keychain-key-unavailable')
            self.key=self._hold(key)
        else:raise MacProtectionFailure('mac-keychain-key-unavailable')
        self.algorithm=self._constant('kSecKeyAlgorithmECIESEncryptionStandardX963SHA256AESGCM')
        if not self.sec.SecKeyIsAlgorithmSupported(self.key,3,self.algorithm):raise MacProtectionFailure('mac-keychain-algorithm-unsupported')

    def _transform(self,name,key,value):
        if not isinstance(value,bytes) or not 1<=len(value)<=16384:raise MacProtectionFailure('mac-keychain-input-invalid')
        source=self.cf.CFDataCreate(None,c.create_string_buffer(value),len(value));error=c.c_void_p();output=None
        if not source:raise MacProtectionFailure('mac-keychain-allocation-failed')
        try:
            output=getattr(self.sec,name)(key,self.algorithm,source,c.byref(error))
            if not output:raise MacProtectionFailure('mac-keychain-transform-failed')
            count=self.cf.CFDataGetLength(output)
            if not 1<=count<=16384:raise MacProtectionFailure('mac-keychain-output-invalid')
            return c.string_at(self.cf.CFDataGetBytePtr(output),count)
        finally:
            self.cf.CFRelease(source)
            if output:self.cf.CFRelease(output)
            if error.value:self.cf.CFRelease(error)

    def protect(self,value,entropy):
        """Encrypt a payload together with its exact 32-byte source binding."""
        if not isinstance(entropy,bytes) or len(entropy)!=32:raise MacProtectionFailure('mac-keychain-binding-invalid')
        public=self.sec.SecKeyCopyPublicKey(self.key)
        if not public:raise MacProtectionFailure('mac-keychain-key-unavailable')
        try:return self._transform('SecKeyCreateEncryptedData',public,entropy+value)
        finally:self.cf.CFRelease(public)

    def unprotect(self,value,entropy):
        """Decrypt only when the authenticated source binding still matches."""
        plain=self._transform('SecKeyCreateDecryptedData',self.key,value)
        if not isinstance(entropy,bytes) or len(entropy)!=32 or not hmac.compare_digest(plain[:32],entropy):raise MacProtectionFailure('mac-keychain-binding-invalid')
        return plain[32:]

    def secure_directory(self,folder):
        """Restrict an owned, nonsymlink receipt directory to the current user."""
        info=Path(folder).lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid!=os.getuid():raise MacProtectionFailure('mac-receipt-directory-invalid')
        Path(folder).chmod(0o700)

    def close(self):
        """Release native references without deleting the durable receipt key."""
        for value in reversed(self.owned):self.cf.CFRelease(value)
        self.owned.clear();self.key=None
