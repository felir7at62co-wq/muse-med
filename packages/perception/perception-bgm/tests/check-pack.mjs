/** Validate the real `npm pack --dry-run --json` file list supplied on stdin. */
import assert from 'node:assert/strict'
let input = ''
for await (const chunk of process.stdin) input += chunk
const [pack] = JSON.parse(input.replace(/^\uFEFF/, ''))
const files = new Set(pack.files.map(file => file.path))
for (const path of [
  'lib/index.js', 'lib/worker.js', 'lib/config.js',
  'lib/types/index.d.ts', 'lib/types/worker.d.ts', 'lib/types/config.d.ts',
  'cordis.patch.yml', 'python/worker_main.py', 'python/emo_pipeline.py',
  'python/vendored/mert.py', 'python/vendored/btc_model.py',
  'python/vendored/model_linear_mt_attn_ck.py', 'python/data/tag_list.npy',
  'python/data/run_config.yaml', 'python/data/chord_root.json',
  'python/data/chord_attr.json', 'python/LICENSE-Music2Emo', 'SOURCES.md',
]) assert.ok(files.has(path), `Package is missing ${path}`)
for (const path of files) assert.doesNotMatch(path,
  /(?:node_modules|__pycache__|\.scratch|\.venv|\.pyc$|\.pt$|\.ckpt$|\.safetensors$)/)
console.log(`Verified ${files.size} packed files; required runtime resources present, no weights/caches`)
