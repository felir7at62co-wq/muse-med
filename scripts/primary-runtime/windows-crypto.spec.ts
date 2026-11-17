/** The pinned loader retains its license and native files while accepting Windows extended paths. */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Papa from 'papaparse'
import { expect, it } from 'vitest'
import fixture from './fixtures/pycryptodome-3.23.0-file-system.json' with { type: 'json' }
import { patchPrimaryRuntimeWindowsCrypto } from './windows-crypto.ts'

const source = Buffer.from(fixture.contentBase64, 'base64')
const loaderPath = 'Crypto/Util/_file_system.py'
const digest = (bytes: Buffer): string => `sha256=${createHash('sha256').update(bytes).digest('base64url')}`
const loaderRow = [loaderPath, digest(source), String(source.length)]
const nativeRow = ['Crypto/Util/_cpuid_c.pyd', digest(Buffer.from('native fixture')), '14']
const recordPath = 'pycryptodome-3.23.0.dist-info/RECORD'

async function withWheel(record: string, check: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'primary-crypto-'))
  try {
    await mkdir(join(root, 'Crypto/Util'), { recursive: true })
    await mkdir(join(root, 'pycryptodome-3.23.0.dist-info'))
    await writeFile(join(root, loaderPath), source)
    await writeFile(join(root, nativeRow[0]!), 'native fixture')
    await writeFile(join(root, recordPath), record)
    await check(root)
  } finally { await rm(root, { recursive: true, force: true }) }
}

it('normalizes only the library lookup and updates the installed source record', async () => {
  const record = Papa.unparse([loaderRow, nativeRow, [recordPath, '', '']], { newline: '\n' })
  await withWheel(record, async (root) => {
    expect(createHash('sha256').update(source).digest('hex')).toBe(fixture.sha256)
    patchPrimaryRuntimeWindowsCrypto(root)
    const patched = await readFile(join(root, loaderPath))
    expect(patched.toString()).toBe(source.toString().replace(
      'return os.path.join(root_lib, *dir_comps)', 'return os.path.normpath(os.path.join(root_lib, *dir_comps))',
    ))
    expect(await readFile(join(root, nativeRow[0]!), 'utf8')).toBe('native fixture')
    const rows = Papa.parse<string[]>(await readFile(join(root, recordPath), 'utf8'), { skipEmptyLines: true }).data
    expect(rows).toEqual([[loaderPath, digest(patched), String(patched.length)], nativeRow, [recordPath, '', '']])
    const originalPath = join(root, 'upstream.py')
    await writeFile(originalPath, source)
    const output = execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-B', '-c', `
import ntpath, sys, types
from pathlib import Path
for location in [r'C:\\Muse\\Python', r'\\\\?\\C:\\Muse\\Python', r'\\\\?\\UNC\\host\\share' + '\\\\long-directory' * 25]:
    path = ntpath.join(location, 'Lib', 'site-packages', 'Crypto', 'Util', '_file_system.py')
    outputs = []
    for source_path in sys.argv[1:]:
        module = {'__file__': path}
        exec(compile(Path(source_path).read_bytes(), source_path, 'exec'), module)
        module['os'] = types.SimpleNamespace(path=ntpath)
        outputs.append(module['pycryptodome_filename'](['Crypto', 'Util'], '_cpuid_c.pyd'))
    assert '..' in outputs[0].split('\\\\'), outputs
    assert '..' not in outputs[1].split('\\\\'), outputs
    assert outputs[1] == ntpath.normpath(outputs[0]), outputs
print('normalized upstream loader')
`, originalPath, join(root, loaderPath)], {
      encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name))),
    })
    expect(output.trim()).toBe('normalized upstream loader')
  })
})

it('rejects changed upstream source before rewriting its source or record', async () => {
  await withWheel(Papa.unparse([loaderRow]), async (root) => {
    const altered = Buffer.concat([source, Buffer.from('# changed\n')])
    await writeFile(join(root, loaderPath), altered)
    const record = await readFile(join(root, recordPath))
    expect(() => { patchPrimaryRuntimeWindowsCrypto(root) }).toThrow('unexpected Windows PyCryptodome path loader')
    expect(await readFile(join(root, loaderPath))).toEqual(altered)
    expect(await readFile(join(root, recordPath))).toEqual(record)
  })
})

it.each(['', '"unterminated,,\n', 'file,hash\n', ',,\n'])(
  'rejects malformed RECORD %j without patching the loader', async (record) => {
    await withWheel(record, async (root) => {
      expect(() => { patchPrimaryRuntimeWindowsCrypto(root) }).toThrow('invalid Windows PyCryptodome wheel record')
      expect(await readFile(join(root, loaderPath))).toEqual(source)
      expect(await readFile(join(root, recordPath), 'utf8')).toBe(record)
    })
  },
)

it.each([
  { rows: [] }, { rows: [nativeRow] }, { rows: [loaderRow, loaderRow] },
  { rows: [[loaderPath, 'sha256=wrong', String(source.length)]] },
  { rows: [[loaderPath, digest(source), '0']] },
])('rejects missing, duplicate or changed loader records: $rows', async ({ rows }) => {
  const record = Papa.unparse([...rows, [recordPath, '', '']])
  await withWheel(record, async (root) => {
    expect(() => { patchPrimaryRuntimeWindowsCrypto(root) }).toThrow('unexpected Windows PyCryptodome loader record')
    expect(await readFile(join(root, loaderPath))).toEqual(source)
    expect(await readFile(join(root, recordPath), 'utf8')).toBe(record)
  })
})
