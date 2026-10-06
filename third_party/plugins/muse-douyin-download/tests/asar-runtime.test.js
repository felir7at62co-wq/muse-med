/** External Python argv must refer to the unpacked native payload. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('archived plugin passes the unpacked script to external Python', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-douyin-asar-')));
  try {
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
    const runner = join(root, 'app.asar', 'node_modules', 'muse-douyin-download', 'src', 'runner.js');
    const script = join(root, 'app.asar.unpacked', 'node_modules', 'muse-douyin-download', 'python', 'scripts', 'download.py');
    await mkdir(dirname(runner), { recursive: true });
    await mkdir(dirname(script), { recursive: true });
    await copyFile(new URL('../src/runner.js', import.meta.url), runner);
    await writeFile(script, 'print("native script")\n');
    const plugin = await import(pathToFileURL(runner).href);
    const config = plugin.resolveConfig({ pythonExecutable: 'python', ffprobeExecutable: 'probe', ffmpegExecutable: 'decoder', settingsHome: null });
    const argv = plugin.downloadCommand(config, { url: 'https://v.douyin.com/example/', publicOnly: true }, root);
    assert.equal(argv[3], script);
    assert.equal(await readFile(argv[3], 'utf8'), 'print("native script")\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
