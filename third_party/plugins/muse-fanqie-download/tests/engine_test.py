"""Invented chapter fixtures verify full-text validation without real book text or identities."""
import base64
import gzip
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from engine import AES, EngineError, decode_chapter, pad, validate_catalog


class EngineTests(unittest.TestCase):
    def chapter(self, html='<article><h1>Fixture</h1><p>这是独立构造的章节测试内容。</p></article>'):
        iv, key = bytes(16), bytes(range(16))
        encrypted = AES.new(key, AES.MODE_CBC, iv).encrypt(pad(gzip.compress(html.encode()), 16))
        chapter = {'code': 0, 'compress_status': 1, 'content': base64.b64encode(iv + encrypted).decode(),
                   'novel_data': {'item_id': '10000000000', 'book_id': '20000000000', 'real_chapter_order': '1', 'vip_book': '0', 'sale_status': '0'}}
        expected = {'item_id': '10000000000', 'chapter_word_number': 10, 'order': 1}
        return chapter, expected, key

    def test_full_plaintext_and_bounded_decompression(self):
        c, e, k = self.chapter()
        text = decode_chapter(c, e, '20000000000', k, 1024)
        self.assertIn('章节测试内容', text)
        self.assertNotIn('<p>', text)
        with self.assertRaises(EngineError):
            decode_chapter(c, e, '20000000000', k, 4)

    def test_preview_paid_mismatch_and_font_encoding_are_refused(self):
        for change in ('preview', 'paid', 'mismatch', 'font'):
            c, e, k = self.chapter('<article>\ue000</article>' if change == 'font' else '<article>正常测试内容必须比试看长得多。</article>')
            if change == 'preview':
                e['chapter_word_number'] = 2000
            if change == 'paid':
                c['novel_data']['vip_book'] = '1'
            if change == 'mismatch':
                c['novel_data']['book_id'] = '30000000000'
            with self.assertRaises(EngineError):
                decode_chapter(c, e, '20000000000', k, 1024)

    def test_catalog_requires_declared_count_and_unique_ids(self):
        value = {'data': {'book_info': {'book_id': '20000000000', 'serial_count': '1'}, 'item_data_list': [{'item_id': '10000000000'}]}}
        self.assertEqual(len(validate_catalog('20000000000', value)[1]), 1)
        value['data']['book_info']['serial_count'] = '2'
        with self.assertRaises(EngineError):
            validate_catalog('20000000000', value)
        value['data']['item_data_list'] *= 2
        with self.assertRaises(EngineError):
            validate_catalog('20000000000', value)


if __name__ == '__main__':
    unittest.main()
