import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32]] as const) blocked.addSubnet(network, prefix, 'ipv6');
const coverDomains = ['byteimg.com', 'fqnovelpic.com', 'qimao.com', 'qmnovel.com', 'qtcdn.com', 'douyinpic.com', 'douyinstatic.com', 'qpic.cn'];

/** Covers are only downloaded from known source CDNs; callers provide a stored work ID. */
export function validateCoverUrl(raw: string): URL {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || !coverDomains.some(domain => host === domain || host.endsWith(`.${domain}`))) throw new Error('Unsupported cover source');
  return url;
}

/** Rejects loopback, private, link-local and reserved destination addresses. */
export function isPublicCoverAddress(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export interface CoverImage { body: Uint8Array; contentType: string; }

function imageType(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (Buffer.from(bytes.subarray(0, 6)).toString() === 'GIF89a' || Buffer.from(bytes.subarray(0, 6)).toString() === 'GIF87a') return 'image/gif';
  if (Buffer.from(bytes.subarray(0, 4)).toString() === 'RIFF' && Buffer.from(bytes.subarray(8, 12)).toString() === 'WEBP') return 'image/webp';
  return null;
}

/** Fetches a bounded image over verified TLS, pinning the public address selected by DNS. */
export async function downloadCover(raw: string, redirects = 0): Promise<CoverImage> {
  const url = validateCoverUrl(raw);
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(entry => !isPublicCoverAddress(entry.address))) throw new Error('Cover source resolved to a restricted address');
  const address = addresses.find(entry => entry.family === 4) ?? addresses[0]!;
  const limit = 5 * 1024 * 1024;
  const response = await new Promise<CoverImage | URL>((resolve, reject) => {
    const req = request(url, {
      method: 'GET', family: address.family,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      headers: { Accept: 'image/avif,image/webp,image/*;q=0.8', 'User-Agent': 'MuseData/0.2 CoverPreview' },
      signal: AbortSignal.timeout(15_000),
    }, res => {
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (redirects >= 2) { reject(new Error('Too many cover redirects')); return; }
        try { resolve(validateCoverUrl(new URL(res.headers.location, url).href)); } catch (error) { reject(error); }
        return;
      }
      if (code !== 200 || !res.headers['content-type']?.toLowerCase().startsWith('image/') || Number(res.headers['content-length'] ?? 0) > limit) {
        res.resume(); reject(new Error('Cover source did not return an acceptable image')); return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > limit) { res.destroy(new Error('Cover image exceeds size limit')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        if (!res.complete) { reject(new Error('Incomplete cover response')); return; }
        const body = Buffer.concat(chunks);
        const contentType = imageType(body);
        if (!contentType) { reject(new Error('Unsupported cover image bytes')); return; }
        resolve({ body, contentType });
      });
    });
    req.on('error', reject);
    req.end();
  });
  return response instanceof URL ? downloadCover(response.href, redirects + 1) : response;
}

/** A bounded, same-origin thumbnail cache; unsuccessful images are never cached as successes. */
export class CoverCache {
  private readonly entries = new Map<string, { image: CoverImage; expires: number }>();
  private readonly pending = new Map<string, Promise<CoverImage>>();
  private bytes = 0;
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly fetchImage: (url: string) => Promise<CoverImage> = downloadCover, private readonly maxBytes = 32 * 1024 * 1024) {}

  async get(raw: string): Promise<CoverImage> {
    validateCoverUrl(raw);
    const cached = this.entries.get(raw);
    if (cached && cached.expires > Date.now()) {
      this.entries.delete(raw); this.entries.set(raw, cached);
      return cached.image;
    }
    const pending = this.pending.get(raw);
    if (pending) return pending;
    if (this.pending.size >= 256) throw new Error('Cover queue is full');
    const task = this.fetchBounded(raw).then(image => {
      if (image.body.byteLength > this.maxBytes) return image;
      const previous = this.entries.get(raw);
      if (previous) { this.bytes -= previous.image.body.byteLength; this.entries.delete(raw); }
      while (this.bytes + image.body.byteLength > this.maxBytes && this.entries.size) {
        const oldest = this.entries.keys().next().value!;
        this.bytes -= this.entries.get(oldest)!.image.body.byteLength; this.entries.delete(oldest);
      }
      this.entries.set(raw, { image, expires: Date.now() + 6 * 60 * 60 * 1000 });
      this.bytes += image.body.byteLength;
      return image;
    }).finally(() => { this.pending.delete(raw); });
    this.pending.set(raw, task);
    return task;
  }

  private async fetchBounded(raw: string): Promise<CoverImage> {
    if (this.active < 4) this.active++;
    else await new Promise<void>(resolve => { this.waiters.push(resolve); });
    try { return await this.fetchImage(raw); }
    finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}
