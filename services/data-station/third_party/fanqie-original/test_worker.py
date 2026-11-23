"""Offline acceptance for free-reading validation; no network or device registration."""
import base64
import json
from pathlib import Path
import sys
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad
from engine import EngineError, decode_chapter, validate_catalog
import worker
from worker import OriginalClient, directory, fetch_chapter, serve_chapter, settings


class FreeReadingTests(unittest.TestCase):
    key = b'0123456789abcdef'
    expected = {'item_id': '7395464503774678041', 'order': 1, 'chapter_word_number': 12}

    def chapter(self, text='人之初，性本善。性相近，习相远。'):
        iv = b'fedcba9876543210'
        raw = ('<article><p>' + text + '</p></article>').encode()
        content = base64.b64encode(iv + AES.new(self.key, AES.MODE_CBC, iv).encrypt(pad(raw, 16))).decode()
        return {'code': 0, 'content': content, 'novel_data': {'item_id': self.expected['item_id'], 'book_id': '7395464458719464510', 'real_chapter_order': 1}}

    def test_normal_complete_plaintext(self):
        self.assertEqual(decode_chapter(self.chapter(), self.expected, '7395464458719464510', self.key, 1024), '人之初，性本善。性相近，习相远。')

    def test_identity_and_order(self):
        for key, value in (('item_id', '1'), ('book_id', '2'), ('real_chapter_order', 2)):
            with self.subTest(key=key):
                chapter = self.chapter()
                chapter['novel_data'][key] = value
                with self.assertRaisesRegex(EngineError, 'chapter_mismatch'):
                    decode_chapter(chapter, self.expected, '7395464458719464510', self.key, 1024)

    def test_authorization_flags(self):
        for key, value in (('vip_book', '1'), ('sale_status', '1'), ('pay_info', {'locked': True})):
            with self.subTest(key=key):
                chapter = self.chapter()
                chapter['novel_data'][key] = value
                with self.assertRaisesRegex(EngineError, 'authorization_required'):
                    decode_chapter(chapter, self.expected, '7395464458719464510', self.key, 1024)

    def test_preview_font_mask_and_replacement(self):
        for text in ('人之初', '人之初\ue000性本善。性相近，习相远。', '人之初\ufffd性本善。性相近，习相远。'):
            with self.subTest(text=text):
                with self.assertRaisesRegex(EngineError, 'incomplete_chapter'):
                    decode_chapter(self.chapter(text), self.expected, '7395464458719464510', self.key, 1024)

    def test_chapter_size(self):
        with self.assertRaisesRegex(EngineError, 'chapter_size'):
            decode_chapter(self.chapter('人' * 1024), self.expected, '7395464458719464510', self.key, 1024)

    def test_directory_requires_declared_unique_items(self):
        for items in ([], [{'item_id': '7395464503774678041'}, {'item_id': '7395464503774678041'}]):
            with self.subTest(items=items):
                with self.assertRaises(EngineError):
                    validate_catalog('7395464458719464510', {'data': {'book_info': {'book_id': '7395464458719464510', 'serial_count': 2}, 'item_data_list': items}})

    def test_fixed_official_https_sources(self):
        client = OriginalClient.__new__(OriginalClient)
        for url in ('http://log.snssdk.com/service/2/device_register/', 'https://example.com/',
                    'https://api5-normal.fqnovel.com/reading/bookapi/search/tab/v/', 'https://user:pass@log.snssdk.com/service/2/device_register/'):
            with self.subTest(url=url):
                with self.assertRaisesRegex(EngineError, 'platform_rejected'):
                    client.request(url)

    def test_input_limits_before_registration(self):
        base = {'requestTimeoutMs': 30000, 'requestIntervalMs': 250, 'maxResponseBytes': 16777216, 'maxChapterBytes': 2097152, 'networkMode': 'direct'}
        self.assertEqual(settings(base), base)
        for change in ({'requestTimeoutMs': 0}, {'maxChapterBytes': True}, {'maxResponseBytes': 33554433}, {'networkMode': 'unsafe'}, {'secret': 'must-not-be-accepted'}):
            with self.subTest(change=change):
                with self.assertRaises(EngineError):
                    settings({**base, **change})

    def test_directory_rejects_api_paid_and_out_of_order_items(self):
        class StubClient:
            def __init__(self, chapter):
                self.chapter = chapter

            def directory(self, book_id):
                return {'book_id': book_id}, [self.chapter]

        base = {'item_id': '7395464503774678041', 'order': 1}
        for change in ({'isChapterLock': True}, {'needPay': 1}, {'is_vip': '1'}, {'real_chapter_order': '2'}):
            with self.subTest(change=change):
                with self.assertRaises(EngineError):
                    directory(StubClient({**base, **change}), '7395464458719464510')


    def test_transient_failures_retry_but_authorization_is_final(self):
        original_delay = worker.RETRY_DELAY_SECONDS
        worker.RETRY_DELAY_SECONDS = 0
        try:
            class StubClient:
                def __init__(self, errors):
                    self.errors = list(errors)
                    self.key = FreeReadingTests.key
                    self.keyver = 1
                    self.settings = {'maxChapterBytes': 1024}
                    self.calls = 0

                def negotiate(self):
                    return None

                def api(self, path, body):
                    self.calls += 1
                    if self.errors:
                        raise self.errors.pop(0)
                    return {'data': {FreeReadingTests.expected['item_id']: FreeReadingTests().chapter()}}

            expected = {'item_id': '7395464503774678041', 'order': 1, 'chapter_word_number': 12}
            book = '7395464458719464510'
            transient = StubClient([EngineError('URLError'), EngineError('JSONDecodeError')])
            self.assertEqual(fetch_chapter(transient, book, expected), '人之初，性本善。性相近，习相远。')
            self.assertEqual(transient.calls, 3)
            final = StubClient([EngineError('authorization_required')])
            with self.assertRaisesRegex(EngineError, 'authorization_required'):
                fetch_chapter(final, book, expected)
            self.assertEqual(final.calls, 1)
            exhausted = StubClient([EngineError('URLError') for _ in range(worker.RETRY_ATTEMPTS)])
            with self.assertRaisesRegex(EngineError, 'URLError'):
                fetch_chapter(exhausted, book, expected)
            self.assertEqual(exhausted.calls, worker.RETRY_ATTEMPTS)
        finally:
            worker.RETRY_DELAY_SECONDS = original_delay

    def test_rotates_anonymous_sessions_before_and_after_the_read_quota(self):
        original = (worker.ROTATE_AFTER_CHAPTERS, worker.ROTATE_AFTER_SECONDS, worker.RETRY_DELAY_SECONDS)
        worker.ROTATE_AFTER_CHAPTERS, worker.ROTATE_AFTER_SECONDS, worker.RETRY_DELAY_SECONDS = 2, 999, 0
        try:
            expected = {'item_id': '7395464503774678041', 'order': 1, 'chapter_word_number': 12}
            book = '7395464458719464510'
            created = []

            class LimitedClient:
                def __init__(self, settings):
                    self.key = FreeReadingTests.key
                    self.keyver = 1
                    self.settings = {'maxChapterBytes': 1024}
                    self.calls = 0
                    created.append(self)

                def negotiate(self):
                    return None

                def api(self, path, body):
                    self.calls += 1
                    if self.calls > 2:
                        raise EngineError('platform_rejected')
                    return {'data': {expected['item_id']: FreeReadingTests().chapter()}}

            client, served, started = LimitedClient({}), 0, time.monotonic()
            texts = []
            for _ in range(4):
                text, client, served, started = serve_chapter(client, {}, book, expected, served, started, LimitedClient)
                texts.append(text)
            self.assertEqual(texts, ['人之初，性本善。性相近，习相远。'] * 4)
            self.assertEqual(len(created), 2)
            self.assertEqual(served, 2)

            class ExhaustedClient(LimitedClient):
                def __init__(self, settings):
                    super().__init__(settings)
                    self.calls = 99

            text, client, served, started = serve_chapter(ExhaustedClient({}), {}, book, expected, 1, time.monotonic(), LimitedClient)
            self.assertEqual(text, '人之初，性本善。性相近，习相远。')
            self.assertEqual(served, 1)
            self.assertEqual(len(created), 4)

            class ForbiddenClient(LimitedClient):
                def api(self, path, body):
                    raise EngineError('authorization_required')

            with self.assertRaisesRegex(EngineError, 'authorization_required'):
                serve_chapter(ForbiddenClient({}), {}, book, expected, 1, time.monotonic(), LimitedClient)
        finally:
            worker.ROTATE_AFTER_CHAPTERS, worker.ROTATE_AFTER_SECONDS, worker.RETRY_DELAY_SECONDS = original

    def test_rotates_the_session_on_age_even_below_the_request_quota(self):
        original = (worker.ROTATE_AFTER_CHAPTERS, worker.ROTATE_AFTER_SECONDS, worker.RETRY_DELAY_SECONDS)
        worker.ROTATE_AFTER_CHAPTERS, worker.ROTATE_AFTER_SECONDS, worker.RETRY_DELAY_SECONDS = 999, 0, 0
        try:
            expected = {'item_id': '7395464503774678041', 'order': 1, 'chapter_word_number': 12}
            book = '7395464458719464510'
            created = []

            class WorkingClient:
                def __init__(self, settings):
                    self.key = FreeReadingTests.key
                    self.keyver = 1
                    self.settings = {'maxChapterBytes': 1024}
                    created.append(self)

                def negotiate(self):
                    return None

                def api(self, path, body):
                    return {'data': {expected['item_id']: FreeReadingTests().chapter()}}

            client, served, started = WorkingClient({}), 0, time.monotonic()
            self.assertEqual(len(created), 1)
            text, client, served, started = serve_chapter(client, {}, book, expected, served, started, WorkingClient)
            self.assertEqual(text, '人之初，性本善。性相近，习相远。')
            self.assertEqual(len(created), 2)
            self.assertEqual((served, started <= time.monotonic()), (1, True))
        finally:
            worker.ROTATE_AFTER_CHAPTERS, worker.ROTATE_AFTER_SECONDS, worker.RETRY_DELAY_SECONDS = original


if __name__ == '__main__':
    unittest.main()
