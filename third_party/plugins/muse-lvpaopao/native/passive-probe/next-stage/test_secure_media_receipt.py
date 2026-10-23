"""Offline receipt tests use opaque in-memory fake protection, not a substitute cipher."""
import ctypes
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import secure_media_receipt as receipt

BINDING = {'hostAppId': 'wx404dde55fb12df78', 'srcAppId': 'wx6522458df7ed3af2', 'dramaId': '121225', 'serialNo': 1, 'isFirstMediaFree': True, 'isStraight': True}
FAKE_URL = 'https://synthetic.invalid/synthetic-media?not-a-real-capability=1'


class FakeProtector:
    def __init__(self):
        self.values = {}
        self.protect_calls = 0

    def secure_directory(self, folder):
        folder.chmod(0o700)

    def protect(self, value, entropy):
        self.protect_calls += 1
        token = ('synthetic-opaque-' + str(self.protect_calls)).encode()
        self.values[token] = (value, entropy)
        return token

    def unprotect(self, value, entropy):
        if value not in self.values or self.values[value][1] != entropy:
            raise receipt.ReceiptFailure('dpapi-unprotect-failed')
        return self.values[value][0]


class Tests(unittest.TestCase):
    def test_mac_receipt_uses_separate_format_and_refuses_windows_decryption(self):
        class MacProtector(FakeProtector):
            receipt_filename='native-media.keychain.json'
            receipt_format='macos-keychain-ecies-sha256-aesgcm-v1'
        protector=MacProtector()
        with tempfile.TemporaryDirectory() as task:
            saved=receipt.save_media_receipt(task,FAKE_URL,BINDING,_protector=protector)
            self.assertEqual(Path(saved['receiptPath']).name,protector.receipt_filename)
            self.assertEqual(saved['protection'],protector.receipt_format)
            self.assertTrue(receipt.use_saved_media_url(task,BINDING,lambda value:value==FAKE_URL,_protector=protector))
            callback=mock.Mock()
            windows=FakeProtector();windows.receipt_filename=protector.receipt_filename
            with self.assertRaisesRegex(receipt.ReceiptFailure,'receipt-envelope-invalid'):
                receipt.use_saved_media_url(task,BINDING,callback,_protector=windows)
            callback.assert_not_called()

    def test_receipt_path_lookup_does_not_access_keychain(self):
        with mock.patch.object(receipt.sys,'platform','darwin'),mock.patch.object(receipt,'current_user_protector',side_effect=AssertionError('key access')):
            self.assertEqual(receipt.encrypted_media_path('/tmp/task').name,'native-media.keychain.json')
        with mock.patch.object(receipt.sys,'platform','win32'):
            self.assertEqual(receipt.encrypted_media_path('/tmp/task').name,'native-media.dpapi.json')

    def test_save_then_use_same_url_without_url_in_disk_or_public_receipt(self):
        protector = FakeProtector()
        with tempfile.TemporaryDirectory() as task:
            result = receipt.save_media_receipt(task, FAKE_URL, BINDING, _protector=protector)
            path = Path(result['receiptPath'])
            self.assertEqual(result['currentUser'], True)
            self.assertEqual(result['machineScope'], False)
            self.assertEqual(result['uiForbidden'], True)
            self.assertEqual(result['nativeRequestPerformed'], False)
            self.assertLessEqual(path.stat().st_size, 16384)
            self.assertNotIn(FAKE_URL.encode(), path.read_bytes())
            self.assertNotIn(FAKE_URL, json.dumps(result))
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
            urls = []
            value = receipt.use_saved_media_url(task, BINDING, lambda url: urls.append(url) or {'bytes': 123}, _protector=protector)
            self.assertEqual(value, {'bytes': 123})
            self.assertEqual(urls, [FAKE_URL])
            self.assertEqual(protector.protect_calls, 1)

    def test_identical_receipt_reused_and_different_url_never_overwrites(self):
        protector = FakeProtector()
        with tempfile.TemporaryDirectory() as task:
            first = receipt.save_media_receipt(task, FAKE_URL, BINDING, _protector=protector)
            second = receipt.save_media_receipt(task, FAKE_URL, BINDING, _protector=protector)
            self.assertTrue(second['reused'])
            self.assertEqual(second['receiptSha256'], first['receiptSha256'])
            with self.assertRaisesRegex(receipt.ReceiptFailure, '^receipt-already-exists$'):
                receipt.save_media_receipt(task, FAKE_URL + '2', BINDING, _protector=protector)
            self.assertEqual(Path(first['receiptPath']).read_bytes(), Path(second['receiptPath']).read_bytes())
            self.assertEqual(protector.protect_calls, 1)

    def test_binding_change_or_other_user_never_invokes_consumer(self):
        protector = FakeProtector()
        consumer = mock.Mock()
        with tempfile.TemporaryDirectory() as task:
            receipt.save_media_receipt(task, FAKE_URL, BINDING, _protector=protector)
            for binding, port in [(dict(BINDING, dramaId='another'), protector), (BINDING, FakeProtector())]:
                with self.assertRaisesRegex(receipt.ReceiptFailure, '^dpapi-unprotect-failed$'):
                    receipt.use_saved_media_url(task, binding, consumer, _protector=port)
            consumer.assert_not_called()

    def test_arbitrary_episode_binding_is_authenticated_without_claiming_first_episode_free(self):
        protector=FakeProtector()
        binding={'hostAppId':BINDING['hostAppId'],'srcAppId':BINDING['srcAppId'],'dramaId':BINDING['dramaId'],'serialNo':7,'isStraight':True,'playAuthorization':'native-straight-playback'}
        with tempfile.TemporaryDirectory() as task:
            saved=receipt.save_media_receipt(task,FAKE_URL,binding,_protector=protector)
            self.assertEqual(receipt.use_saved_media_url(task,binding,lambda url:url==FAKE_URL,_protector=protector),True)
            consumer=mock.Mock()
            with self.assertRaisesRegex(receipt.ReceiptFailure,'dpapi-unprotect-failed'):
                receipt.use_saved_media_url(task,{**binding,'serialNo':8},consumer,_protector=protector)
            consumer.assert_not_called();self.assertNotIn(FAKE_URL,Path(saved['receiptPath']).read_text())
        for invalid in [dict(binding,serialNo=True),dict(binding,serialNo=0),dict(binding,playAuthorization='assumed-free'),dict(binding,isStraight=False),dict(binding,isFirstMediaFree=True)]:
            with self.assertRaisesRegex(receipt.ReceiptFailure,'receipt-binding-invalid'):receipt._binding(invalid)

    def test_download_failure_preserves_receipt_for_retry_without_reprotect(self):
        protector = FakeProtector()
        with tempfile.TemporaryDirectory() as task:
            first = receipt.save_media_receipt(task, FAKE_URL, BINDING, _protector=protector)
            consumer = mock.Mock(side_effect=RuntimeError('synthetic download failure'))
            with self.assertRaises(RuntimeError):
                receipt.use_saved_media_url(task, BINDING, consumer, _protector=protector)
            self.assertEqual(receipt.use_saved_media_url(task, BINDING, lambda _: 'retried', _protector=protector), 'retried')
            self.assertEqual(receipt._summary(Path(first['receiptPath']), True, protector)['receiptSha256'], first['receiptSha256'])
            self.assertEqual(protector.protect_calls, 1)

    def test_corrupt_or_oversize_receipt_fails_without_callback_or_plaintext_fallback(self):
        protector = FakeProtector()
        consumer = mock.Mock()
        with tempfile.TemporaryDirectory() as task:
            public = receipt.save_media_receipt(task, FAKE_URL, BINDING, _protector=protector)
            path = Path(public['receiptPath'])
            envelope = json.loads(path.read_text())
            envelope['ciphertextSha256'] = '0' * 64
            path.write_text(json.dumps(envelope))
            with self.assertRaisesRegex(receipt.ReceiptFailure, '^receipt-ciphertext-changed$'):
                receipt.use_saved_media_url(task, BINDING, consumer, _protector=protector)
            path.write_bytes(b'x' * 16385)
            with self.assertRaisesRegex(receipt.ReceiptFailure, '^receipt-file-size-rejected$'):
                receipt.use_saved_media_url(task, BINDING, consumer, _protector=protector)
            consumer.assert_not_called()

    def test_binding_and_url_validation_happens_before_protection(self):
        protector = FakeProtector()
        with tempfile.TemporaryDirectory() as task:
            for binding in [dict(BINDING, serialNo=2), dict(BINDING, serialNo=True), dict(BINDING, isFirstMediaFree=False), dict(BINDING, isStraight=False), dict(BINDING, extra='not allowed')]:
                with self.assertRaisesRegex(receipt.ReceiptFailure, '^receipt-binding-invalid$'):
                    receipt.save_media_receipt(task, FAKE_URL, binding, _protector=protector)
            for url in [None, '', '\0', 'x' * 8193]:
                with self.assertRaisesRegex(receipt.ReceiptFailure, '^receipt-url-invalid$'):
                    receipt.save_media_receipt(task, url, BINDING, _protector=protector)
            self.assertEqual(protector.protect_calls, 0)

    def test_directory_link_and_file_hardlink_rejected(self):
        protector = FakeProtector()
        with tempfile.TemporaryDirectory() as task, tempfile.TemporaryDirectory() as outside:
            folder = Path(task) / receipt.FOLDER_NAME
            folder.symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(receipt.ReceiptFailure, '^receipt-directory-link-rejected$'):
                receipt.save_media_receipt(task, FAKE_URL, BINDING, _protector=protector)
            folder.unlink()
            public = receipt.save_media_receipt(task, FAKE_URL, BINDING, _protector=protector)
            os.link(public['receiptPath'], Path(outside) / 'same-ciphertext')
            with self.assertRaisesRegex(receipt.ReceiptFailure, '^receipt-file-link-rejected$'):
                receipt.use_saved_media_url(task, BINDING, lambda _: None, _protector=protector)

    def test_non_windows_has_no_plaintext_or_machine_scope_fallback(self):
        with mock.patch.object(receipt.os, 'name', 'posix'):
            with self.assertRaisesRegex(receipt.ReceiptFailure, '^windows-dpapi-required$'):
                receipt.WindowsCurrentUserDpapi()

    def test_native_crypto_uses_ui_forbidden_only_and_frees_output(self):
        keeper = []
        calls = []
        def transform(source, description, entropy, reserved, prompt, flags, output):
            calls.append({'flags': flags, 'reserved': reserved, 'prompt': prompt, 'description': description})
            original = ctypes.cast(source, ctypes.POINTER(receipt._Blob)).contents
            self.assertEqual(ctypes.string_at(original.data, original.size), b'input')
            value = (ctypes.c_ubyte * 6).from_buffer_copy(b'output')
            keeper.append(value)
            target = ctypes.cast(output, ctypes.POINTER(receipt._Blob)).contents
            target.size = 6
            target.data = value
            return True
        port = receipt.WindowsCurrentUserDpapi.__new__(receipt.WindowsCurrentUserDpapi)
        port.crypt = mock.Mock(CryptProtectData=transform, CryptUnprotectData=transform)
        port.kernel = mock.Mock()
        self.assertEqual(port.protect(b'input', b'entropy'), b'output')
        self.assertEqual(port.unprotect(b'input', b'entropy'), b'output')
        self.assertEqual([call['flags'] for call in calls], [1, 1])
        self.assertTrue(all(call['prompt'] is None and call['reserved'] is None for call in calls))
        self.assertEqual(port.kernel.LocalFree.call_count, 2)


if __name__ == '__main__':
    unittest.main()
