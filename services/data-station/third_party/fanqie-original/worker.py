"""One-book, bounded JSON-line worker. Anonymous identities and keys never leave this process."""
import json
from pathlib import Path
import re
import sys
import time
import unicodedata
import urllib.parse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from engine import Client, EngineError, decode_chapter, failure_result


class OriginalClient(Client):
    """Limit the copied client to its normal official free-reading operations."""
    def __init__(self, settings):
        self.previous_request = 0
        super().__init__(settings)

    def request(self, url, body=None, headers=None):
        parsed = urllib.parse.urlsplit(url)
        registration = parsed.hostname == 'log.snssdk.com' and parsed.path == '/service/2/device_register/'
        reading = parsed.hostname == 'api5-normal.fqnovel.com' and parsed.path in (
            '/reading/bookapi/directory/all_items/v/', '/reading/crypt/registerkey', '/reading/reader/batch_full/v')
        if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in (None, 443) or not (registration or reading):
            raise EngineError('platform_rejected')
        wait = self.settings['requestIntervalMs'] / 1000 - (time.monotonic() - self.previous_request)
        if wait > 0:
            time.sleep(wait)
        self.previous_request = time.monotonic()
        return super().request(url, body, headers)


def public_count(value):
    if isinstance(value, bool) or not re.fullmatch(r'\d+', str(value)):
        raise EngineError('invalid_catalog')
    number = int(value)
    if number > 9007199254740991:
        raise EngineError('invalid_catalog')
    return number


def settings(value):
    """Validate the subprocess input before registration or any size-dependent read."""
    if not isinstance(value, dict) or set(value) != {'requestTimeoutMs', 'requestIntervalMs', 'maxResponseBytes', 'maxChapterBytes', 'networkMode'}:
        raise EngineError('input_size')
    for key, minimum, maximum in (('requestTimeoutMs', 100, 120000), ('requestIntervalMs', 0, 60000),
                                  ('maxResponseBytes', 1024, 33554432), ('maxChapterBytes', 1024, 8388608)):
        if isinstance(value[key], bool) or not isinstance(value[key], int) or not minimum <= value[key] <= maximum:
            raise EngineError('input_size')
    if value['networkMode'] not in ('direct', 'system'):
        raise EngineError('invalid_network_mode')
    return value


def directory(client, book_id):
    book, chapters = client.directory(book_id)
    if str(book.get('vip_book', '0')) != '0' or str(book.get('sale_status', '0')) != '0' or book.get('pay_info'):
        raise EngineError('authorization_required')
    for item in chapters:
        if any(str(item.get(key, '0')).lower() not in ('0', 'false', 'none', '') for key in ('need_pay', 'needPay', 'is_vip', 'isChapterLock')) or item.get('pay_info'):
            raise EngineError('authorization_required')
        declared_order = item.get('real_chapter_order')
        if declared_order is not None and public_count(declared_order) != item['order']:
            raise EngineError('chapter_mismatch')
    return book, chapters


RETRY_ATTEMPTS = 5
RETRY_DELAY_SECONDS = 1.2
# A single anonymous registration stops serving chapter reads after roughly 100-160 requests or ~30-60s;
# rotate the session comfortably below both limits, observed 2026-11-15 against the official reading API.
ROTATE_AFTER_CHAPTERS = 40
ROTATE_AFTER_SECONDS = 15
NON_RETRYABLE_CODES = frozenset({'authorization_required', 'invalid_network_mode', 'input_size'})


def retryable(error):
    """Retry transient platform, transport and decoding failures only; authorization is final."""
    return isinstance(error, EngineError) and error.code not in NON_RETRYABLE_CODES


def pause(attempt):
    time.sleep(min(RETRY_DELAY_SECONDS * attempt, 10.0))


def fetch_directory(client, book_id):
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        try:
            return directory(client, book_id)
        except Exception as error:
            if attempt == RETRY_ATTEMPTS or not retryable(error):
                raise
            pause(attempt)


def fetch_chapter(client, book_id, expected):
    """Fetch and decode one chapter, retrying only bounded transient failures."""
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        try:
            if client.key is None:
                client.negotiate()
            response = client.api('/reading/reader/batch_full/v', {'book_id': book_id, 'item_ids': expected['item_id'],
                                                                   'keyver': client.keyver, 'req_type': '0'})
            chapter = (response.get('data') or {}).get(expected['item_id'])
            if not isinstance(chapter, dict):
                raise EngineError('missing_chapter')
            if chapter.get('code') != 0:
                raise EngineError('platform_rejected')
            meta = chapter.get('novel_data') or {}
            if any(str(meta.get(key, '0')).lower() not in ('0', 'false', 'none', '') for key in ('is_vip', 'need_pay', 'needPay', 'isChapterLock')):
                raise EngineError('authorization_required')
            text = decode_chapter(chapter, expected, book_id, client.key, client.settings['maxChapterBytes'])
            if any(unicodedata.category(char) == 'Co' or char == '\ufffd' or ord(char) < 32 and char not in '\n\r\t' for char in text):
                raise EngineError('incomplete_chapter')
            return text
        except Exception as error:
            if attempt == RETRY_ATTEMPTS or not retryable(error):
                raise
            pause(attempt)


def session_exhausted(served, started_at):
    """One anonymous registration is time- and request-bounded by the reading API; never rely on the exact quota."""
    return served >= ROTATE_AFTER_CHAPTERS or time.monotonic() - started_at >= ROTATE_AFTER_SECONDS


def serve_chapter(client, client_settings, book_id, expected, served, started_at, make_client=OriginalClient):
    """Returns (text, client, served, started_at); rotates the anonymous session before and after the read quota."""
    while True:
        if session_exhausted(served, started_at):
            client, served, started_at = make_client(client_settings), 0, time.monotonic()
        try:
            text = fetch_chapter(client, book_id, expected)
            return text, client, served + 1, started_at
        except Exception as error:
            if not isinstance(error, EngineError) or error.code in NON_RETRYABLE_CODES or served == 0:
                raise
            # The registration, not the book, is exhausted; a fresh anonymous session continues the same verified directory.
            client = make_client(client_settings)
            return fetch_chapter(client, book_id, expected), client, 1, time.monotonic()


def safe_failure(error):
    result = failure_result(error)
    allowed = {key: result[key] for key in ('code', 'sourceStage', 'host', 'networkMode', 'error') if key in result}
    return {'ok': False, **allowed}


def main():
    client, book, chapters, book_id, client_settings, served, session_started = None, None, None, None, None, 0, 0.0
    for raw in iter(lambda: sys.stdin.buffer.readline(65537), b''):
        request_id = None
        try:
            if len(raw) > 65536 or not raw.endswith(b'\n'):
                raise EngineError('input_size')
            request = json.loads(raw)
            request_id = request['id']
            if not isinstance(request_id, int) or isinstance(request_id, bool) or request_id < 1:
                raise EngineError('input_size')
            operation = request['operation']
            if operation == 'close':
                print(json.dumps({'id': request_id, 'ok': True, 'closed': True}), flush=True)
                return 0
            if operation == 'directory':
                if client is not None or not isinstance(request['bookId'], str) or not re.fullmatch(r'\d{1,30}', request['bookId']):
                    raise EngineError('invalid_catalog')
                book_id = request['bookId']
                client_settings = settings(request['settings'])
                client = OriginalClient(client_settings)
                book, chapters = fetch_directory(client, book_id)
                served, session_started = 0, time.monotonic()
                result = {'ok': True, 'bookId': book_id, 'title': book.get('book_name'), 'author': book.get('author'),
                          'chapters': [{'id': c['item_id'], 'index': c['order'], 'title': c.get('title'),
                                        'wordCount': public_count(c['chapter_word_number']) if c.get('chapter_word_number') is not None else None,
                                        'updatedAt': str(c['update_time']) if c.get('update_time') is not None else None} for c in chapters]}
            elif operation == 'chapter' and client is not None:
                expected = next((item for item in chapters if item['item_id'] == request['chapterId']), None)
                if expected is None:
                    raise EngineError('missing_chapter')
                text, client, served, session_started = serve_chapter(client, client_settings, book_id, expected, served, session_started)
                result = {'ok': True, 'bookId': book_id, 'chapterId': expected['item_id'], 'index': expected['order'], 'text': text}
            else:
                raise EngineError('input_size')
            print(json.dumps({'id': request_id, **result}, ensure_ascii=False), flush=True)
        except Exception as error:
            print(json.dumps({'id': request_id, **safe_failure(error)}, ensure_ascii=False), flush=True)
            return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
