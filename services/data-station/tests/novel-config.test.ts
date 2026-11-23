import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/server/config.ts';

describe('independent original-novel runtime configuration', () => {
  it('keeps the runtime opt-in and places its default Python in the data station own directory', () => {
    const config = resolveConfig();
    expect(config.novelEnabled).toBe(false);
    expect(isAbsolute(config.novelPython)).toBe(true);
    expect(config.novelPython).toContain('/.data/novel-runtime/');
    expect(config.qimaoNovelRequestIntervalMs).toBe(1000);
    expect(config.novelFullMode).toBe(false);
    expect(config.novelMaxArchiveBytes).toBe(67_108_864);
    expect(resolveConfig({ MUSE_DATA_NOVEL_ENABLED: '1', MUSE_DATA_NOVEL_MAX_QUEUED: '3' }).novelMaxQueued).toBe(3);
    expect(resolveConfig({ MUSE_DATA_NOVEL_FULL_MODE: '1' }).novelFullMode).toBe(true);
  });
  it.each([
    { MUSE_DATA_NOVEL_PYTHON: 'relative/python3' },
    { MUSE_DATA_NOVEL_CA_FILE: 'relative/ca.pem' },
    { MUSE_DATA_NOVEL_ENABLED: 'yes' },
    { MUSE_DATA_NOVEL_MAX_FILE_BYTES: '20971521' },
    { MUSE_DATA_NOVEL_MAX_STORAGE_BYTES: '1073741825' },
    { MUSE_DATA_NOVEL_MAX_CHAPTERS: '20001' },
    { MUSE_DATA_NOVEL_MAX_QUEUED: '51' },
    { MUSE_DATA_NOVEL_NETWORK_MODE: 'disabled-tls' },
    { MUSE_DATA_NOVEL_GRACE_MS: '0' },
    { MUSE_DATA_QIMAO_NOVEL_REQUEST_INTERVAL_MS: '0' },
    { MUSE_DATA_QIMAO_NOVEL_ALLOW_LEGACY_HEADERS: 'yes' },
    { MUSE_DATA_NOVEL_FULL_MODE: 'yes' },
    { MUSE_DATA_NOVEL_MAX_ARCHIVE_BYTES: '1048575' },
    { MUSE_DATA_NOVEL_MAX_ARCHIVE_BYTES: '268435457' },
  ])('rejects unsupported runtimes or unbounded resource settings before startup: %j', values => {
    expect(() => resolveConfig(values)).toThrow();
  });
});
