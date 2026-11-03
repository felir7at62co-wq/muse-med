/** Browser Settings over the real Jubian recovery Remote and a project-owned ledger. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import type {} from '@deepseek-ai/dsh-tool-jubian'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, openSettings, saveFailureShot } from './support.ts'

const JUBIAN_MANIFEST = fileURLToPath(new URL('../../../packages/jubian/tool-jubian/package.json', import.meta.url))
const DELIVERY_FIXTURE = fileURLToPath(new URL('./fixtures/approved-clip-delivery.mjs', import.meta.url))
const ffmpeg = process.env.MUSE_RECOVERY_TEST_FFMPEG ?? process.env.DSH_FFMPEG_PATH
const mode = webSnapshotMode()
const expected = fileURLToPath(new URL('./expected/jubian-video-recovery', import.meta.url))

it.skipIf(!ffmpeg || mode === 'record')('recovers, reviews and delivers project video through Jianying', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-video-recovery-web-')))
  let scaffold: WebScaffold | undefined
  const resources: { browser?: Browser } = {}
  onTestFinished(async () => {
    try {
      await resources.browser?.close()
    } finally {
      try {
        await scaffold?.close()
      } finally {
        vi.unstubAllEnvs()
        await rm(root, { recursive: true, force: true, maxRetries: 3 })
      }
    }
  })
  vi.stubEnv('DSH_FFMPEG_PATH', ffmpeg)
  const harnessHome = join(root, 'home')
  const projectDir = join(root, 'video-project')
  const tasksDir = join(projectDir, 'video_tasks')
  const reviewDir = join(tasksDir, 'review')
  const ledgerRoot = join(harnessHome, 'jubian', 'ledger')
  const configurationPath = join(harnessHome, 'jubian', 'video-recovery.json')
  const overlay = join(root, 'jubian.overlay.json')
  await writeFile(overlay, JSON.stringify([{ insert: [{
    id: 'approved-clip-delivery-fixture', name: DELIVERY_FIXTURE, config: { ffmpeg },
  }, {
    id: 'tool-jubian', name: '@deepseek-ai/dsh-tool-jubian',
    config: { videoRecoverySettings: true, workspaceSecrets: false, baseUrl: 'http://127.0.0.1:0' },
  }] }]))
  await mkdir(reviewDir, { recursive: true })
  await writeFile(join(projectDir, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
  const entries = [{ key: 'fixture-ready', taskId: 335343 }, { key: 'fixture-needs-changes', taskId: 335344 }]
  const ledger = new JubianLedger({ root: ledgerRoot })
  await ledger.beginManyChecked(entries.map(entry => entry.key), async () => entries.map(entry => ({
    idempotencyKey: entry.key, method: 'storyboard_native_submit', scriptId: 2708,
    videoPreviewPath: join(tasksDir, `${entry.key}.storyboard-native.prepared.json`), beforeTaskIds: [],
    requestSha256: 'sha256:' + createHash('sha256').update(entry.key).digest('hex'),
  })))
  const reportPaths = await Promise.all(entries.map(async (entry, index) => {
    const path = join(reviewDir, createHash('sha256').update(entry.key).digest('hex') + '.json')
    await writeFile(path, JSON.stringify({
      idempotency_key: entry.key, task_id: entry.taskId, status: 'awaiting_review',
      media_checks: [{ sha256: 'sha256:' + createHash('sha256').update(String(entry.taskId)).digest('hex'),
        video: index !== 0, audio: index === 0 }],
    }))
    return path
  }))

  const derivativePath = 'video_tasks/local-edit.mp4'
  const derivativeFile = join(projectDir, derivativePath)
  await promisify(execFile)(ffmpeg!, [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=96x54:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=421:sample_rate=32000',
    '-t', '2', '-c:v', 'mpeg4', '-q:v', '2', '-c:a', 'aac', derivativeFile,
  ], { windowsHide: true })
  const providerReport = await readFile(reportPaths[0]!)
  const providerDigest = createHash('sha256').update(providerReport).digest('hex')
  const derivativeMarkerPath = reportPaths[0]! + '.decision.json'
  const derivativeDecisionPath = reportPaths[0]! + '.derivative.decision.json'

  const boot = () => launchWebScaffold({ extraOverlayPath: overlay, extraInstallAnchors: [JUBIAN_MANIFEST], harnessHome })
  scaffold = await boot()
  const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  resources.browser = browser
  const page = await newEnglishPage(browser)
  let currentPage = page
  onTestFailed(() => saveFailureShot(currentPage, 'muse-jubian-video-recovery'))
  const console = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const settings = await openJubianSettings(page)
  await settings.getByText('Recovery disabled', { exact: true }).waitFor()
  await settings.getByRole('textbox', { name: 'Project folder', exact: true }).fill(projectDir)
  await settings.getByRole('button', { name: 'Enable recovery', exact: true }).click()
  await settings.getByText('Recovery enabled', { exact: true }).waitFor()
  expect(JSON.parse(await readFile(configurationPath, 'utf8'))).toEqual({ enabled: true, projectDir })
  const ready = settings.getByRole('article').filter({ hasText: 'Task 335343' })
  const needsChanges = settings.getByRole('article').filter({ hasText: 'Task 335344' })
  await ready.getByText('Video could not be decoded', { exact: true }).waitFor()
  await ready.getByText('Audio decodes', { exact: true }).waitFor()
  await needsChanges.getByText('Audio could not be decoded', { exact: true }).waitFor()
  expect(await settings.getByText('Awaiting review', { exact: true }).count()).toBe(2)
  if (mode === 'refresh') await mkdir(expected, { recursive: true })
  const escapedPath = projectDir.replaceAll('\\', '\\\\')
  const recoveryAria = async (target: Page, managedPath?: string, exportPath?: string) => await captureStableAria(target, '[aria-label="Project video recovery"]', root, {
    replacements: [[escapedPath, '{{project}}'], [projectDir, '{{project}}'],
      ...(managedPath === undefined ? [] : [[managedPath, '{{managed-video}}'] as const]),
      ...(exportPath === undefined ? [] : [[exportPath, '{{editor-export}}'] as const])],
  })
  await compareOrRefreshGolden(join(expected, 'reports.expected.md'), await recoveryAria(page), mode)

  await ready.getByRole('button', { name: 'Import local video', exact: true }).click()
  const importDialog = page.getByRole('dialog', { name: 'Import local video', exact: true })
  await importDialog.getByRole('textbox', { name: 'Local video path', exact: true }).fill(derivativePath)
  await importDialog.getByRole('button', { name: 'Import video', exact: true }).click()
  await ready.getByText('Local derivative', { exact: true }).waitFor()
  await ready.getByText('Video decodes', { exact: true }).waitFor()
  await ready.getByText('Audio decodes', { exact: true }).waitFor()
  expect(await ready.getByRole('button', { name: 'Import local video', exact: true }).count()).toBe(0)
  expect(await readFile(reportPaths[0]!)).toEqual(providerReport)
  await expect(readFile(derivativeDecisionPath)).rejects.toMatchObject({ code: 'ENOENT' })
  const markerBytes = await readFile(derivativeMarkerPath)
  const marker: unknown = JSON.parse(markerBytes.toString('utf8'))
  if (!marker || typeof marker !== 'object' || !('filename' in marker)
    || typeof marker.filename !== 'string' || !/^artifact-[a-f0-9-]{36}\.mp4$/.test(marker.filename)) {
    throw new Error('Invalid derivative marker filename')
  }
  const derivativeBytes = await readFile(derivativeFile)
  const derivativeSha = createHash('sha256').update(derivativeBytes).digest('hex')
  expect(marker).toMatchObject({
    kind: 'derivative', originalDigest: providerDigest, path: derivativePath,
    sha256: derivativeSha, video: true, audio: true,
  })
  const managedPath = 'video_tasks/review/' + marker.filename
  await ready.getByText(managedPath, { exact: true }).waitFor()
  expect(await readFile(join(projectDir, managedPath))).toEqual(derivativeBytes)
  const activeDigest = createHash('sha256').update(providerReport).update('\0').update(markerBytes).digest('hex')
  expect(activeDigest).not.toBe(providerDigest)

  await ready.getByRole('button', { name: 'Approve', exact: true }).click()
  const approve = page.getByRole('dialog', { name: 'Approve', exact: true })
  await approve.getByText('Record your decision for task 335343.', { exact: true }).waitFor()
  await expect(readFile(derivativeDecisionPath)).rejects.toMatchObject({ code: 'ENOENT' })
  await approve.getByRole('button', { name: 'Confirm decision', exact: true }).click()
  await ready.getByText('Approved', { exact: true }).waitFor()
  await needsChanges.getByRole('button', { name: 'Return for changes', exact: true }).click()
  const reject = page.getByRole('dialog', { name: 'Return for changes', exact: true })
  await reject.getByText('Record your decision for task 335344.', { exact: true }).waitFor()
  const reason = 'Audio starts late. Please restore the opening line.'
  const reasonField = reject.getByRole('textbox', { name: 'Reason for return', exact: true })
  const confirmReturn = reject.getByRole('button', { name: 'Confirm decision', exact: true })
  expect(await confirmReturn.isDisabled()).toBe(true)
  await reasonField.fill('   ')
  expect(await confirmReturn.isDisabled()).toBe(true)
  await reasonField.fill(`  ${reason}  `)
  await confirmReturn.click()
  await needsChanges.getByText('Returned for changes', { exact: true }).waitFor()
  await needsChanges.getByText(reason, { exact: true }).waitFor()
  expect(await settings.getByRole('button', { name: 'Approve', exact: true }).count()).toBe(0)
  expect(await settings.getByRole('button', { name: 'Return for changes', exact: true }).count()).toBe(0)
  const decisions = await Promise.all([derivativeDecisionPath, reportPaths[1]! + '.decision.json']
    .map(async (path): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'))))
  expect(decisions).toEqual([
    { action: 'approve', digest: activeDigest },
    { action: 'reject', digest: createHash('sha256').update(await readFile(reportPaths[1]!)).digest('hex'), reason },
  ])

  const deliveryRecord = join(reviewDir, activeDigest + '.delivery.json')
  const draftPath = join(projectDir, 'fixture-draft')
  const recovery = scaffold.ctx.get('jubianVideoRecovery')
  expect(recovery).toBeDefined()
  await expect(recovery!.deliverApprovedClip({ idempotencyKey: entries[0]!.key, digest: providerDigest }))
    .rejects.toThrow('Select an approved local video with passing picture and audio checks')
  await expect(readFile(join(draftPath, 'approved-source.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readdir(join(projectDir, 'exports'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(deliveryRecord)).rejects.toMatchObject({ code: 'ENOENT' })
  await ready.getByRole('button', { name: 'Deliver with Jianying', exact: true }).click()
  await ready.getByText('Jianying draft Fixture draft 335343', { exact: true }).waitFor()
  await ready.getByText('Jianying export verified', { exact: true }).waitFor()
  expect(JSON.parse(await readFile(join(draftPath, 'approved-source.json'), 'utf8'))).toEqual({
    projectDir, path: join(projectDir, managedPath), sha256: derivativeSha, taskId: 335343,
  })
  const exports = await readdir(join(projectDir, 'exports'))
  expect(exports).toHaveLength(1)
  const exportPath = 'exports/' + exports[0]!
  const exportSha = createHash('sha256').update(await readFile(join(projectDir, exportPath))).digest('hex')
  expect(exportSha).not.toBe(derivativeSha)
  const deliveryBytes = await readFile(deliveryRecord)
  expect(JSON.parse(deliveryBytes.toString('utf8'))).toMatchObject({
    draft: { path: draftPath, name: 'Fixture draft 335343' },
    export: { path: exportPath, sha256: exportSha },
  })

  expect(console.pageErrors).toEqual([])
  await unlink(derivativeFile)
  await page.close()
  await scaffold.close()
  scaffold = undefined
  // The scaffold installs this link on every boot. Remove only the fixture link;
  // the same Host home retains the enabled setting and the project report files.
  await unlink(join(harnessHome, 'profiles', 'scaffold', 'node_modules', '@deepseek-ai', 'dsh-tool-jubian'))
  scaffold = await boot()
  currentPage = await newEnglishPage(browser)
  const restartedConsole = watchConsole(currentPage)
  await currentPage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const restored = await openJubianSettings(currentPage)
  await restored.getByText('Recovery enabled', { exact: true }).waitFor()
  expect(await restored.getByRole('textbox', { name: 'Project folder', exact: true }).inputValue()).toBe(projectDir)
  const restoredDerivative = restored.getByRole('article').filter({ hasText: 'Task 335343' })
  await restoredDerivative.getByText('Approved', { exact: true }).waitFor()
  await restoredDerivative.getByText('Local derivative', { exact: true }).waitFor()
  await restoredDerivative.getByText(managedPath, { exact: true }).waitFor()
  await restoredDerivative.getByText('Audio decodes', { exact: true }).waitFor()
  await restoredDerivative.getByText('Jianying draft Fixture draft 335343', { exact: true }).waitFor()
  await restoredDerivative.getByText('Jianying export verified', { exact: true }).waitFor()
  expect(await readFile(deliveryRecord)).toEqual(deliveryBytes)
  expect(await readFile(reportPaths[0]!)).toEqual(providerReport)
  expect(await readFile(derivativeMarkerPath)).toEqual(markerBytes)
  expect(JSON.parse(await readFile(derivativeDecisionPath, 'utf8'))).toEqual(decisions[0])
  await restored.getByText('Returned for changes', { exact: true }).waitFor()
  await restored.getByRole('article').filter({ hasText: 'Task 335344' }).getByText(reason, { exact: true }).waitFor()
  await compareOrRefreshGolden(join(expected, 'reviewed.expected.md'), await recoveryAria(currentPage, managedPath, exportPath), mode)
  const manualPath = 'exports/manual-review.mp4'
  await copyFile(join(projectDir, exportPath), join(projectDir, manualPath))
  await restoredDerivative.getByRole('button', { name: 'Verify Jianying export', exact: true }).click()
  const verifyExport = currentPage.getByRole('dialog', { name: 'Verify Jianying export', exact: true })
  await verifyExport.getByRole('textbox', { name: 'Exported video path', exact: true }).fill(manualPath)
  await verifyExport.getByRole('button', { name: 'Verify Jianying export', exact: true }).click()
  await restoredDerivative.getByText(manualPath, { exact: true }).waitFor()
  expect(JSON.parse(await readFile(deliveryRecord, 'utf8'))).toMatchObject({ export: { path: manualPath, sha256: exportSha } })

  await restored.getByRole('button', { name: 'Disable recovery', exact: true }).click()
  await restored.getByText('Recovery disabled', { exact: true }).waitFor()
  expect(JSON.parse(await readFile(configurationPath, 'utf8'))).toEqual({ enabled: false, projectDir })
  expect(restartedConsole.pageErrors).toEqual([])
})

async function openJubianSettings(page: Page) {
  await openSettings(page, 'en')
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByRole('button', { name: 'Jubian', exact: true }).click()
  const recovery = settings.getByRole('region', { name: 'Project video recovery', exact: true })
  await recovery.waitFor()
  return recovery
}
