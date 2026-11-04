/** Sanitized native receipt evidence retains identification facts, never transient media addresses or credentials. */
const invalid = () => { throw Object.assign(new Error('Native evidence is not the supported credential-free receipt data'), { code: 'DOUYIN_RECEIPT_INVALID' }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const dimension = value => Number.isInteger(value) && value > 0 && value <= 16384;
const duration = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 86400000;
/** Persisted result fields exposed by the existing public/native downloader. */
export const receiptFields = ['status', 'path', 'receipt', 'source', 'bytes', 'sha256', 'duration_seconds', 'width', 'height', 'full_decode_verified', 'authentication', 'taskId', 'targetVideoId', 'retrieved_at', 'evidence'];

/** @param value JSON-compatible validated receipt fields. @returns JSON with sorted object keys for field-by-field equality independent of serialization order. */
export function stableReceipt(value) {
  if (Array.isArray(value)) return `[${value.map(stableReceipt).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableReceipt(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** @param value Host-sanitized native evidence. @param target Selected video identity. @param maxBytes Configured evidence/receipt JSON byte cap. @returns An unchanged independent evidence copy after bounded public-field validation. */
export function nativeEvidence(value, target, maxBytes) {
  if (!keys(value, ['responseStatus', 'mediaHost', 'mediaUrlHash', 'association', 'currentSrcMatched', 'provider', 'playerMetadata']) || ![200, 206].includes(value.responseStatus) || typeof value.mediaHost !== 'string' || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:douyinvod\.com|bytecdn\.(?:com|cn))$/.test(value.mediaHost) || !/^[a-f0-9]{64}$/.test(value.mediaUrlHash ?? '')) invalid();
  if (value.association === 'player-exact') {
    if (value.currentSrcMatched !== true || value.provider !== undefined || value.playerMetadata !== undefined) invalid();
  } else if (value.association === 'provider-detail-verified') {
    const p = value.provider;
    if (value.currentSrcMatched !== false || value.playerMetadata !== undefined || !keys(p, ['detailResponseStatus', 'detailHost', 'detailPath', 'targetVideoId', 'documentEpoch', 'sourceField', 'durationMs', 'width', 'height']) || p.detailResponseStatus !== 200 || p.detailHost !== 'www.douyin.com' || p.detailPath !== '/aweme/v1/web/aweme/detail/' || p.targetVideoId !== target || p.documentEpoch !== 1 || !['video.play_addr', 'video.bit_rate.play_addr'].includes(p.sourceField) || !duration(p.durationMs) || !dimension(p.width) || !dimension(p.height)) invalid();
  } else if (value.association === 'player-metadata-verified') {
    const p = value.playerMetadata;
    if (value.currentSrcMatched !== false || value.provider !== undefined || !keys(p, ['source', 'targetVideoId', 'documentEpoch', 'sourceField', 'durationMs', 'width', 'height']) || p.source !== 'player-parent-awemeInfo' || p.targetVideoId !== target || p.documentEpoch !== 1 || !['video.playAddr', 'video.playAddrH265', 'video.bitRateList.playAddr'].includes(p.sourceField) || !duration(p.durationMs) || !dimension(p.width) || !dimension(p.height)) invalid();
  } else invalid();
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) invalid();
  return structuredClone(value);
}
