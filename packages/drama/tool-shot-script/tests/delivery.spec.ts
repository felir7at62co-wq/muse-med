import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DramaShotReport } from '../src/types.ts'
import { actionShot, assetRow, cleanup, dramaShot, manifestDocument, scriptOf, speakingShot, tempDir } from './harness.ts'

/**
 * The project-requirement tier: a project states its own per-shot spoken-text
 * ceiling in the `project_config.json` that marks its root, and `drama_shot`
 * enforces it. Without such a statement the same long line stays advisory, which
 * is what keeps the built-in number advice rather than a rule in every project.
 */

const temporary: string[] = []

afterEach(async () => {
  for (const dir of temporary.splice(0)) await cleanup(dir)
})

/** A project whose script sits under `prompts/`, with an optional declared ceiling. */
async function project(ceiling?: number | string, spoken = 20):
Promise<{ root: string; scriptPath: string; manifestPath: string }> {
  const root = await tempDir()
  temporary.push(root)
  await mkdir(join(root, 'prompts'), { recursive: true })
  await mkdir(join(root, 'episodes'), { recursive: true })
  const scriptPath = join(root, 'prompts', '01.txt')
  await writeFile(scriptPath, scriptOf(
    speakingShot(1, `苏晚：${'字'.repeat(spoken)}`),
    actionShot(2),
  ), 'utf8')
  await writeFile(join(root, 'assets_manifest.json'),
    JSON.stringify(manifestDocument(assetRow('苏晚', '角色'))), 'utf8')
  await writeFile(join(root, 'episodes', '01.txt'), '第一集正文', 'utf8')
  await writeFile(join(root, 'project_config.json'), JSON.stringify({
    jubian_script_id: 2708,
    ...(ceiling === undefined ? {} : { delivery: { max_effective_chars_per_shot: ceiling } }),
  }), 'utf8')
  return { root, scriptPath, manifestPath: join(root, 'assets_manifest.json') }
}

/** One `drama_shot` call, through the registered tool. */
async function run(args: Record<string, unknown>): Promise<DramaShotReport> {
  return await dramaShot().execute(args) as DramaShotReport
}

/** The issue codes one report carries, failures and warnings together. */
function codes(report: DramaShotReport): string[] {
  return [...report.failures, ...report.warnings].map(issue => issue.code)
}

describe("a project's declared per-shot ceiling", () => {
  it('fails a line above the ceiling the project declares, and writes nothing', async () => {
    const files = await project(18)
    const report = await run({ method: 'compile', script: files.scriptPath, assets: files.manifestPath,
      project: files.root, episode: 1, max_submit_seconds: 15 })
    expect(codes(report)).toContain('speech_exceeds_project_limit')
    expect(report.ok).toBe(false)
    expect(report.written).toEqual([])
    expect(report.failures[0]?.message).toContain('超过本项目 project_config.json 声明的每镜上限 18 字')
    expect(report.failures[0]?.message).toContain('改掉或删掉 project_config.json 的 delivery.max_effective_chars_per_shot')
  })

  it('keeps the same line advisory when the project declares no ceiling', async () => {
    const files = await project(undefined, 40)
    const report = await run({ method: 'compile', script: files.scriptPath, assets: files.manifestPath,
      project: files.root, episode: 1, max_submit_seconds: 15 })
    expect(codes(report)).toContain('speech_too_long')
    expect(report.ok).toBe(true)
    expect(report.written.length).toBeGreaterThan(0)
  })

  it('accepts a line at exactly the declared ceiling', async () => {
    const files = await project(20)
    const report = await run({ method: 'validate', script: files.scriptPath, assets: files.manifestPath })
    expect(codes(report)).not.toContain('speech_exceeds_project_limit')
    expect(codes(report)).toContain('speech_above_writing_threshold')
  })

  it('finds the config above a script that sits below the project root', async () => {
    const files = await project(18)
    const report = await run({ method: 'validate', script: files.scriptPath, assets: files.manifestPath })
    expect(codes(report)).toContain('speech_exceeds_project_limit')
  })

  it('reads the ceiling of the project the call names, not the script directory', async () => {
    const declaring = await project(18)
    const other = await project(undefined, 40)
    const report = await run({ method: 'validate', script: other.scriptPath, assets: other.manifestPath,
      project: declaring.root })
    expect(codes(report)).toContain('speech_exceeds_project_limit')
  })

  it('refuses a declared ceiling that is not a positive integer', async () => {
    const files = await project('十八')
    await expect(run({ method: 'validate', script: files.scriptPath, assets: files.manifestPath }))
      .rejects.toThrow(/delivery\.max_effective_chars_per_shot 必须是正整数/)
  })

  it('ignores a malformed project config rather than failing the call', async () => {
    const files = await project(undefined, 40)
    await writeFile(join(files.root, 'project_config.json'), '{ not json', 'utf8')
    const report = await run({ method: 'validate', script: files.scriptPath, assets: files.manifestPath })
    expect(codes(report)).toContain('speech_too_long')
  })
})
