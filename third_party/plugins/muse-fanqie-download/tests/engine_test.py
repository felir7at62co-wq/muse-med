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

    def test_html_body_keeps_chapter_blocks_and_excludes_document_metadata(self):
        html = ('<html><head><title>不是章节的标题</title><style>不是章节的样式</style>'
                '<script>不是章节的脚本</script></head><body><h1>Fixture</h1>'
                '<blk><p>第一段独立构造的正文。</p></blk><script>不要输出脚本内容</script>'
                '<style>不要输出样式内容</style><blk><p>第二段正文<br>第三段正文<br/>'
                '第四段正文。</p></blk></body></html>不是正文的尾部')
        c, e, k = self.chapter(html)
        self.assertEqual(decode_chapter(c, e, '20000000000', k, 1024),
                         'Fixture\n第一段独立构造的正文。\n第二段正文\n第三段正文\n第四段正文。')

    def test_article_takes_priority_over_other_body_text(self):
        c, e, k = self.chapter('<body>不属于文章的前部文字。<article><p>这是独立构造的章节正文。</p>'
                               '</article>不属于文章的后部文字。</body>')
        self.assertEqual(decode_chapter(c, e, '20000000000', k, 1024), '这是独立构造的章节正文。')
        c, e, k = self.chapter('<body>很多不是文章的正文不能补足试看字数。<article>试看</article></body>')
        with self.assertRaisesRegex(EngineError, '^incomplete_chapter$'):
            decode_chapter(c, e, '20000000000', k, 1024)

    def test_line_breaks_in_both_containers(self):
        for container in ('article', 'body'):
            with self.subTest(container=container):
                c, e, k = self.chapter(f'<{container}>第一行正文<br>第二行正文<br/>第三行正文。</{container}>')
                self.assertEqual(decode_chapter(c, e, '20000000000', k, 1024),
                                 '第一行正文\n第二行正文\n第三行正文。')

    def test_final_character_references_in_both_containers(self):
        for container in ('article', 'body'):
            with self.subTest(container=container):
                c, e, k = self.chapter(f'<{container}>这是独立构造的末尾实体测试内容&amp')
                self.assertEqual(decode_chapter(c, e, '20000000000', k, 1024),
                                 '这是独立构造的末尾实体测试内容&')

    def test_non_chapter_containers_and_excluded_text_cannot_supply_missing_words(self):
        for html in ('<p>没有正文容器的文字即使足够长也不接受。</p>',
                     '<head><article>文档元数据不能作为完整章节。</article></head>',
                     '<body><head>文档元数据不能作为完整章节。</head><script>很长的脚本不是正文。</script>'
                     '<style>很长的样式不是正文。</style></body>',
                     '<body>短</body>容器之外的文字不能补足声明字数。',
                     '<article>短</article>容器之外的文字不能补足声明字数。'):
            with self.subTest(html=html):
                c, e, k = self.chapter(html)
                with self.assertRaisesRegex(EngineError, '^incomplete_chapter$'):
                    decode_chapter(c, e, '20000000000', k, 1024)

    def test_preview_paid_mismatch_and_font_encoding_are_refused(self):
        for container in ('article', 'body'):
            for change in ('preview', 'paid', 'sale', 'pay_info', 'mismatch', 'font', 'replacement', 'missing_words'):
                with self.subTest(container=container, change=change):
                    text = '\ue000' * 20 if change == 'font' else '正常测试内容必须比试看长得多。'
                    if change == 'replacement':
                        text += '\ufffd'
                    c, e, k = self.chapter(f'<{container}>{text}</{container}>')
                    if change == 'preview':
                        e['chapter_word_number'] = 2000
                    if change == 'paid':
                        c['novel_data']['vip_book'] = '1'
                    if change == 'sale':
                        c['novel_data']['sale_status'] = '1'
                    if change == 'pay_info':
                        c['novel_data']['pay_info'] = {'requires_authorization': True}
                    if change == 'mismatch':
                        c['novel_data']['book_id'] = '30000000000'
                    if change == 'missing_words':
                        e['chapter_word_number'] = 0
                    error = ('authorization_required' if change in ('paid', 'sale', 'pay_info')
                             else 'chapter_mismatch' if change == 'mismatch' else 'incomplete_chapter')
                    with self.assertRaisesRegex(EngineError, '^' + error + '$'):
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
