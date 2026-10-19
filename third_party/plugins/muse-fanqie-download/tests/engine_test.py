"""Invented chapter fixtures verify full-text validation without real book text or identities."""
import base64
import contextlib
import errno
import gzip
import io
import json
from pathlib import Path
import socket
import ssl
import sys
import tempfile
import unittest
from unittest import mock
import urllib.error
import urllib.request
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from engine import AES, Client, EngineError, decode_chapter, failure_result, main, pad, run, search_page, validate_catalog


class NetworkTests(unittest.TestCase):
    def settings(self, mode=None):
        settings = {'requestTimeoutMs': 1000, 'maxResponseBytes': 1024,
                    'maxChapterBytes': 1024, 'maxBookBytes': 1024, 'batchSize': 1}
        if mode is not None:
            settings['networkMode'] = mode
        return settings

    def client(self, mode=None):
        with mock.patch('engine.TT.encrypt', return_value=b'registration'), \
             mock.patch.object(Client, 'request', return_value={'device_id_str': '123', 'install_id_str': '456'}):
            return Client(self.settings(mode))

    def test_direct_disables_environment_and_macos_proxy_discovery_without_changing_tls(self):
        for mode in (None, 'direct'):
            with self.subTest(mode=mode), mock.patch('urllib.request.getproxies',
                                                   return_value={'https': 'http://proxy-secret:17890'}) as proxies:
                client = self.client(mode)
                proxies.assert_not_called()
                self.assertEqual(client.network_mode, 'direct')
                https = next(handler for handler in client.opener.handlers
                             if isinstance(handler, urllib.request.HTTPSHandler))
                self.assertIsNone(https._context)

    def test_system_keeps_standard_proxy_discovery(self):
        with mock.patch('urllib.request.getproxies', return_value={'https': 'http://proxy-secret:17890'}) as proxies:
            client = self.client('system')
            proxies.assert_called_once_with()
            handler = next(handler for handler in client.opener.handlers
                           if isinstance(handler, urllib.request.ProxyHandler))
            self.assertEqual(handler.proxies, {'https': 'http://proxy-secret:17890'})

    def test_unknown_network_mode_fails_before_registration(self):
        with mock.patch('engine.TT.encrypt') as encrypt, self.assertRaisesRegex(EngineError, '^invalid_network_mode$'):
            Client(self.settings('unknown'))
        encrypt.assert_not_called()

    def test_registration_failure_identifies_official_host_and_proxy_policy(self):
        opener = mock.Mock()
        opener.open.side_effect = urllib.error.URLError(ConnectionRefusedError(errno.ECONNREFUSED, 'private proxy credentials'))
        with mock.patch('urllib.request.build_opener', return_value=opener), \
             mock.patch('engine.TT.encrypt', return_value=b'registration'), self.assertRaises(EngineError) as raised:
            run({'settings': self.settings('system'), 'operation': 'search', 'query': 'private search', 'passback': '0'})
        result = failure_result(raised.exception)
        self.assertEqual((result['sourceStage'], result['host'], result['networkMode']),
                         ('registration', 'log.snssdk.com', 'system'))
        self.assertEqual(result['error']['type'], 'URLError')
        self.assertEqual(result['error']['reasonType'], 'ConnectionRefusedError')
        self.assertEqual(result['error']['errno'], errno.ECONNREFUSED)
        self.assertNotIn('private', json.dumps(result))

    def test_each_api_failure_reports_the_actual_stage(self):
        for stage in ('search', 'catalog', 'key-negotiation', 'chapter-download'):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as staging:
                client = self.client('direct')
                client.opener = mock.Mock()
                client.opener.open.side_effect = urllib.error.URLError(TimeoutError('private signed URL'))
                if stage == 'search':
                    operation = lambda: client.search('private title', 'private cursor')
                elif stage == 'catalog':
                    operation = lambda: client.directory('20000000000')
                elif stage == 'key-negotiation':
                    operation = client.negotiate
                else:
                    client.directory = lambda book_id: ({'book_name': 'fixture'}, [{'item_id': '10000000000'}])
                    client.key, client.keyver = bytes(16), 'private key version'
                    operation = lambda: client.download('20000000000', staging)
                with self.assertRaises(EngineError) as raised:
                    operation()
                result = failure_result(raised.exception)
                self.assertEqual((result['sourceStage'], result['host'], result['networkMode']),
                                 (stage, 'api5-normal.fqnovel.com', 'direct'))
                self.assertEqual(result['error']['reasonType'], 'TimeoutError')
                self.assertNotIn('private', json.dumps(result))

    def test_post_response_integrity_error_keeps_catalog_stage(self):
        client = self.client()
        client.opener = mock.MagicMock()
        response = client.opener.open.return_value.__enter__.return_value
        response.status, response.headers, response.read.return_value = 200, {}, b'{}'
        with mock.patch('engine.Client', return_value=client), self.assertRaises(EngineError) as raised:
            run({'settings': self.settings(), 'operation': 'info', 'bookIds': ['20000000000']})
        result = failure_result(raised.exception)
        self.assertEqual(result['code'], 'incomplete_catalog')
        self.assertEqual(result['sourceStage'], 'catalog')

    def test_http_tls_dns_and_arbitrary_errors_have_bounded_safe_details(self):
        secret = 'private-device-token-and-signed-query'
        ssl_error = ssl.SSLEOFError(8, secret)
        ssl_error.reason = 'UNEXPECTED_EOF_WHILE_READING'
        cases = [
            (urllib.error.HTTPError('https://api5-normal.fqnovel.com/?' + secret, 503, secret, {'token': secret}, io.BytesIO(secret.encode())), 'HTTPError', 'HTTP', {'httpStatus': 503}),
            (urllib.error.URLError(ssl_error), 'SSLEOFError', 'UNEXPECTED_EOF_WHILE_READING', {'errno': 8}),
            (urllib.error.URLError(ssl.SSLCertVerificationError(1, secret)), 'SSLCertVerificationError', 'CERTIFICATE_VERIFY_FAILED', {'errno': 1}),
            (urllib.error.URLError(socket.gaierror(-2, secret)), 'gaierror', 'DNS', {'errno': -2}),
            (urllib.error.URLError(ConnectionResetError(errno.ECONNRESET, secret)), 'ConnectionResetError', '连接被重置', {'errno': errno.ECONNRESET}),
            (urllib.error.URLError(secret), 'Exception', '网络请求失败', {}),
            (json.JSONDecodeError(secret, secret, 0), 'JSONDecodeError', 'JSON', {}),
            (ValueError(secret), 'ValueError', '格式检查', {}),
            (RuntimeError(secret), 'Exception', '引擎处理失败', {}),
            (EngineError(secret), 'EngineError', '引擎处理失败', {}),
        ]
        for error, reason_type, message, extra in cases:
            with self.subTest(reason_type=reason_type, message=message):
                result = failure_result(error)
                self.assertEqual(result['error']['reasonType'], reason_type)
                self.assertIn(message, result['error']['message'])
                for field, value in extra.items():
                    self.assertEqual(result['error'][field], value)
                self.assertNotIn(secret, json.dumps(result))
                self.assertNotIn('https://', json.dumps(result))
                self.assertFalse(result['ok'])
                self.assertFalse(result['complete'])

    def test_main_writes_one_safe_json_failure_and_returns_nonzero(self):
        client = self.client()
        client.opener = mock.Mock()
        client.opener.open.side_effect = urllib.error.URLError(socket.gaierror(-2, 'private-token'))
        stdin = mock.Mock(buffer=io.BytesIO(json.dumps({'settings': self.settings(), 'operation': 'info',
                                                       'bookIds': ['20000000000']}).encode()))
        stdout = io.StringIO()
        with mock.patch('engine.Client', return_value=client), mock.patch('sys.stdin', stdin), contextlib.redirect_stdout(stdout):
            status = main()
        self.assertEqual(status, 1)
        result = json.loads(stdout.getvalue())
        self.assertEqual(result['sourceStage'], 'catalog')
        self.assertEqual(result['error']['reasonType'], 'gaierror')
        self.assertEqual(stdout.getvalue().count('\n'), 1)
        self.assertNotIn('private-token', stdout.getvalue())


class EngineTests(unittest.TestCase):
    def test_search_keeps_all_books_in_groups_and_removes_highlights_and_duplicates(self):
        first = {'book_id': '20000000000', 'book_name': '<em>测试</em>书', 'author': '作者&amp;合著',
                 'original_book_name': '原名', 'serial_count': '3'}
        second = {**first, 'book_id': '30000000000', 'author': '同名作者'}
        response = {'search_tabs': [{'tab_type': 11, 'data': [{'video': 'not a book'}]},
                    {'tab_type': 3, 'has_more': True, 'passback': 'opaque:next',
                     'data': [{'book_data': [first, second]}, {'book_data': [first]}]}]}
        result = search_page('测试书', response)
        self.assertEqual(result['nextPassback'], 'opaque:next')
        self.assertFalse(result['complete'])
        self.assertEqual([(b['bookId'], b['title'], b['author']) for b in result['items']],
                         [('20000000000', '测试书', '作者&合著'), ('30000000000', '测试书', '同名作者')])
        self.assertEqual(result['items'][0]['chapterCount'], 3)
        self.assertEqual(result['items'][0]['url'], 'https://fanqienovel.com/page/20000000000')
        empty = search_page('无此书', {'search_tabs': [{'tab_type': 3, 'has_more': False, 'data': []}]})
        self.assertEqual(empty['items'], [])
        self.assertIsNone(empty['nextPassback'])

    def test_search_rejects_missing_tab_invalid_identity_and_missing_pagination(self):
        for result in ({}, {'search_tabs': []},
                       {'search_tabs': [{'tab_type': 3, 'has_more': True, 'data': []}]},
                       {'search_tabs': [{'tab_type': 3, 'has_more': False,
                         'data': [{'book_data': [{'book_id': 20000000000, 'book_name': '不可丢失精度'}]}]}]}):
            with self.subTest(result=result), self.assertRaisesRegex(EngineError, '^invalid_search_result$'):
                search_page('测试', result)

    def test_search_passes_the_opaque_cursor_to_the_official_read_endpoint(self):
        client = object.__new__(Client)
        calls = []
        def api(path, params):
            calls.append((path, params))
            return {'search_tabs': [{'tab_type': 3, 'has_more': False, 'data': []}]}
        client.api = api
        client.search('书名 & 作者', 'opaque:next')
        self.assertEqual(calls, [('/reading/bookapi/search/tab/v/',
                         {'query': '书名 & 作者', 'tab_type': '3', 'passback': 'opaque:next'})])

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
