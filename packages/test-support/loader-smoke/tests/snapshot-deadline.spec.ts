/** Snapshot projects preserve defaults while forwarding explicit Vitest CLI budgets. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, loaderSmokeProcessTimeout } from '../src/deadline.ts'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const snapshotConfig = fileURLToPath(new URL('../../../../vitest.snapshot.config.ts', import.meta.url))
const vitestCli = fileURLToPath(new URL('../../../../node_modules/vitest/vitest.mjs', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/deadline-probe.fixture.ts', import.meta.url))

function probeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', DSH_SNAPSHOT: 'replay',
    DSH_SNAPSHOT_MAX_CONCURRENCY: '1', DSH_SNAPSHOT_MAX_WORKERS: '1' }
  for (const name of Object.keys(env)) {
    if (name.startsWith('VITEST') || name.startsWith('DSH_COVERAGE_') || name === 'GITHUB_ACTIONS') Reflect.deleteProperty(env, name)
  }
  return env
}

for (const override of [undefined, 90_000]) {
  it(`forwards the ${override === undefined ? 'default' : 'explicit'} snapshot project deadline through the real CLI`, async ({ task, signal }) => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-snapshot-deadline-'))
    try {
      const config = join(directory, 'vitest.config.ts')
      await writeFile(join(directory, 'package.json'), '{"type":"module"}\n')
      await writeFile(config, [
        `import base from ${JSON.stringify(snapshotConfig.replaceAll('\\', '/'))}`,
        'export default { ...base, test: { ...base.test,',
        '  projects: base.test.projects.map(project => ({ ...project,',
        `    extends: ${JSON.stringify(snapshotConfig.replaceAll('\\', '/'))},`,
        `    test: { ...project.test, include: [${JSON.stringify(fixture.replaceAll('\\', '/'))}] },`,
        '  })),',
        '} }',
        '',
      ].join('\n'))
      const child = await execa(process.execPath, [vitestCli, 'run', fixture, '--config', config,
        ...override === undefined ? [] : [`--testTimeout=${override}`]], {
        cwd: root, env: { ...probeEnv(), LOADER_SMOKE_DEADLINE_RECEIPTS: directory }, reject: false, cancelSignal: signal,
        timeout: loaderSmokeProcessTimeout(task.timeout), killSignal: 'SIGKILL',
      })
      expect(child.timedOut, child.stderr).toBe(false)
      expect(child.isCanceled, child.stderr).toBe(false)
      expect(child.signal, child.stderr).toBeUndefined()
      expect(child.exitCode, `${child.stdout}\n${child.stderr}`).toBe(0)
      expect(JSON.parse(await readFile(join(directory, 'headless.json'), 'utf8'))).toEqual({
        testTimeoutMs: override ?? 45_000, processTimeoutMs: override === undefined ? 30_000 : 75_000,
      })
      expect(JSON.parse(await readFile(join(directory, 'snapshots.json'), 'utf8'))).toEqual({
        testTimeoutMs: override ?? 120_000, processTimeoutMs: null,
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
}

it('assigns every snapshot file to one project without collecting application fixtures', async ({ task, signal }) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-snapshot-inventory-'))
  try {
    const inventory = join(directory, 'inventory.json')
    const child = await execa(process.execPath, [vitestCli, 'list', '--config', snapshotConfig, '--filesOnly', `--json=${inventory}`], {
      cwd: root, env: probeEnv(), reject: false, cancelSignal: signal,
      timeout: loaderSmokeProcessTimeout(task.timeout), killSignal: 'SIGKILL',
    })
    expect(child.timedOut, child.stderr).toBe(false)
    expect(child.isCanceled, child.stderr).toBe(false)
    expect(child.signal, child.stderr).toBeUndefined()
    expect(child.exitCode, `${child.stdout}\n${child.stderr}`).toBe(0)
    const files = JSON.parse(await readFile(inventory, 'utf8')) as { file: string; projectName: string }[]
    expect(files.length).toBeGreaterThan(1)
    expect(new Set(files.map(entry => entry.file)).size).toBe(files.length)
    const headless = files.filter(entry => entry.projectName === 'headless')
    expect(headless).toHaveLength(1)
    expect(headless[0]?.file).toMatch(/[/\\]snapshots[/\\]session[/\\]headless\.snapshot\.ts$/u)
    expect(files.find(entry => /[/\\]scripts[/\\]session-snapshot-corpus\.corpus\.ts$/u.test(entry.file))?.projectName).toBe('snapshots')
    expect(files.find(entry => /[/\\]snapshots[/\\]sdk[/\\]sdk\.snapshot\.ts$/u.test(entry.file))?.projectName).toBe('snapshots')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
