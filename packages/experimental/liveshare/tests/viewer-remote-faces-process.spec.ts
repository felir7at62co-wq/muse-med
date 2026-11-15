/** Source-only generator subprocess output and quiescent teardown. */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { startViewerRemoteFacesProcess } from './viewer-remote-faces-process.ts'
import type { ViewerRemoteFacesProcess } from './viewer-remote-faces-process.ts'

const WORKSPACE = fileURLToPath(new URL('../../../../', import.meta.url))
const roots: string[] = []
const processes: ViewerRemoteFacesProcess[] = []

afterEach(async () => {
  for (const process of processes.splice(0)) await process.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Allocate one private generator module and its output directory. */
function fixture(source: string, timeoutMs = 10_000): { readonly directory: string; readonly process: ViewerRemoteFacesProcess } {
  const directory = mkdtempSync(join(tmpdir(), 'viewer-source-generator-'))
  roots.push(directory)
  const moduleFile = join(directory, 'generator.mjs')
  writeFileSync(moduleFile, source)
  const process = startViewerRemoteFacesProcess({
    workspaceRoot: WORKSPACE,
    directory, timeoutMs, generatorModule: pathToFileURL(moduleFile).href,
  })
  processes.push(process)
  return { directory, process }
}

describe('viewer source generation process', () => {
  it('returns complete files using the current workspace source aliases', async () => {
    const { directory, process } = fixture(`
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      export function generateViewerRemoteFaces(root, directory) {
        const file = join(directory, '@fixture__remote.js');
        writeFileSync(file, JSON.stringify({ root, tsconfig: process.env.TSX_TSCONFIG_PATH }));
        return new Map([['@fixture/remote', file]]);
      }
    `)
    const files = await process.result
    expect([...files]).toEqual([['@fixture/remote', join(directory, '@fixture__remote.js')]])
    expect(JSON.parse(readFileSync(join(directory, '@fixture__remote.js'), 'utf8'))).toEqual({
      root: WORKSPACE,
      tsconfig: join(WORKSPACE, 'tsconfig.base.json'),
    })
  })

  it('reports nonzero exit independently from complete stdout and stderr', async () => {
    const { process } = fixture(`
      export function generateViewerRemoteFaces() {
        console.log('generator stdout');
        console.error('generator stderr');
        process.exitCode = 7;
        return new Map();
      }
    `)
    await expect(process.result).rejects.toThrow(/exited; code=7; signal=null;[\s\S]*generator stdout[\s\S]*generator stderr/u)
  })

  it('rejects a zero exit with truncated output', async () => {
    const { process } = fixture(`
      export function generateViewerRemoteFaces() {
        process.stdout.write('[["truncated"');
        process.exit(0);
      }
    `)
    await expect(process.result).rejects.toThrow(/code=0; signal=null;[\s\S]*incomplete generated output/u)
  })

  it('rejects a zero exit before all declared files exist', async () => {
    const { process } = fixture(`
      import { join } from 'node:path';
      export function generateViewerRemoteFaces(root, directory) {
        return new Map([['@fixture/remote', join(directory, '@fixture__remote.js')]]);
      }
    `)
    await expect(process.result).rejects.toThrow(/code=0; signal=null;[\s\S]*incomplete generated output:[\s\S]*ENOENT/u)
  })

  it('terminates and joins an unfinished child before disposal returns', async () => {
    const { directory, process: generation } = fixture(`
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      export function generateViewerRemoteFaces(root, directory) {
        writeFileSync(join(directory, 'ready'), String(process.pid));
        setInterval(() => {}, 1000);
        return new Map();
      }
    `)
    const rejected = expect(generation.result).rejects.toThrow(/viewer source generation: disposed;/u)
    const ready = join(directory, 'ready')
    await expect.poll(() => existsSync(ready)).toBe(true)
    const pid = Number(readFileSync(ready, 'utf8'))
    await generation.dispose()
    await rejected
    expect(() => process.kill(pid, 0)).toThrow()
    await generation.dispose()
  })

  it('reports its own deadline and awaits child closure', async () => {
    const { process } = fixture('export function generateViewerRemoteFaces() { while (true) {} }', 0)
    await expect(process.result).rejects.toThrow(/viewer source generation: deadline; code=[\s\S]*signal=/u)
    await process.dispose()
  })
})
