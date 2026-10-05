/** Exercise the original multi-series client with the real managed media subprocess provider. */
import { Context } from '@deepseek-ai/cordis';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import SubprocessLocal from '../../../../packages/subprocess/subprocess-local/src/index.ts';
import { HongguoDownloadClient } from '../src/client.js';
import { resolveConfig } from '../src/config.js';

const mode = process.env.MUSE_HONGGUO_LIVE_MODE || 'legacy';
const ids = (process.env.MUSE_HONGGUO_LIVE_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
if (!ids.length) throw new Error('Set MUSE_HONGGUO_LIVE_IDS to real source series ids');
const workspace = process.env.MUSE_HONGGUO_LIVE_OUTPUT ? resolve(process.env.MUSE_HONGGUO_LIVE_OUTPUT) : await mkdtemp(join(tmpdir(), 'muse-hongguo-live-'));
await mkdir(workspace, { recursive: true, mode: 0o700 });
const config = resolveConfig({ sourceMode: mode, legacyAppDir: process.env.MUSE_HONGGUO_LEGACY_APP_DIR || '',
  signServer: process.env.MUSE_HONGGUO_SIGN_SERVER || '', catalogPath: process.env.MUSE_HONGGUO_CATALOG_PATH || '', outputRoot: workspace,
  pythonExecutable: process.env.MUSE_HONGGUO_PYTHON_PATH || '',
  ffprobeExecutable: process.env.DSH_FFPROBE_PATH || process.env.FFPROBE_PATH || '',
  ffmpegExecutable: process.env.MUSE_HONGGUO_FFMPEG || process.env.DSH_FFMPEG_PATH || process.env.FFMPEG_PATH || '' });
const ctx = new Context();
let client;
try {
  await ctx.plugin(SubprocessLocal);
  client = new HongguoDownloadClient(config, { subprocess: ctx.subprocess });
  const info = await client.info({ seriesIds: ids });
  const download = info.ok ? await client.download({ seriesIds: ids, ...(mode === 'public' ? { episodes: [1] } : {}) }) : info;
  const fullSeriesSourceAcceptance = mode === 'legacy' && download.ok && download.complete && download.fullDecodeChecked;
  const evidence = { checkedAt: new Date().toISOString(), sourceMode: mode, fullSeriesSourceAcceptance,
    multiSeriesSourceAcceptance: fullSeriesSourceAcceptance && download.items.length > 1,
    limitation: mode === 'public' ? 'Official public episode only; this does not validate the original full-series source.'
      : mode === 'manifest' ? 'Authorized manifest only; this does not validate Hongguo platform full-series coverage.' : '', info, download };
  const path = join(workspace, 'live-evidence.json');
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ok: download.ok, complete: download.complete, fullSeriesSourceAcceptance,
    multiSeriesSourceAcceptance: evidence.multiSeriesSourceAcceptance, code: download.code ?? null, evidencePath: path, downloadPath: download.path ?? null }));
  if (!download.ok) process.exitCode = 1;
} finally {
  if (client) await client.dispose();
  await ctx.fiber.dispose();
}
