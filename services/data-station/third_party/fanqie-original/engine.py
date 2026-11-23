"""Independent read-only Fanqie client; identities and negotiated keys remain in memory."""
import base64
import errno
import hashlib
import html.parser
import io
import json
import gzip
import os
from pathlib import Path
import re
import secrets
import socket
import ssl
import sys
import time
import urllib.parse
import urllib.error
import urllib.request
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent / 'vendor'))
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad, unpad
from TTEncrypt import TT
from signer.argus import Argus
from signer.ladon import Ladon
from signer.gorgon import XG


class EngineError(Exception):
    """Stable public failure code without private response fields."""
    def __init__(self, code, diagnostic=None):
        super().__init__(code)
        self.code = code
        self.diagnostic = diagnostic


ENGINE_MESSAGES = {
    'redirect_refused': '官方接口返回重定向，已拒绝跟随。',
    'invalid_ciphertext': '章节加密数据无效。',
    'chapter_mismatch': '章节身份或顺序与目录不一致。',
    'authorization_required': '书籍或章节需要额外授权。',
    'chapter_unavailable': '章节正文不可用。',
    'chapter_size': '章节正文超过大小限制。',
    'incomplete_chapter': '章节正文未通过完整性检查。',
    'incomplete_catalog': '返回目录与书籍声明的章节总数不一致。',
    'invalid_catalog': '目录章节标识无效或重复。',
    'invalid_search_result': '官方搜索响应缺少有效书籍或分页字段。',
    'registration_failed': '匿名设备注册未返回有效标识。',
    'http_response': '官方接口返回不支持的状态或压缩格式。',
    'response_size': '官方接口响应超过大小限制。',
    'platform_rejected': '官方接口返回业务失败或无效响应。',
    'invalid_content_key': '章节密钥长度无效。',
    'missing_chapter': '官方接口未返回目录中的章节。',
    'book_size': '整本正文超过大小限制。',
    'input_size': '工具输入超过大小限制。',
    'invalid_network_mode': '番茄网络模式必须为 direct 或 system。',
}
API_STAGES = {
    '/reading/bookapi/search/tab/v/': 'search',
    '/reading/bookapi/directory/all_items/v/': 'catalog',
    '/reading/crypt/registerkey': 'key-negotiation',
    '/reading/reader/batch_full/v': 'chapter-download',
}
SSL_MESSAGES = {
    'UNEXPECTED_EOF_WHILE_READING': 'TLS 连接意外关闭（UNEXPECTED_EOF_WHILE_READING）。',
    'CERTIFICATE_VERIFY_FAILED': 'TLS 证书验证失败（CERTIFICATE_VERIFY_FAILED）。',
    'WRONG_VERSION_NUMBER': 'TLS 协议版本不匹配（WRONG_VERSION_NUMBER）。',
    'TLSV1_ALERT_INTERNAL_ERROR': 'TLS 对端报告内部错误（TLSV1_ALERT_INTERNAL_ERROR）。',
    'TLSV1_ALERT_PROTOCOL_VERSION': 'TLS 对端拒绝协议版本（TLSV1_ALERT_PROTOCOL_VERSION）。',
    'SSLV3_ALERT_HANDSHAKE_FAILURE': 'TLS 握手失败（SSLV3_ALERT_HANDSHAKE_FAILURE）。',
    'TLSV1_ALERT_UNKNOWN_CA': 'TLS 对端不信任证书颁发者（TLSV1_ALERT_UNKNOWN_CA）。',
}


def failure_result(error):
    """Return bounded classifications, never exception text, URLs, headers or response data."""
    if isinstance(error, EngineError) and error.diagnostic is not None:
        return error.diagnostic
    reason = error.reason if isinstance(error, urllib.error.URLError) and not isinstance(error, urllib.error.HTTPError) else error
    allowed_types = (urllib.error.HTTPError, urllib.error.URLError, ssl.SSLCertVerificationError,
                     ssl.SSLEOFError, ssl.SSLError, socket.gaierror, ConnectionRefusedError,
                     ConnectionResetError, TimeoutError, OSError, json.JSONDecodeError,
                     UnicodeDecodeError, KeyError, ValueError, TypeError, EngineError)
    def name(value):
        return next((kind.__name__ for kind in allowed_types if isinstance(value, kind)), 'Exception')
    kind = name(error)
    detail = {'type': kind, 'reasonType': name(reason)}
    code = error.code if isinstance(error, EngineError) and error.code in ENGINE_MESSAGES else kind
    if isinstance(error, EngineError):
        message = ENGINE_MESSAGES.get(code, '番茄引擎处理失败。')
        if code == 'EngineError':
            code = 'engine_failed'
    elif isinstance(error, urllib.error.HTTPError):
        message = '官方接口返回 HTTP 错误。'
        if isinstance(error.code, int) and not isinstance(error.code, bool) and 100 <= error.code <= 599:
            detail['httpStatus'] = error.code
    elif isinstance(reason, ssl.SSLCertVerificationError):
        message = SSL_MESSAGES['CERTIFICATE_VERIFY_FAILED']
    elif isinstance(reason, ssl.SSLError):
        message = SSL_MESSAGES.get(getattr(reason, 'reason', None), 'TLS 连接失败。')
    elif isinstance(reason, socket.gaierror):
        message = 'DNS 域名解析失败。'
    elif isinstance(reason, TimeoutError):
        message = '连接或读取超时。'
    elif isinstance(reason, OSError):
        message = {
            errno.ECONNREFUSED: '连接被拒绝。', errno.ECONNRESET: '连接被重置。',
            errno.ENETUNREACH: '网络不可达。', errno.EHOSTUNREACH: '目标主机不可达。',
            errno.ETIMEDOUT: '连接或读取超时。',
        }.get(reason.errno, '网络或本地文件操作失败。')
    elif isinstance(error, urllib.error.URLError):
        message = '网络请求失败，未提供可安全返回的具体原因。'
    elif isinstance(error, json.JSONDecodeError):
        message = '官方接口响应不是有效 JSON。'
    elif isinstance(error, UnicodeDecodeError):
        message = '官方接口响应包含无效文本编码。'
    elif isinstance(error, (KeyError, ValueError, TypeError)):
        message = '官方接口响应或本地输入未通过格式检查。'
    else:
        code, message = 'engine_failed', '番茄引擎处理失败。'
    number = getattr(reason, 'errno', None)
    if isinstance(number, int) and not isinstance(number, bool) and -65536 <= number <= 65536:
        detail['errno'] = number
    detail['message'] = message
    return {'ok': False, 'complete': False, 'code': code, 'error': detail,
            'message': '番茄请求或完整性验证失败，未完成文件不作为下载成功交付'}


def contextual_error(error, stage, host, network_mode):
    """Attach only known request stages and fixed official hosts to a safe failure."""
    result = failure_result(error)
    if stage in ('registration', *API_STAGES.values()):
        result['sourceStage'] = stage
    if host in ('log.snssdk.com', 'api5-normal.fqnovel.com'):
        result['host'] = host
    if network_mode in ('direct', 'system'):
        result['networkMode'] = network_mode
    return EngineError(result['code'], result)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise EngineError('redirect_refused')


class ArticleText(html.parser.HTMLParser):
    """Prefer article text, otherwise body text; exclude document metadata and scripts."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.depth = {'article': 0, 'body': 0}
        self.ignored = 0
        self.has_article = False
        self.collected = {'article': [], 'body': []}

    @property
    def parts(self):
        return self.collected['article' if self.has_article else 'body']

    def append(self, text):
        if not self.ignored:
            for container, depth in self.depth.items():
                if depth:
                    self.collected[container].append(text)

    def handle_starttag(self, tag, attrs):
        if tag in ('head', 'script', 'style'):
            self.ignored += 1
        if tag in self.depth:
            self.depth[tag] += 1
            if tag == 'article' and not self.ignored:
                self.has_article = True
        if tag == 'br':
            self.append('\n')

    def handle_endtag(self, tag):
        if tag in ('p', 'h1', 'h2', 'div', 'blk'):
            self.append('\n')
        if tag in self.depth:
            self.depth[tag] = max(0, self.depth[tag] - 1)
        if tag in ('head', 'script', 'style'):
            self.ignored = max(0, self.ignored - 1)

    def handle_data(self, data):
        self.append(data)


def decrypt(value, key):
    raw = base64.b64decode(value, validate=True)
    if len(raw) < 32 or (len(raw) - 16) % 16:
        raise EngineError('invalid_ciphertext')
    return unpad(AES.new(key, AES.MODE_CBC, raw[:16]).decrypt(raw[16:]), 16)


def decode_chapter(chapter, expected, book_id, key, limit):
    """Reject missing, mismatched, paid or truncated chapters before any book is published."""
    meta = chapter.get('novel_data') or {}
    if chapter.get('code') != 0 or str(meta.get('item_id')) != expected['item_id'] or str(meta.get('book_id')) != book_id or int(meta.get('real_chapter_order') or 0) != expected['order']:
        raise EngineError('chapter_mismatch')
    if str(meta.get('vip_book', '0')) != '0' or meta.get('pay_info') or str(meta.get('sale_status', '0')) != '0':
        raise EngineError('authorization_required')
    content = chapter.get('content')
    if not isinstance(content, str) or content == 'Invalid':
        raise EngineError('chapter_unavailable')
    raw = decrypt(content, key)
    if chapter.get('compress_status') == 1:
        with gzip.GzipFile(fileobj=io.BytesIO(raw)) as stream:
            raw = stream.read(limit + 1)
    if len(raw) > limit:
        raise EngineError('chapter_size')
    text = raw.decode('utf-8', errors='strict')
    parser = ArticleText()
    parser.feed(text)
    parser.close()
    body = '\n'.join(line.strip() for line in ''.join(parser.parts).splitlines() if line.strip())
    words = int(expected.get('chapter_word_number') or meta.get('chapter_word_number') or 0)
    if not body or '\ufffd' in body or re.search('[\ue000-\uf8ff]', body) or words <= 0 or len(re.sub(r'\s', '', body)) < words:
        raise EngineError('incomplete_chapter')
    return body


def validate_catalog(book_id, result):
    """Keep official order and require the entire declared directory, never a fixed chapter cap."""
    data = result.get('data') or {}
    book = data.get('book_info') or {}
    items = data.get('item_data_list')
    total = int(book.get('serial_count') or 0)
    if str(book.get('book_id')) != book_id or not isinstance(items, list) or not total or len(items) != total:
        raise EngineError('incomplete_catalog')
    ids = [str(item.get('item_id', '')) for item in items]
    if len(set(ids)) != total or any(not re.fullmatch(r'\d{10,24}', item) for item in ids):
        raise EngineError('invalid_catalog')
    return book, [{**item, 'item_id': ids[index], 'order': index + 1} for index, item in enumerate(items)]


def search_page(query, result):
    """Project the official books tab without ads, private device fields or search ranking claims."""
    tabs = result.get('search_tabs')
    if not isinstance(tabs, list):
        raise EngineError('invalid_search_result')
    tab = next((tab for tab in tabs if isinstance(tab, dict) and tab.get('tab_type') == 3), None)
    if tab is None or not isinstance(tab.get('data'), list) or tab.get('has_more') not in (True, False, 0, 1):
        raise EngineError('invalid_search_result')
    more = bool(tab['has_more'])
    cursor = tab.get('passback') if more else None
    if more and (not isinstance(cursor, str) or not cursor):
        raise EngineError('invalid_search_result')
    items, seen = [], set()
    for group in tab['data']:
        books = group.get('book_data', []) if isinstance(group, dict) else None
        if not isinstance(books, list):
            raise EngineError('invalid_search_result')
        for book in books:
            book_id = book.get('book_id') if isinstance(book, dict) else None
            if not isinstance(book_id, str) or not re.fullmatch(r'\d{10,24}', book_id):
                raise EngineError('invalid_search_result')
            if book_id in seen:
                continue
            seen.add(book_id)
            def text(field):
                value = book.get(field) or ''
                if not isinstance(value, str):
                    raise EngineError('invalid_search_result')
                return html.unescape(re.sub(r'</?em>', '', value)).strip()
            title = text('book_name')
            count = str(book.get('serial_count') or '0')
            if not title or not re.fullmatch(r'\d+', count):
                raise EngineError('invalid_search_result')
            items.append({'bookId': book_id, 'title': title, 'originalTitle': text('original_book_name') or None,
                          'author': text('author'), 'chapterCount': int(count),
                          'url': 'https://fanqienovel.com/page/' + book_id})
    return {'ok': True, 'complete': False, 'query': query, 'hasMore': more, 'nextPassback': cursor, 'items': items}


class Client:
    """Normal anonymous registration and read endpoints only; no privilege or account writes."""
    def __init__(self, settings):
        self.settings = settings
        self.network_mode = settings.get('networkMode', 'direct')
        self.source_stage, self.host = 'registration', 'log.snssdk.com'
        if self.network_mode not in ('direct', 'system'):
            raise EngineError('invalid_network_mode')
        handlers = [NoRedirect()]
        if self.network_mode == 'direct':
            handlers.append(urllib.request.ProxyHandler({}))
        self.opener = urllib.request.build_opener(*handlers)
        now = int(time.time() * 1000)
        header = {'aid': 1967, 'app_name': 'novelapp', 'app_package': 'com.dragon.read', 'display_name': '番茄免费小说',
                  'app_version': '6.8.1.32', 'version_code': 68132, 'update_version_code': 68132, 'manifest_version_code': 68132,
                  'channel': 'store', 'sdk_version': '3.7.0-rc.25-fanqie-xiaoshuo', 'sdk_target_version': 29,
                  'device_platform': 'android', 'os': 'Android', 'os_version': '12', 'os_api': 31,
                  'device_model': 'Pixel 5', 'device_brand': 'google', 'device_manufacturer': 'Google', 'cpu_abi': 'arm64-v8a',
                  'resolution': '1080x2340', 'density_dpi': 440, 'display_density': 'hdpi', 'openudid': secrets.token_hex(8),
                  'clientudid': str(uuid.uuid4()), 'cdid': str(uuid.uuid4()), 'language': 'zh', 'timezone': 8,
                  'tz_name': 'Asia/Shanghai', 'tz_offset': 28800, 'not_request_sender': 0, 'apk_first_install_time': now, 'is_system_app': 0}
        self.ua = 'com.dragon.read/68132 (Linux; U; Android 12; zh_CN; Pixel 5; Build/SP1A.210812.016; Cronet/TTNetVersion:5.1.137.1)'
        registration = TT().encrypt(json.dumps({'magic_tag': 'ss_app_log', 'header': header, '_gen_time': now}, ensure_ascii=False, separators=(',', ':')))
        device = self.request('https://log.snssdk.com/service/2/device_register/?aid=1967&app_name=novelapp&version_code=68132&device_platform=android', registration, {'content-type': 'application/octet-stream;tt-data=a'})
        device_id, iid = device.get('device_id_str'), device.get('install_id_str')
        if not isinstance(device_id, str) or not re.fullmatch(r'\d+', device_id) or not isinstance(iid, str) or not re.fullmatch(r'\d+', iid):
            raise EngineError('registration_failed')
        self.query = {'aid': '1967', 'app_name': 'novelapp', 'version_name': header['app_version'], 'version_code': '68132',
                      'update_version_code': '68132', 'manifest_version_code': '68132', 'channel': 'store', 'device_platform': 'android',
                      'device_type': header['device_model'], 'device_brand': header['device_brand'], 'os_version': '12', 'os_api': '31',
                      'host_abi': 'arm64-v8a', 'language': 'zh', 'ac': 'wifi', 'ssmix': 'a', 'resolution': header['resolution'],
                      'openudid': header['openudid'], 'cdid': header['cdid'], 'dragon_device_type': 'phone', 'device_id': device_id, 'iid': iid}
        self.key = None
        self.keyver = None

    def request(self, url, body=None, headers=None):
        self.host = urllib.parse.urlsplit(url).hostname
        try:
            request = urllib.request.Request(url, data=body, headers={'user-agent': self.ua, 'accept-encoding': 'identity', **(headers or {})})
            with self.opener.open(request, timeout=self.settings['requestTimeoutMs'] / 1000) as response:
                if response.status != 200 or response.headers.get('content-encoding', 'identity') != 'identity':
                    raise EngineError('http_response')
                raw = response.read(self.settings['maxResponseBytes'] + 1)
                if len(raw) > self.settings['maxResponseBytes']:
                    raise EngineError('response_size')
                result = json.loads(raw)
                if not isinstance(result, dict) or result.get('code', 0) != 0:
                    raise EngineError('platform_rejected')
                return result
        except Exception as error:
            raise contextual_error(error, self.source_stage, self.host, self.network_mode) from None

    def api(self, path, params=None, body=None):
        self.source_stage, self.host = API_STAGES[path], 'api5-normal.fqnovel.com'
        query = urllib.parse.urlencode({**self.query, **(params or {}), '_rticket': str(int(time.time() * 1000))})
        raw = json.dumps(body, separators=(',', ':')).encode() if body is not None else None
        stub = hashlib.md5(raw).hexdigest().upper() if raw else ''
        stamp = int(time.time())
        first = lambda value: list(hashlib.md5(value).digest()[:4])
        part = first(query.encode()) + (list(bytes.fromhex(stub)[:4]) if stub else [0] * 4) + [0] * 8 + list(stamp.to_bytes(4, 'big'))
        headers = {'x-argus': Argus.get_sign(query, stub, stamp, aid=1967), 'x-ladon': Ladon.encrypt(stamp, 1611921764, 1967),
                   'x-gorgon': XG(part).main(), 'x-khronos': str(stamp), 'x-ss-req-ticket': str(int(time.time() * 1000)),
                   'content-type': 'application/json; charset=utf-8', 'sdk-version': '2', 'passport-sdk-version': '5051452'}
        if stub:
            headers['x-ss-stub'] = stub
        return self.request('https://api5-normal.fqnovel.com' + path + '?' + query, raw, headers)

    def negotiate(self):
        protocol_key = bytes.fromhex('ac25c67ddd8f38c1b37a2348828e222e')
        iv = secrets.token_bytes(16)
        plain = int(self.query['device_id']).to_bytes(8, 'little') + bytes(8)
        value = base64.b64encode(iv + AES.new(protocol_key, AES.MODE_CBC, iv).encrypt(pad(plain, 16))).decode()
        result = self.api('/reading/crypt/registerkey', body={'content': value}).get('data') or {}
        self.key = decrypt(result['key'], protocol_key)
        self.keyver = result['keyver']
        if len(self.key) != 16:
            raise EngineError('invalid_content_key')

    def directory(self, book_id):
        return validate_catalog(book_id, self.api('/reading/bookapi/directory/all_items/v/', {'book_id': book_id}))

    def search(self, query, passback):
        return search_page(query, self.api('/reading/bookapi/search/tab/v/',
                           {'query': query, 'tab_type': '3', 'passback': passback}))

    def download(self, book_id, staging):
        book, chapters = self.directory(book_id)
        if str(book.get('vip_book', '0')) != '0' or str(book.get('sale_status', '0')) != '0':
            raise EngineError('authorization_required')
        if self.key is None:
            self.negotiate()
        self.source_stage, self.host = 'chapter-download', 'api5-normal.fqnovel.com'
        path = Path(staging) / (book_id + '.txt')
        receipts = []
        size = 0
        with path.open('x', encoding='utf-8', newline='\n') as output:
            os.chmod(path, 0o600)
            title = str(book.get('book_name') or book_id)
            output.write(title + '\n\n')
            for start in range(0, len(chapters), self.settings['batchSize']):
                batch = chapters[start:start + self.settings['batchSize']]
                result = self.api('/reading/reader/batch_full/v', {'book_id': book_id, 'item_ids': ','.join(c['item_id'] for c in batch), 'keyver': self.keyver, 'req_type': '0'})
                data = result.get('data') or {}
                for item in batch:
                    chapter = data.get(item['item_id'])
                    if not isinstance(chapter, dict):
                        raise EngineError('missing_chapter')
                    text = decode_chapter(chapter, item, book_id, self.key, self.settings['maxChapterBytes'])
                    size += len(text.encode()) + 2
                    if size > self.settings['maxBookBytes']:
                        raise EngineError('book_size')
                    output.write(text + '\n\n')
                    receipts.append({'itemId': item['item_id'], 'title': item.get('title', ''), 'characters': len(text), 'sha256': hashlib.sha256(text.encode()).hexdigest()})
        return {'bookId': book_id, 'title': title, 'originalTitle': book.get('original_book_name'), 'author': book.get('author'), 'chapterCount': len(chapters), 'downloadedChapters': len(receipts),
                'complete': True, 'scope': 'current-published-directory', 'file': path.name, 'bytes': path.stat().st_size,
                'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'chapters': receipts}


def run(request):
    client = None
    settings = request['settings']
    try:
        client = Client(settings)
        if request['operation'] == 'search':
            return client.search(request['query'], request['passback'])
        if request['operation'] == 'info':
            items = []
            for book_id in request['bookIds']:
                book, chapters = client.directory(book_id)
                items.append({'bookId': book_id, 'title': book.get('book_name'), 'originalTitle': book.get('original_book_name'), 'author': book.get('author'), 'chapterCount': len(chapters),
                              'complete': False, 'downloadVerified': False, 'chapters': [{'itemId': c['item_id'], 'title': c.get('title')} for c in chapters]})
            return {'ok': True, 'complete': False, 'items': items}
        items = [client.download(book_id, request['staging']) for book_id in request['bookIds']]
        return {'ok': True, 'complete': True, 'items': items}
    except Exception as error:
        if isinstance(error, EngineError) and error.diagnostic is not None:
            raise
        raise contextual_error(error, client.source_stage if client else 'registration',
                               client.host if client else 'log.snssdk.com',
                               settings.get('networkMode', 'direct')) from None


def main():
    """Write exactly one safe JSON result and preserve a failing process exit status."""
    try:
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise EngineError('input_size')
        print(json.dumps(run(json.loads(raw)), ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps(failure_result(error), ensure_ascii=False))
        return 1


if __name__ == '__main__':
    sys.exit(main())
