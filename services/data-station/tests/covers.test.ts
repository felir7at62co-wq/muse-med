import { describe, expect, it, vi } from 'vitest';
import { CoverCache, isPublicCoverAddress, validateCoverUrl } from '../src/server/covers.ts';

const url = 'https://p6-novel.byteimg.com/novel-pic/test.jpg';
const image = { body: new Uint8Array([255, 216, 255, 0]), contentType: 'image/jpeg' };

describe('source cover access', () => {
  it('only accepts HTTPS cover CDNs with no credentials or custom ports', () => {
    expect(validateCoverUrl(url).hostname).toBe('p6-novel.byteimg.com');
    expect(validateCoverUrl('https://cdn.qimao.com/book.jpg').hostname).toBe('cdn.qimao.com');
    for (const candidate of ['http://cdn.qimao.com/a', 'https://cdn.qimao.com:8443/a', 'https://x:secret@cdn.qimao.com/a', 'https://byteimg.com.attacker.example/a', 'https://127.0.0.1/a', 'file:///etc/passwd']) expect(() => validateCoverUrl(candidate)).toThrow();
  });

  it('refuses private, local, reserved and mapped local destination addresses', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.6', '169.254.169.254', '100.64.1.1', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', 'not-an-address']) expect(isPublicCoverAddress(address), address).toBe(false);
    expect(isPublicCoverAddress('8.8.8.8')).toBe(true);
    expect(isPublicCoverAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('deduplicates simultaneous downloads and reuses successful thumbnails', async () => {
    const transport = vi.fn(async () => image);
    const cache = new CoverCache(transport);
    expect(await Promise.all([cache.get(url), cache.get(url)])).toEqual([image, image]);
    expect(await cache.get(url)).toEqual(image);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('does not replace failures with successful cache entries', async () => {
    const transport = vi.fn().mockRejectedValueOnce(new Error('upstream offline')).mockResolvedValue(image);
    const cache = new CoverCache(transport);
    await expect(cache.get(url)).rejects.toThrow('upstream offline');
    expect(await cache.get(url)).toEqual(image);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('evicts old thumbnails at the configured memory limit', async () => {
    const transport = vi.fn(async () => image);
    const cache = new CoverCache(transport, image.body.byteLength);
    await cache.get(url);
    await cache.get('https://cdn.qimao.com/other.jpg');
    await cache.get(url);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('limits concurrent source downloads while preserving each image result', async () => {
    let active = 0;
    let peak = 0;
    const transport = async () => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return image;
    };
    const cache = new CoverCache(transport);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => cache.get(`${url}?image=${i}`)));
    expect(results).toHaveLength(10);
    expect(peak).toBe(4);
  });
});
