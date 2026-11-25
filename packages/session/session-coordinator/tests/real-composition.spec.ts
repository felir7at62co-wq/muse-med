/** Reconciliation through the shipped launcher, native controllers and durable profile stores. */
import { mkdir, readFile, readdir, stat, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, loaderSmokeProcessTimeout, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { COVERAGE_TEST_TIMEOUT_ENV, coverageTestTimeoutOptions } from '../../../../scripts/coverage-partitions.ts'

const profilePackages = [
  '@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-file-upload',
  '@deepseek-ai/dsh-workspace', '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-api-workspace-controller', '@deepseek-ai/dsh-agent-preset-registry',
  '@deepseek-ai/dsh-agent-preset', '@deepseek-ai/dsh-session-coordinator',
] as const
const laneTimeout = coverageTestTimeoutOptions(process.env[COVERAGE_TEST_TIMEOUT_ENV]).testTimeout

it('reconciles direct worker input without replaying its human message through the real profile', {
  timeout: Math.max(LOADER_SMOKE_TEST_TIMEOUT_MS, laneTimeout ?? 0),
}, async ({ task }) => {
  const patch = fileURLToPath(new URL('./fixtures/reconciliation/reconciliation.patch.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: 'Muse task reconciliation',
    processTimeoutMs: loaderSmokeProcessTimeout(task.timeout),
    binScript: fileURLToPath(new URL('../../../../apps/cli/src/bin.ts', import.meta.url)),
    configPath: patch,
    sourceImport: 'tsx/esm',
    binArgs: ['--profile', 'headless', '--patch', patch, '只改第二集，第三集不要动。保留 current 与 candidate，核对完成后汇报。'],
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.base.json', import.meta.url)),
    tempDirPrefix: 'muse-reconciliation-profile-',
    env: { DSH_TELEMETRY_DISABLED: '1', DSH_PRIMARY_RUNTIME: '' },
    prepare: async (cwd) => {
      // Install the optional profile packages through their real exports in both launch modes.
      const resolve = createRequire(import.meta.url)
      for (const name of profilePackages) {
        const packageRoot = dirname(resolve.resolve(`${name}/package.json`))
        const link = join(cwd, '.dsh', 'profiles', 'headless', 'node_modules', name)
        await mkdir(dirname(link), { recursive: true })
        await symlink(packageRoot, link, process.platform === 'win32' ? 'junction' : 'dir')
      }
    },
    inspect: async (cwd) => {
      const receipt = JSON.parse(await readFile(join(cwd, 'reconciliation-result.json'), 'utf8')) as {
        taskId: string
        workerId: string
        mainId: string
        workerHumanId: string
        mainNotices: { revision: number; status: string }[]
        checks: Record<string, boolean>
      }
      expect(receipt.checks).toEqual({
        mainToolVisible: true,
        businessToolDenied: true,
        ordinaryToolDenied: true,
        staleReportDenied: true,
        sameWorker: true,
        sameModel: true,
        sameDirectory: true,
        humanMessagePreserved: true,
        attachmentPreserved: true,
        completedRevision: true,
        mainReceivedCompletion: true,
      })
      expect(receipt.mainNotices).toContainEqual({ revision: 1, status: 'interrupted' })
      expect(receipt.mainNotices).toContainEqual({ revision: 2, status: 'completed' })
      const path = join(cwd, '.dsh', 'storages', 'muse_coordination', 'tasks', `${receipt.taskId}.json`)
      const stored = JSON.parse(await readFile(path, 'utf8')) as {
        version: number
        record: { owner: string; attempts: { revision: number; sessionId: string; status: string; messageId: string }[] }
      }
      expect(stored.version).toBe(2)
      expect(stored.record.owner).toBe(receipt.mainId)
      expect(stored.record.attempts).toMatchObject([
        { revision: 1, sessionId: receipt.workerId, status: 'needs-report' },
        { revision: 2, sessionId: receipt.workerId, status: 'completed', messageId: receipt.workerHumanId },
      ])
      const sessionsRoot = join(cwd, '.dsh', 'sessions')
      const paths = await readdir(sessionsRoot, { recursive: true })
      const workerPath = paths.find(path => basename(dirname(path)) === receipt.workerId && path.endsWith('session.v4.jsonl'))
      expect(workerPath).toBeDefined()
      if (workerPath === undefined) throw new Error('Worker did not persist its canonical Session log')
      const log = (await readFile(join(sessionsRoot, workerPath), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {
        type: string
        data?: { id?: string; source?: { kind?: string }; content?: { type: string }[] }
      })
      const humans = log.filter(event => event.type === 'user/message' && event.data?.source?.kind === 'user')
      expect(humans).toHaveLength(2)
      expect(humans.filter(event => event.data?.id === receipt.workerHumanId)).toHaveLength(1)
      expect(humans.find(event => event.data?.id === receipt.workerHumanId)?.data?.content).toContainEqual(expect.objectContaining({ type: 'file' }))
      await expect(stat(join(cwd, 'should-not-exist.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    },
  })
  expect(result.stdout).toContain('reconciliation verified')
})
