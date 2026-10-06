"""Independent read-only Fanqie client; identities and negotiated keys remain in memory."""
import base64
import hashlib
import html.parser
import io
import json
import gzip
import os
from pathlib import Path
import re
import secrets
import sys
import time
import urllib.parse
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


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise EngineError('redirect_refused')


class ArticleText(html.parser.HTMLParser):
    """Extract article text while discarding executable markup and external resources."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.depth = 0
        self.ignored = 0
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag == 'article':
            self.depth += 1
        if tag in ('script', 'style'):
            self.ignored += 1

    def handle_endtag(self, tag):
        if tag in ('p', 'h1', 'h2', 'div', 'blk') and self.depth and not self.ignored:
            self.parts.append('\n')
        if tag == 'article':
            self.depth = max(0, self.depth - 1)
        if tag in ('script', 'style'):
            self.ignored = max(0, self.ignored - 1)

    def handle_data(self, data):
        if self.depth and not self.ignored:
            self.parts.append(data)


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


class Client:
    """Normal anonymous registration and read endpoints only; no privilege or account writes."""
    def __init__(self, settings):
        self.settings = settings
        self.opener = urllib.request.build_opener(NoRedirect())
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

    def api(self, path, params=None, body=None):
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

    def download(self, book_id, staging):
        book, chapters = self.directory(book_id)
        if str(book.get('vip_book', '0')) != '0' or str(book.get('sale_status', '0')) != '0':
            raise EngineError('authorization_required')
        if self.key is None:
            self.negotiate()
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
    client = Client(request['settings'])
    if request['operation'] == 'info':
        items = []
        for book_id in request['bookIds']:
            book, chapters = client.directory(book_id)
            items.append({'bookId': book_id, 'title': book.get('book_name'), 'originalTitle': book.get('original_book_name'), 'author': book.get('author'), 'chapterCount': len(chapters),
                          'complete': False, 'downloadVerified': False, 'chapters': [{'itemId': c['item_id'], 'title': c.get('title')} for c in chapters]})
        return {'ok': True, 'complete': False, 'items': items}
    items = [client.download(book_id, request['staging']) for book_id in request['bookIds']]
    return {'ok': True, 'complete': True, 'items': items}


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise EngineError('input_size')
        print(json.dumps(run(json.loads(raw)), ensure_ascii=False))
    except Exception as error:
        code = str(error) if isinstance(error, EngineError) else type(error).__name__
        print(json.dumps({'ok': False, 'complete': False, 'code': code, 'message': '番茄请求或完整性验证失败，未完成文件不作为下载成功交付'}))
        sys.exit(1)
