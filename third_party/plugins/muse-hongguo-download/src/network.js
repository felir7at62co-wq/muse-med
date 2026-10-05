/** HTTPS-only, public-address-pinned requests to official player and media hosts. */
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request } from 'node:https';
import { DownloadError } from './errors.js';

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) {
  blocked.addSubnet(address, prefix, 'ipv4');
}
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');

/** Refuse local, reserved, mapped and non-global addresses before connecting. */
export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

/** Host and media-port allowlists apply to the initial URL and every redirect; pages and APIs use port 443. */
export function checkedUrl(value, kind, allowedHosts, allowedPorts = [443]) {
  let url;
  try { url = new URL(value); } catch (error) { throw new DownloadError('unsafe_url', '播放器或媒体 HTTPS 地址无效'); }
  const allowed = allowedHosts ? allowedHosts.some(host => host.startsWith('*.')
    ? url.hostname.endsWith(host.slice(1)) && url.hostname !== host.slice(2) : url.hostname === host) : kind === 'page'
    ? ['hongguoduanju.com', 'www.hongguoduanju.com'].includes(url.hostname)
    : /^v\d+-hgweb\.qznovelvod\.com$/.test(url.hostname);
  const ports = kind === 'media' ? allowedPorts : [443];
  if (url.protocol !== 'https:' || url.username || url.password || !ports.includes(Number(url.port || 443)) || !allowed) {
    throw new DownloadError('unsafe_url', '拒绝未配置域名或端口、非 HTTPS 或含身份信息的地址');
  }
  return url;
}

function oneRequest(url, address, signal, options, kind) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const req = request(url, {
      signal, method: options.method ?? 'GET', headers: { 'user-agent': 'Mozilla/5.0 MuseHongguoDownload/0.1.0',
        accept: '*/*', 'accept-encoding': 'identity', ...(kind === 'page' ? { referer: 'https://hongguoduanju.com/' } : {}), ...options.headers },
      lookup(_hostname, options, callback) {
        callback(null, options.all ? [address] : address.address, address.family);
      },
    }, resolve);
    req.on('error', error => reject(signal.aborted ? signal.reason : new DownloadError('network', `HTTPS 请求失败（${error.code ?? 'network'}）`)));
    req.end(options.body);
  });
}

/** Return a streaming response after validating redirect targets and pinning DNS. */
export async function officialRequest(value, kind, signal, options = {}) {
  let url = checkedUrl(value, kind, options.allowedHosts, options.allowedPorts);
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    const addresses = await lookup(url.hostname, { all: true });
    signal.throwIfAborted();
    if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new DownloadError('unsafe_dns', '媒体 DNS 指向非公网地址');
    const response = await oneRequest(url, addresses.find(item => item.family === 4) ?? addresses[0], signal, options, kind);
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      response.destroy();
      if (redirects === 5 || !response.headers.location) throw new DownloadError('redirect', '媒体重定向过多或没有目标');
      if (options.method && options.method !== 'GET') throw new DownloadError('redirect', '平台 API 不允许重定向签名请求');
      let target;
      try { target = new URL(response.headers.location, url).href; } catch (error) { throw new DownloadError('redirect', '媒体重定向地址无效'); }
      try { url = checkedUrl(target, kind, options.allowedHosts, options.allowedPorts); }
      catch (error) {
        if (error instanceof DownloadError) throw new DownloadError('unsafe_redirect', '媒体重定向到未配置的 HTTPS 主机或端口，下载已拒绝');
        throw error;
      }
      continue;
    }
    return response;
  }
  throw new DownloadError('redirect', '媒体重定向过多');
}
