"""Offline parser/registration tests, including the real socket-free NativeRpc path."""
import copy
import json
import unittest
from unittest import mock

from native_rpc import NativeRpc, RpcError
import remote_wire as wire
from operations.fixed_operations import OperationError, call_operation, fixed_operations, split_result, validate_parameters

SELECTION = {'srcAppId': 'wx6522458df7ed3af2', 'dramaId': '000121225'}
FAKE_URL = 'https://synthetic.invalid/media?capability=not-real'


def public(operation):
    value = {'operation': operation, 'status': {'status': 'status-returned', 'search': 'search-returned', 'detail': 'detail-returned', 'episodes': 'episodes-returned', 'download_first_episode': 'first-episode-address-returned'}[operation], 'identityMatched': True, 'appVersion': '108', 'envVersion': 'release', 'pluginVersion': '1.15.14', 'hostLoginState': True, 'businessCalls': {'status': 0, 'search': 1, 'detail': 1, 'episodes': 2, 'download_first_episode': 2}[operation], 'timedOut': False}
    if operation == 'status':
        value.update(hasRequire=True, hasBizRequest=True, hasNativeWrapper=True)
    if operation == 'search':
        value.update(resultCount=1, partial=False, candidates=[{'title': '合成剧名', 'srcAppId': SELECTION['srcAppId'], 'originDramaId': SELECTION['dramaId']}])
    if operation in ('detail', 'episodes', 'download_first_episode'):
        value.update(**SELECTION, title='合成剧名', episodeCount=36, isFirstMediaFree=True, hasVideoInfo=True, hasPlayAuthorization=True)
    if operation == 'episodes':
        value.update(requestedStart=1, requestedEndExclusive=4, episodeNumbers=[1, 2, 3], partial=False)
    if operation == 'download_first_episode':
        value.update(serialNo=1, isStraight=True, hasPrivateMedia=True)
    return value


def raw(operation):
    private = None
    if operation == 'download_first_episode':
        private = {'mediaUrl': FAKE_URL, 'binding': {'hostAppId': 'wx404dde55fb12df78', **SELECTION, 'serialNo': 1, 'isFirstMediaFree': True, 'isStraight': True}}
    return {'publicResult': public(operation), 'privateResult': private}


def parameters(operation):
    if operation == 'status': return {}
    if operation == 'search': return {'query': '老手'}
    if operation == 'episodes': return {**SELECTION, 'start': 1, 'count': 3}
    return dict(SELECTION)


class Tests(unittest.TestCase):
    def test_engagement_metadata_preserves_null_and_zero_and_rejects_extra_personal_data(self):
        params = {**SELECTION, 'episodeNo': 2}
        value = public('status')
        for key in ('hasRequire', 'hasBizRequest', 'hasNativeWrapper'):
            value.pop(key)
        value.update(operation='engagement', status='engagement-returned', businessCalls=1, **params,
                     observedAtMs=1792730976000, counts={'likes': 0, 'comments': None, 'recommendations': 34, 'shares': 4})
        self.assertEqual(split_result('engagement', params, {'publicResult': value, 'privateResult': None})[0], value)
        for patch in ({'episodeNo': True}, {'episodeNo': 3}, {'observedAtMs': None}, {'counts': {**value['counts'], 'username': 'private'}}, {'counts': {**value['counts'], 'likes': -1}}):
            with self.assertRaises(OperationError):
                split_result('engagement', params, {'publicResult': {**value, **patch}, 'privateResult': None})

    def test_ranking_pages_keep_identity_and_source_rank_positions(self):
        params = {'boardType': 6, 'pageIndex': 1, 'count': 2, 'coldStartTime': 1792530000}
        value = public('search')
        for key in ('resultCount', 'candidates'):
            value.pop(key)
        value.update(operation='rankings', status='rankings-returned', boardType=6, pageIndex=1,
                     pageSize=2, coldStartTime=params['coldStartTime'], total=5, hasMore=True,
                     boards=[{'type': 6, 'name': '口碑榜'}],
                     entries=[{'rank': 3, 'title': '合成剧名', 'srcAppId': SELECTION['srcAppId'], 'originDramaId': SELECTION['dramaId']}], partial=True)
        self.assertEqual(split_result('rankings', params, {'publicResult': value, 'privateResult': None})[0], value)
        for patch in ({'pageIndex': -1}, {'boardType': True}, {'count': 21}, {'coldStartTime': 0}):
            with self.assertRaises(OperationError):
                validate_parameters('rankings', {**params, **patch})
        for patch in ({'pageIndex': 0}, {'hasMore': False}, {'total': None}, {'boards': [{'type': 6, 'name': None}]},
                      {'entries': [{**value['entries'][0], 'rank': 1}]}):
            with self.assertRaises(OperationError):
                split_result('rankings', params, {'publicResult': {**value, **patch}, 'privateResult': None})

    def test_host_must_explicitly_whitelist_known_operations(self):
        for invalid in [None, 'search', ['login'], ['search', 'search'], [['search']]]:
            with self.assertRaises(OperationError): fixed_operations(invalid)
        registry = fixed_operations(['status', 'search'])
        self.assertEqual(set(registry), {'status', 'search'})
        self.assertEqual(registry['search'].expression.count('@@PARAMS@@'), 1)
        self.assertEqual(registry['search'].timeout_seconds, 35)
        self.assertEqual(registry['search'].validate({'query': '老手'}), {'operation': 'search', 'query': '老手'})

    def test_exact_parameter_fields_and_opaque_ids(self):
        for operation in ('status', 'search', 'detail', 'episodes', 'download_first_episode'):
            self.assertEqual(validate_parameters(operation, parameters(operation))['operation'], operation)
        value = validate_parameters('detail', {**SELECTION, 'dramaId': '0' * 128})
        self.assertEqual(value['dramaId'], '0' * 128)
        self.assertEqual(validate_parameters('search', {'query': '😀' * 80})['query'], '😀' * 80)
        for operation, request in [('status', {'operation': 'status'}), ('search', {'query': 'x' * 81}), ('search', {'query': 'x\n'}), ('search', {'query': '\ud800'}), ('detail', {**SELECTION, 'dramaId': 121225}), ('detail', {**SELECTION, 'dramaId': 'x' * 129}), ('episodes', {**SELECTION, 'start': True, 'count': 3}), ('episodes', {**SELECTION, 'start': 1, 'count': 21}), ('search', {'query': '老手', '__proto__': {}})]:
            with self.assertRaises(OperationError): validate_parameters(operation, request)

    def test_each_public_result_is_strict_and_private_url_is_separate(self):
        for operation in ('status', 'search', 'detail', 'episodes', 'download_first_episode'):
            exposed, hidden = split_result(operation, parameters(operation), raw(operation))
            self.assertEqual(exposed, public(operation))
            self.assertNotIn(FAKE_URL, json.dumps(exposed))
            self.assertEqual(hidden is not None, operation == 'download_first_episode')

    def test_arbitrary_episode_parameters_result_and_private_binding_are_exact(self):
        params={**SELECTION,'episodeNo':7}
        self.assertEqual(validate_parameters('download_episode',params),{'operation':'download_episode',**params})
        value=raw('download_first_episode');value['publicResult'].update(operation='download_episode',status='episode-address-returned',serialNo=7,isFirstMediaFree=False)
        value['privateResult']['binding']={'hostAppId':'wx404dde55fb12df78',**SELECTION,'serialNo':7,'isStraight':True,'playAuthorization':'native-straight-playback'}
        exposed,private=split_result('download_episode',params,value)
        self.assertEqual(exposed['serialNo'],7);self.assertNotIn(FAKE_URL,json.dumps(exposed))
        self.assertEqual(private['binding']['playAuthorization'],'native-straight-playback')
        for request in [dict(params,episodeNo=True),dict(params,episodeNo=0),dict(params,episodeNo=1<<53),dict(params,idempotencyKey='a'*64)]:
            with self.assertRaises(OperationError):validate_parameters('download_episode',request)
        for change in [lambda x:x['publicResult'].update(serialNo=8),lambda x:x['publicResult'].update(isStraight=False),lambda x:x['privateResult']['binding'].update(serialNo=True),lambda x:x['privateResult']['binding'].update(playAuthorization='assumed')]:
            candidate=copy.deepcopy(value);change(candidate)
            with self.assertRaises(OperationError):split_result('download_episode',params,candidate)

    def test_unknown_fields_url_titles_and_false_success_are_rejected(self):
        for mutate in [lambda x: x.update(extra=FAKE_URL), lambda x: x['publicResult'].update(extra=FAKE_URL), lambda x: x['publicResult'].update(title=FAKE_URL), lambda x: x['publicResult'].update(identityMatched=False), lambda x: x['publicResult'].update(businessCalls=True), lambda x: x['publicResult'].update(status={'raw': FAKE_URL})]:
            value = raw('detail'); mutate(value)
            with self.assertRaises(OperationError): split_result('detail', SELECTION, value)

    def test_bad_episode_ranges_duplicates_and_missing_partial_flag_rejected(self):
        for numbers, end, partial in [([1, 4], 4, True), ([1, 1], 4, True), ([2, 1], 4, True), ([True], 4, True), ([1], None, True), ([1], 4, False)]:
            value = raw('episodes'); value['publicResult'].update(episodeNumbers=numbers, requestedEndExclusive=end, partial=partial)
            with self.assertRaises(OperationError): split_result('episodes', parameters('episodes'), value)
        value = raw('episodes'); value['publicResult'].update(episodeNumbers=[1, 3], partial=True)
        self.assertEqual(split_result('episodes', parameters('episodes'), value)[0]['episodeNumbers'], [1, 3])

    def test_unexpected_private_data_and_boolean_serial_do_not_pass(self):
        value = raw('detail'); value['privateResult'] = {'mediaUrl': FAKE_URL}
        with self.assertRaises(OperationError): split_result('detail', SELECTION, value)
        for mutate in [lambda x: x['publicResult'].update(serialNo=True), lambda x: x['privateResult']['binding'].update(serialNo=True), lambda x: x['privateResult']['binding'].update(isStraight=1), lambda x: x['privateResult']['binding'].update(dramaId='another'), lambda x: x['privateResult'].update(mediaUrl='http://synthetic.invalid/x'), lambda x: x['publicResult'].update(hasPrivateMedia=False)]:
            value = raw('download_first_episode'); mutate(value)
            with self.assertRaises(OperationError): split_result('download_first_episode', SELECTION, value)

    def test_optional_diagnostics_are_fixed_and_never_replace_required_public_fields(self):
        value = raw('search')
        value['publicResult'].update(status='native-call-failed', failurePhase='call-pending', failureKind='TypeError', nativeErrorCode=-2147483648)
        self.assertEqual(split_result('search', parameters('search'), value)[0]['nativeErrorCode'], -2147483648)
        for key, invalid in [('failurePhase', 'raw-private'), ('failureKind', 'CustomError'), ('nativeErrorCode', True), ('nativeErrorCode', 2147483648), ('nativeErrorCode', -2147483649), ('nativeErrorCode', '1')]:
            candidate = copy.deepcopy(value); candidate['publicResult'][key] = invalid
            with self.assertRaises(OperationError): split_result('search', parameters('search'), candidate)
        for mutate in [lambda x: x.pop('businessCalls'), lambda x: x.update(message=FAKE_URL), lambda x: x.update(status='search-returned')]:
            candidate = copy.deepcopy(value); mutate(candidate['publicResult'])
            with self.assertRaises(OperationError): split_result('search', parameters('search'), candidate)


class AsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_download_requires_trusted_consumer_before_dispatch(self):
        rpc = mock.Mock(call=mock.AsyncMock(return_value=raw('download_first_episode')))
        with self.assertRaisesRegex(OperationError, '^private-media-consumer-required$'):
            await call_operation(rpc, 'download_first_episode', SELECTION)
        rpc.call.assert_not_called()

    async def test_private_consumer_only_receives_url_and_its_result_is_never_model_visible(self):
        rpc = mock.Mock(call=mock.AsyncMock(return_value=raw('download_first_episode')))
        consumer = mock.AsyncMock(return_value={'secret': FAKE_URL})
        output = await call_operation(rpc, 'download_first_episode', SELECTION, private_media_consumer=consumer)
        self.assertEqual(output, public('download_first_episode'))
        self.assertNotIn(FAKE_URL, json.dumps(output))
        consumer.assert_awaited_once()
        self.assertEqual(consumer.call_args.args[0], FAKE_URL)

    async def test_consumer_failure_is_sanitized_and_does_not_retry_native_rpc(self):
        rpc = mock.Mock(call=mock.AsyncMock(return_value=raw('download_first_episode')))
        consumer = mock.Mock(side_effect=RuntimeError(FAKE_URL))
        with self.assertRaisesRegex(OperationError, '^private-media-consumer-failed$'):
            await call_operation(rpc, 'download_first_episode', SELECTION, private_media_consumer=consumer)
        rpc.call.assert_awaited_once()

    async def test_actual_native_rpc_registry_identity_recheck_and_wire_reply_only_expose_public(self):
        records = []
        rpc = None
        async def send(frame_bytes):
            frame = wire.decode_frame(frame_bytes)
            cdp = json.loads(frame.payload.payload)
            records.append(cdp)
            is_identity = 'matchesExpected' in cdp['params']['expression']
            value = {'matchesExpected': True, 'hasOperateWXData': True} if is_identity else raw('search')
            response = {'id': cdp['id'], 'result': {'result': {'type': 'object', 'value': value}}}
            await rpc.accept_frame(wire.encode_frame(wire.CATEGORY_CHROME_DEVTOOLS_RESULT, {'opId': 0, 'payload': json.dumps(response), 'jscontextId': ''}, seq=len(records)))
        rpc = NativeRpc(send, 'wx404dde55fb12df78', fixed_operations(['search']), initial_sequence=10, initial_op_id=20, initial_cdp_id=30)
        try:
            await rpc.verify_context('', 3)
            output = await call_operation(rpc, 'search', {'query': '老手'})
            self.assertEqual(output, public('search'))
            self.assertEqual(len(records), 3)
            self.assertTrue('matchesExpected' in records[0]['params']['expression'])
            self.assertTrue('matchesExpected' in records[1]['params']['expression'])
            self.assertIn('JSON.parse(', records[2]['params']['expression'])
            self.assertNotIn('@@PARAMS@@', records[2]['params']['expression'])
            self.assertEqual([row['id'] for row in records], [31, 32, 33])
            self.assertNotIn('老手', json.dumps(rpc.receipt(), ensure_ascii=False))
            with self.assertRaisesRegex(RpcError, '^operation-not-registered$'):
                await rpc.call('detail', SELECTION)
        finally:
            rpc.close()


if __name__ == '__main__':
    unittest.main()
