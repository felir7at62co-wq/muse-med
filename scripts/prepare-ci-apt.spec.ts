import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import * as yaml from 'js-yaml'
import { expect, it, onTestFinished } from 'vitest'
import { prepareCiApt, upgradeUbuntuMirrorUrls } from './prepare-ci-apt.mjs'

async function aptRoot(): Promise<string> {
  const parent = await realpath(tmpdir()), directory = await mkdtemp(join(parent, 'dsh-ci-apt-'))
  expect(dirname(directory)).toBe(parent)
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  return directory
}

it('upgrades official Ubuntu URL tokens while retaining signatures, third-party URLs, BOM and CRLF', () => {
  const before = '\uFEFFhttp://azure.archive.ubuntu.com/ubuntu/ priority:1\r\n'
    + 'deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] http://us.archive.ubuntu.com/ubuntu noble main\r\n'
    + 'URIs:http://security.ubuntu.com/ubuntu\r\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\r\n'
    + 'deb https://archive.ubuntu.com/ubuntu noble main\r\n'
    + 'deb http://packages.microsoft.com/ubuntu/24.04/prod noble main\r\n'
    + 'http://archive.ubuntu.com.example.test/ubuntu\r\nhttp://example.test/?url=http://archive.ubuntu.com/ubuntu\r\n'
  expect(upgradeUbuntuMirrorUrls(before)).toBe(before
    .replace('http://azure.archive.ubuntu.com/', 'https://azure.archive.ubuntu.com/')
    .replace('http://us.archive.ubuntu.com/', 'https://us.archive.ubuntu.com/')
    .replace('http://security.ubuntu.com/', 'https://security.ubuntu.com/'))
})

it('updates the real primary, security and Blacksmith mirror files reached by mirror+file sources', async () => {
  const directory = await aptRoot()
  await mkdir(join(directory, 'sources.list.d'))
  const deb822 = 'Types: deb\r\nURIs: mirror+file:/etc/apt/apt-mirrors.txt mirror+file:/etc/apt/apt-mirrors-security.txt\r\n'
    + 'Suites: noble noble-security\r\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\r\n'
  await writeFile(join(directory, 'sources.list.d', 'ubuntu.sources'), deb822)
  const files = ['apt-mirrors.txt', 'apt-mirrors-security.txt', 'blacksmith-ubuntu-mirrors.txt']
  const body = '\uFEFFhttp://azure.archive.ubuntu.com/ubuntu/ priority:1\r\nhttps://archive.ubuntu.com/ubuntu/ priority:2\r\n'
  for (const name of files) await writeFile(join(directory, name), body)
  await writeFile(join(directory, 'sources.list'), 'deb http://archive.ubuntu.com/ubuntu noble main\n')
  const changed = await prepareCiApt(directory)
  expect(changed.sort()).toEqual([...files, 'sources.list'].map(name => join(directory, name)).sort())
  for (const name of files) expect(await readFile(join(directory, name))).toEqual(Buffer.from(body.replace('http://azure.', 'https://azure.'), 'utf8'))
  expect(await readFile(join(directory, 'sources.list.d', 'ubuntu.sources'), 'utf8')).toBe(deb822)
  expect(await readFile(join(directory, 'sources.list'), 'utf8')).toBe('deb https://archive.ubuntu.com/ubuntu noble main\n')
})

it('leaves HTTPS and third-party files unwritten and is idempotent after preparation', async () => {
  const directory = await aptRoot()
  await mkdir(join(directory, 'sources.list.d'))
  const untouched = join(directory, 'sources.list.d', 'vendor.list')
  const source = 'deb https://archive.ubuntu.com/ubuntu noble main\ndeb http://packages.microsoft.com/prod noble main\n'
  await writeFile(untouched, source)
  const info = await stat(untouched, { bigint: true })
  await writeFile(join(directory, 'apt-mirrors.txt'), 'http://security.ubuntu.com/ubuntu\n')
  await writeFile(join(directory, 'unrelated.txt'), 'http://archive.ubuntu.com/ubuntu\n')
  expect(await prepareCiApt(directory)).toEqual([join(directory, 'apt-mirrors.txt')])
  const changedInfo = await stat(join(directory, 'apt-mirrors.txt'), { bigint: true })
  expect(await prepareCiApt(directory)).toEqual([])
  expect((await stat(join(directory, 'apt-mirrors.txt'), { bigint: true })).mtimeNs).toBe(changedInfo.mtimeNs)
  expect((await stat(untouched, { bigint: true })).mtimeNs).toBe(info.mtimeNs)
  expect(await readFile(untouched, 'utf8')).toBe(source)
  expect(await readFile(join(directory, 'unrelated.txt'), 'utf8')).toBe('http://archive.ubuntu.com/ubuntu\n')
})

it('updates list and Deb822 sources while preserving their remaining bytes', async () => {
  const directory = await aptRoot()
  await mkdir(join(directory, 'sources.list.d'))
  const list = '\uFEFFdeb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] http://archive.ubuntu.com/ubuntu noble main\r\n'
  const deb822 = '\uFEFFTypes: deb\r\nURIs: http://azure.archive.ubuntu.com/ubuntu\r\nSuites: noble\r\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\r\n'
  const files = [['legacy.list', list], ['ubuntu.sources', deb822]] as const
  for (const [name, body] of files) await writeFile(join(directory, 'sources.list.d', name), body)
  expect(await prepareCiApt(directory)).toEqual(files.map(([name]) => join(directory, 'sources.list.d', name)))
  for (const [name, body] of files) expect(await readFile(join(directory, 'sources.list.d', name))).toEqual(Buffer.from(body.replace('http://', 'https://'), 'utf8'))
})

it('supports a legacy APT tree without sources.list.d and rejects unreadable input', async () => {
  const directory = await aptRoot()
  await writeFile(join(directory, 'sources.list'), 'deb http://archive.ubuntu.com/ubuntu noble main\n')
  expect(await prepareCiApt(directory)).toEqual([join(directory, 'sources.list')])
  await expect(prepareCiApt(join(directory, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
})

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

it.each(['ci.yml', 'node-addon-system.yml'])('prepares every APT dependency step in %s before installation with a bounded deadline', (name) => {
  const workflow: unknown = yaml.load(readFileSync(resolve(import.meta.dirname, '../.github/workflows', name), 'utf8'))
  if (!record(workflow) || !record(workflow.jobs)) throw Error('Workflow jobs are required')
  let count = 0
  for (const job of Object.values(workflow.jobs)) {
    if (!record(job) || !Array.isArray(job.steps)) continue
    for (const step of job.steps.filter(record)) {
      if (typeof step.run !== 'string' || !/apt-get|playwright install --with-deps/u.test(step.run)) continue
      count++
      const preparation = 'sudo -- "$(command -v node)" "${GITHUB_WORKSPACE}/scripts/prepare-ci-apt.mjs"'
      expect(step.run).toContain(preparation)
      expect(step.run.indexOf(preparation)).toBeLessThan(step.run.search(/apt-get|playwright install --with-deps/u))
      expect(step['timeout-minutes']).toBe(step.run.includes('playwright install') ? 15 : 10)
    }
  }
  expect(count).toBe(name === 'ci.yml' ? 4 : 1)
})
