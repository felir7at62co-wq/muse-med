import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { desktopDownloadEnvironment } from '../src/download-runtime.ts'

it('selects the validated bundled interpreter without changing media configuration or PATH', async () => {
  const source = await mkdtemp(join(tmpdir(), 'desktop-download-runtime-'))
  try {
    const python = join(source, 'dependencies', 'python', ...(process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3']))
    const packages = join(source, 'dependencies', 'python', ...(process.platform === 'win32' ? ['Lib'] : ['lib', 'python3.12']), 'site-packages')
    await mkdir(dirname(python), { recursive: true })
    await mkdir(packages, { recursive: true })
    await writeFile(python, '')
    await writeFile(join(source, 'runtime.json'), JSON.stringify({ desktopVersion: '0.2.1-alpha.1', platform: process.platform,
      arch: process.arch, python: '3.12.14', pythonPackages: {} }))
    const environment = { PATH: '/user/tools', MUSE_DOUYIN_PYTHON_PATH: '/user/python', DSH_FFMPEG_PATH: '/selected/ffmpeg' }
    expect(await desktopDownloadEnvironment(source, environment)).toEqual({
      ...environment, MUSE_DOUYIN_PYTHON_PATH: python, DSH_FFPROBE_PATH: undefined,
    })
    expect(environment.MUSE_DOUYIN_PYTHON_PATH).toBe('/user/python')
    await rm(python)
    await expect(desktopDownloadEnvironment(source, environment)).rejects.toThrow()
    await writeFile(python, '')
    await writeFile(join(source, 'runtime.json'), JSON.stringify({ desktopVersion: '0.2.1-alpha.1', platform: 'wrong-target',
      arch: process.arch, python: '3.12.14', pythonPackages: {} }))
    await expect(desktopDownloadEnvironment(source, environment)).rejects.toThrow('primary runtime: invalid metadata')
  } finally { await rm(source, { recursive: true, force: true }) }
})
