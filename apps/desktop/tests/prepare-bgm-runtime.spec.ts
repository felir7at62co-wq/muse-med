import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { inventory } from '../scripts/media-resources.ts'
import { pruneUpstreamBytecode, validateBgmRuntimeLock, verifyPreparedBgmRuntime } from '../scripts/prepare-bgm-runtime.ts'

const resource = { filename: 'python.tar.gz', url: 'https://example.com/python.tar.gz', bytes: 1, sha256: 'a'.repeat(64) }
const names = ['config.json', 'preprocessor_config.json', 'configuration_MERT.py', 'modeling_MERT.py',
  'pytorch_model.bin', 'J_all.ckpt', 'btc_model_large_voca.pt', 'README-MERT.md', 'LICENSE-CC-BY-NC-4.0.txt']
const lock = { version: 1, pythonVersion: '3.11.16', python: resource,
  mertRevision: '12af15fef9d0ac838c3f475bfbbf26d2060dd4f5', license: 'CC-BY-NC-4.0',
  models: names.map(filename => ({ ...resource, filename })),
  wheels: [{ ...resource, filename: 'torch-2.3.1+cpu-cp311-cp311-win_amd64.whl' }],
}

it('requires the explicit noncommercial license, complete pinned model inputs and Python 3.11', () => {
  expect(validateBgmRuntimeLock(lock)).toEqual(lock)
  for (const changed of [undefined, { ...lock, pythonVersion: '3.13.15' }, { ...lock, license: 'MIT' },
    { ...lock, mertRevision: 'main' }, { ...lock, models: lock.models.slice(1) },
    { ...lock, models: [...lock.models, lock.models[0]] }, { ...lock, wheels: [] }]) {
    expect(() => validateBgmRuntimeLock(changed)).toThrow(/bgm lock/)
  }
})

it('rejects changed or incomplete payloads without deleting their contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-bgm-inventory-'))
  const validated = validateBgmRuntimeLock(lock)
  try {
    await writeFile(join(root, 'keep.txt'), 'owned')
    await expect(verifyPreparedBgmRuntime(root, validated)).rejects.toThrow()
    expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('owned')
    await writeFile(join(root, 'resources.lock.json'), JSON.stringify(validated))
    await mkdir(join(root, 'models'))
    await writeFile(join(root, 'models', 'payload'), 'fixed')
    const files = await inventory(root)
    await writeFile(join(root, 'bgm-runtime.json'), JSON.stringify({ version: 1, files }))
    await expect(verifyPreparedBgmRuntime(root, validated)).resolves.toBeUndefined()
    await expect(verifyPreparedBgmRuntime(root, { ...validated, pythonVersion: '3.11.99' })).rejects.toThrow(/input lock/)
    await writeFile(join(root, 'models', 'payload'), 'other')
    await expect(verifyPreparedBgmRuntime(root, validated)).rejects.toThrow(/inventory/)
    expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('owned')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('drops bytecode a locked wheel ships while keeping the module source it belongs to', async () => {
  // numpy 1.26.4 ships numpy/distutils/__pycache__/conv_template.cpython-311.pyc
  // beside its source, so the payload carries source only and the bytecode
  // invariant stays meaningful.
  const root = await mkdtemp(join(tmpdir(), 'muse-bgm-bytecode-'))
  try {
    await mkdir(join(root, 'numpy/distutils/__pycache__'), { recursive: true })
    await writeFile(join(root, 'numpy/distutils/conv_template.py'), 'source')
    await writeFile(join(root, 'numpy/distutils/__pycache__/conv_template.cpython-311.pyc'), 'bytecode')
    await writeFile(join(root, 'numpy/distutils/legacy.pyc'), 'bytecode')
    await pruneUpstreamBytecode(root)
    expect(await inventory(root)).toEqual([
      { path: 'numpy/distutils/conv_template.py', bytes: 6, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    ])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects unsafe, unpinned or credential-bearing artifacts before downloading', () => {
  for (const changed of [{ filename: '../escape' }, { url: 'https://secret@example.com/file' },
    { sha256: 'unknown' }, { bytes: 0 }, { filename: 'NUL' }]) {
    expect(() => validateBgmRuntimeLock({ ...lock, python: { ...resource, ...changed } })).toThrow()
  }
})
