(async function () {
  'use strict';
  const params = @@PARAMS@@;
  const targetAppId = 'wx404dde55fb12df78';
  const operations = ['status', 'search', 'detail', 'episodes', 'download_first_episode', 'download_episode', 'rankings', 'engagement'];
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const appId = value => typeof value === 'string' && /^wx[0-9a-f]{16}$/.test(value);
  const dramaId = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
  const text = (value, limit) => typeof value === 'string' && !/[\u0000-\u001f\u007f]|[a-z][a-z0-9+.-]*:\/\//i.test(value) ? Array.from(value).slice(0, limit).join('') : null;
  const operation = isObject(params) && operations.includes(params.operation) ? params.operation : null;
  const out = {operation, status: 'parameters-invalid', identityMatched: false, appVersion: null, envVersion: null, pluginVersion: null, hostLoginState: null, businessCalls: 0, timedOut: false};
  const result = {publicResult: out, privateResult: null};
  let phase = 'before-call';
  function failureKind(error) {
    try {
      if (error instanceof TypeError) return 'TypeError';
      if (error instanceof ReferenceError) return 'ReferenceError';
      if (error instanceof RangeError) return 'RangeError';
      if (error instanceof Error) return 'Error';
    } catch (inspectionError) {
      return 'other';
    }
    return 'other';
  }
  function nativeErrorCode(error) {
    if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return null;
    for (const key of ['ret', 'err_no', 'errCode']) {
      let descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(error, key); }
      catch (inspectionError) { return null; }
      if (descriptor && 'value' in descriptor && typeof descriptor.value === 'number' && Number.isInteger(descriptor.value) && descriptor.value >= -2147483648 && descriptor.value <= 2147483647) return descriptor.value;
    }
    return null;
  }
  let fields;
  if (operation === 'status') fields = ['operation'];
  else if (operation === 'search') fields = ['operation', 'query'];
  else if (operation === 'rankings') fields = ['operation', 'boardType', 'pageIndex', 'count', 'coldStartTime'];
  else if (operation === 'episodes') fields = ['operation', 'srcAppId', 'dramaId', 'start', 'count'];
  else if (operation === 'download_episode' || operation === 'engagement') fields = ['operation', 'srcAppId', 'dramaId', 'episodeNo'];
  else if (operation !== null) fields = ['operation', 'srcAppId', 'dramaId'];
  if (!fields || Object.keys(params).length !== fields.length || fields.some(key => !Object.prototype.hasOwnProperty.call(params, key))) return result;
  if (operation === 'search' && (typeof params.query !== 'string' || Array.from(params.query).length > 80 || params.query.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(params.query))) return result;
  if (['detail', 'episodes', 'download_first_episode', 'download_episode', 'engagement'].includes(operation) && (!appId(params.srcAppId) || !dramaId(params.dramaId))) return result;
  if (operation === 'episodes' && (!Number.isSafeInteger(params.start) || params.start < 1 || !Number.isSafeInteger(params.count) || params.count < 1 || params.count > 20 || !Number.isSafeInteger(params.start + params.count))) return result;

  if ((operation === 'download_episode' || operation === 'engagement') && (!Number.isSafeInteger(params.episodeNo) || params.episodeNo < 1)) return result;
  if (operation === 'rankings' && (!Number.isInteger(params.boardType) || params.boardType < 1 || params.boardType > 2147483647 || !Number.isInteger(params.pageIndex) || params.pageIndex < 0 || params.pageIndex > 10000 || !Number.isInteger(params.count) || params.count < 1 || params.count > 20 || !Number.isInteger(params.coldStartTime) || params.coldStartTime < 1 || params.coldStartTime > 2147483647)) return result;

  if (operation === 'status') Object.assign(out, {hasRequire: false, hasBizRequest: false, hasNativeWrapper: false});
  if (operation === 'search') Object.assign(out, {resultCount: 0, partial: false, candidates: []});
  if (operation === 'rankings') Object.assign(out, {boardType: params.boardType, pageIndex: params.pageIndex, pageSize: params.count, coldStartTime: params.coldStartTime, total: null, hasMore: false, partial: false, boards: [], entries: []});
  if (['detail', 'episodes', 'download_first_episode', 'download_episode'].includes(operation)) Object.assign(out, {srcAppId: params.srcAppId, dramaId: params.dramaId, title: null, episodeCount: null, isFirstMediaFree: false, hasVideoInfo: false, hasPlayAuthorization: false});
  if (operation === 'episodes') Object.assign(out, {requestedStart: params.start, requestedEndExclusive: null, episodeNumbers: [], partial: false});
  if (operation === 'download_first_episode' || operation === 'download_episode') Object.assign(out, {serialNo: null, isStraight: false, hasPrivateMedia: false});
  if (operation === 'engagement') Object.assign(out, {srcAppId: params.srcAppId, dramaId: params.dramaId, episodeNo: params.episodeNo, observedAtMs: null, counts: {likes: null, comments: null, recommendations: null, shares: null}});
  out.status = 'identity-unavailable';

  try {
    if (typeof wx === 'undefined' || typeof wx.getAccountInfoSync !== 'function') return result;
    const identity = wx.getAccountInfoSync().miniProgram;
    if (!identity || identity.appId !== targetAppId) return result;
    out.identityMatched = true;
    out.appVersion = text(identity.version, 64);
    out.envVersion = ['release', 'trial', 'develop'].includes(identity.envVersion) ? identity.envVersion : null;
    if (operation === 'status') out.hasRequire = typeof require === 'function';
    if (typeof require !== 'function' || typeof requirePlugin !== 'function') { out.status = 'loader-unavailable'; return result; }
    const plugin = requirePlugin('playlet-plugin');
    if (!plugin || typeof plugin.getPluginVersion !== 'function') { out.status = 'plugin-version-unavailable'; return result; }
    const version = plugin.getPluginVersion();
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version) || version.length > 32) { out.status = 'plugin-version-invalid'; return result; }
    out.pluginVersion = version;
    const host = require('utils/index.js');
    const biz = require('utils/biz-request.js');
    const native = require('utils/operate-wx-data.js');
    const hasBiz = !!biz && typeof biz.bizRequest === 'function' && typeof biz.getIsLoggedIn === 'function';
    const hasNative = !!native && typeof native.default === 'function';
    if (operation === 'status') { out.hasBizRequest = hasBiz; out.hasNativeWrapper = hasNative; }
    if (!host || host.APP_ID !== targetAppId || !hasBiz || !hasNative) { out.status = 'native-wrapper-unavailable'; return result; }
    const login = biz.getIsLoggedIn();
    if (typeof login !== 'boolean') { out.status = 'login-state-unavailable'; return result; }
    out.hostLoginState = login;
    const base = host.AppBaseInfo;
    const device = host.DeviceInfo;
    if (!isObject(base) || !isObject(device)) { out.status = 'runtime-info-unavailable'; return result; }
    if (operation === 'status') { out.status = 'status-returned'; return result; }

    async function bounded(invoke) {
      let timer;
      phase = 'before-call';
      try {
        if (wx.getAccountInfoSync().miniProgram.appId !== targetAppId) { out.identityMatched = false; throw new Error('identity-changed'); }
        out.businessCalls += 1;
        phase = 'call-pending';
        const response = await Promise.race([
          invoke(),
          new Promise((_, reject) => { timer = setTimeout(() => { out.timedOut = true; reject(new Error('bounded-timeout')); }, 15000); }),
        ]);
        phase = 'response-received';
        return response;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    function businessOk(value) {
      return isObject(value) && (!isObject(value.base_resp) || value.base_resp.ret === undefined || value.base_resp.ret === 0);
    }
    if (operation === 'search') {
      const response = await bounded(() => biz.bizRequest('search', {query: params.query, source: 6}));
      if (!businessOk(response)) { out.status = 'business-error'; return result; }
      if (!Array.isArray(response.list)) { out.status = 'search-list-unavailable'; return result; }
      phase = 'projection';
      out.resultCount = response.list.length;
      for (const item of response.list.slice(0, 50)) {
        if (!isObject(item)) continue;
        const title = text(item.drama_name, 160);
        const origin = typeof item.origin_dramaid === 'string' ? item.origin_dramaid : Number.isSafeInteger(item.origin_dramaid) && item.origin_dramaid >= 0 ? String(item.origin_dramaid) : null;
        if (title === null || !appId(item.src_appid) || !dramaId(origin)) continue;
        out.candidates.push({title, srcAppId: item.src_appid, originDramaId: origin});
      }
      out.partial = out.candidates.length !== response.list.length;
      out.status = 'search-returned';
      return result;
    }

    if (operation === 'rankings') {
      const response = await bounded(() => biz.bizRequest('getpopularlist', {source: 4, page_index: params.pageIndex, page_size: params.count, popular_type: params.boardType, cold_start_time: params.coldStartTime, busi_version: 1}));
      if (!businessOk(response)) { out.status = 'business-error'; return result; }
      if (!Array.isArray(response.list) || !Array.isArray(response.label_list) || !Number.isSafeInteger(response.total) || response.total < 0 || response.list.length > params.count) { out.status = 'rankings-list-unavailable'; return result; }
      phase = 'projection';
      out.total = response.total;
      const types = new Set();
      for (const label of response.label_list.slice(0, 50)) {
        const name = isObject(label) ? text(label.name, 160) : null;
        if (name === null || !Number.isInteger(label.type) || label.type < 1 || label.type > 2147483647 || types.has(label.type)) { out.partial = true; continue; }
        types.add(label.type); out.boards.push({type: label.type, name});
      }
      if (response.label_list.length > 50) out.partial = true;
      for (const [index, item] of response.list.entries()) {
        const title = isObject(item) ? text(item.drama_name, 160) : null;
        const sourceId = isObject(item) ? item.origin_dramaid ?? item.drama_id : null;
        const origin = typeof sourceId === 'string' ? sourceId : Number.isSafeInteger(sourceId) && sourceId >= 0 ? String(sourceId) : null;
        if (title === null || !appId(item.src_appid) || !dramaId(origin)) { out.partial = true; continue; }
        out.entries.push({rank: params.pageIndex * params.count + index + 1, title, srcAppId: item.src_appid, originDramaId: origin});
      }
      out.hasMore = (params.pageIndex + 1) * params.count < out.total;
      if (out.hasMore && response.list.length < params.count) out.partial = true;
      out.status = 'rankings-returned';
      return result;
    }
    const common = {appid: host.APP_ID, f: 'json', plugin_version: version, plugin_code_version: version, public_lib_version: base.SDKVersion || '', publib_lib_version: base.SDKVersion || '', client_version: base.version || '', client_system: device.system || '', client_platform: device.platform || '', benchmark_level: device.benchmarkLevel || -99, is_logged_in: login};
    const selection = {src_appid: params.srcAppId, drama_id: params.dramaId};
    async function request(action, extra, post = false) {
      phase = 'before-call';
      const data = {...common, action, ...extra};
      const reqData = post
        ? {query_string: 'action=' + encodeURIComponent(action) + '&direct_result=true', post_data: JSON.stringify(data)}
        : {query_string: Object.keys(data).map(key => encodeURIComponent(key) + '=' + encodeURIComponent(data[key])).join('&'), post_data: '{}'};
      return bounded(() => native.default(reqData, 'webapi_wxadramaplayer'));
    }
    if (operation === 'engagement') {
      const meta = await request('usergetdramameta', {...selection, media_no: params.episodeNo});
      if (!businessOk(meta)) { out.status = 'business-error'; return result; }
      phase = 'projection';
      const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
      out.counts = {likes: count(meta.like_sum), comments: count(meta.comment_sum), recommendations: count(meta.public_like_cur_media_amount), shares: count(meta.share_sum)};
      out.observedAtMs = Date.now();
      out.status = Object.values(out.counts).some(value => value !== null) ? 'engagement-returned' : 'engagement-unavailable';
      return result;
    }
    const detail = await request('getdramainfo', {...selection, platform: (device.platform === 'android' || device.platform === 'devtools') ? 'android' : device.platform, sdk_version: base.SDKVersion || '', media_no: operation === 'download_episode' ? params.episodeNo : 1, scene: typeof wx.getEnterOptionsSync === 'function' ? wx.getEnterOptionsSync().scene || 0 : 0, force_jump_flag: 0, mp_auto_ad: 0});
    if (!businessOk(detail)) { out.status = 'business-error'; return result; }
    const info = detail.drama_info;
    if (!isObject(info) || !Number.isSafeInteger(info.media_count) || info.media_count < 1) { out.status = 'drama-info-unavailable'; return result; }
    phase = 'projection';
    out.title = text(info.drama_name, 160);
    out.episodeCount = info.media_count;
    out.isFirstMediaFree = detail.is_first_media_free === true || detail.is_first_media_free === 1;
    out.hasVideoInfo = !!detail.video_info;
    out.hasPlayAuthorization = detail.play_authorize !== undefined;
    if (operation === 'detail') { out.status = 'detail-returned'; return result; }
    if (operation === 'episodes') {
      if (params.start > out.episodeCount) { out.status = 'episode-range-outside-detail'; return result; }
      const count = Math.min(params.count, out.episodeCount - params.start + 1);
      out.requestedEndExclusive = params.start + count;
      const response = await request('getdramamedialist', {...selection, start_no: params.start, end_no: out.requestedEndExclusive});
      if (!businessOk(response)) { out.status = 'business-error'; return result; }
      if (!Array.isArray(response.list)) { out.status = 'episode-list-unavailable'; return result; }
      phase = 'projection';
      let discarded = 0;
      for (const item of response.list) {
        const number = isObject(item) ? item.media_no : null;
        if (!Number.isSafeInteger(number) || number < params.start || number >= out.requestedEndExclusive || out.episodeNumbers.includes(number)) { discarded += 1; continue; }
        out.episodeNumbers.push(number);
      }
      out.episodeNumbers.sort((left, right) => left - right);
      out.partial = discarded > 0 || out.episodeNumbers.length !== count || count !== params.count;
      out.status = 'episodes-returned';
      return result;
    }
    const serialNo = operation === 'download_episode' ? params.episodeNo : 1;
    if (serialNo > out.episodeCount) { out.status = 'episode-range-outside-detail'; return result; }
    if (operation === 'download_first_episode' && !out.isFirstMediaFree) { out.status = 'first-episode-free-unconfirmed'; return result; }
    const response = await request('postcgiforward_directgetplayurl', {...selection, benchmark_level: device.benchmarkLevel, platform: device.platform, sdk_version: base.SDKVersion || '', start_serial_no: serialNo, end_serial_no: serialNo, need_straight: true}, true);
    if (!businessOk(response) || typeof response.data !== 'string') { out.status = 'playable-response-invalid'; return result; }
    let body;
    try { body = JSON.parse(response.data); } catch (error) { out.status = 'playable-response-invalid'; return result; }
    if (!isObject(body) || !Array.isArray(body.serial_play_list)) { out.status = 'playable-list-unavailable'; return result; }
    phase = 'projection';
    const matches = body.serial_play_list.filter(item => isObject(item) && item.serial_no === serialNo);
    if (matches.length !== 1) { out.status = 'playable-episode-unconfirmed'; return result; }
    const media = matches[0];
    out.serialNo = serialNo;
    out.isStraight = media.is_straight === true || media.is_straight === 1;
    if (!out.isStraight) { out.status = 'straight-playback-unconfirmed'; return result; }
    if (typeof media.play_url !== 'string' || !media.play_url.startsWith('https://') || media.play_url.length > 8192 || /[\u0000-\u0020\u007f]/.test(media.play_url)) { out.status = 'playable-url-unavailable'; return result; }
    const binding = {hostAppId: targetAppId, srcAppId: params.srcAppId, dramaId: params.dramaId, serialNo, isStraight: true};
    if (operation === 'download_first_episode') binding.isFirstMediaFree = true;
    else binding.playAuthorization = 'native-straight-playback';
    result.privateResult = {mediaUrl: media.play_url, binding};
    out.hasPrivateMedia = true;
    out.status = operation === 'download_episode' ? 'episode-address-returned' : 'first-episode-address-returned';
    return result;
  } catch (error) {
    out.status = out.timedOut ? 'native-call-timeout' : 'native-call-failed';
    out.failurePhase = phase;
    out.failureKind = failureKind(error);
    out.nativeErrorCode = nativeErrorCode(error);
    result.privateResult = null;
    return result;
  }
})()
