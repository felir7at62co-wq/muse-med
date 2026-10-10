/** Keyless project commands through the supported Headless app and real agent loop. */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { expect, it } from 'vitest'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'
import { PROJECT_FILE } from '../src/schema.ts'

it('loads the tool, logs its canonical source result, and rejects self approval through the agent loop', async () => {
  const patch = fileURLToPath(new URL('./fixtures/cordis.yml', import.meta.url))
  const { stderr } = await runLoaderSmoke({
    label: 'screenplay project Headless', tempDirPrefix: 'screenplay-loader-',
    binScript: fileURLToPath(new URL('../../../../apps/cli/src/bin.ts', import.meta.url)),
    configPath: patch, binArgs: ['--profile', 'headless', '--patch', patch, '--json', '执行来源录入并尝试自审。'],
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
    sourceImport: 'tsx/esm', mode: 'src',
    prepare: async (cwd) => { await writeFile(join(cwd, 'source.txt'), '甲想：钥匙在我手里。\n') },
    inspect: async (cwd) => {
      const project = PROJECT_FILE.parse(JSON.parse(await readFile(join(cwd, 'project.json'), 'utf8')))
      expect(project.facts).toHaveLength(1)
      expect(project.facts[0]!.review).toBeUndefined()
      expect(project.accepted).toEqual([])
      const names = await readdir(join(cwd, '.sessions'), { recursive: true })
      const logs = await Promise.all(names.filter(name => name.endsWith('.jsonl')).map(name => readFile(join(cwd, '.sessions', name), 'utf8')))
      const text = logs.join('\n')
      expect(text).toContain('self_review')
      expect(text).toContain('甲想：钥匙在我手里。')
      expect(text).toContain('source_sha256')
      expect(text).toContain('screenplay_project')
    },
  })
  expect(stderr).not.toContain('UNHANDLED')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

it('uses real PTC model steps, exposes unprinted rereads and refuses same-step or failed-program self-checks', async () => {
  const patch = fileURLToPath(new URL('./fixtures/self-check.cordis.yml', import.meta.url))
  const { stderr } = await runLoaderSmoke({
    label: 'screenplay sequential self-check PTC', tempDirPrefix: 'screenplay-self-check-loader-',
    binScript: fileURLToPath(new URL('../../../../apps/cli/src/bin.ts', import.meta.url)),
    configPath: patch, binArgs: ['--profile', 'headless', '--patch', patch, '--json', '按真实模型轮自检、验收并导出。'],
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)), sourceImport: 'tsx/esm', mode: 'src',
    prepare: async (cwd) => { await writeFile(join(cwd, 'source.txt'), '甲想：钥匙在我手里。\n') },
    inspect: async (cwd) => {
      const project = PROJECT_FILE.parse(JSON.parse(await readFile(join(cwd, 'project.json'), 'utf8')))
      expect(project.review_mode).toBe('self-check')
      expect(project.accepted).toEqual([project.candidates[0]!.id])
      for (const subject of [project.facts[0]!, project.candidates[0]!]) {
        expect(subject.review!.kind).toBe('self-check')
        expect(subject.review!.evidence!.reads.every(read => subject.created_step! < read.step
          && read.step < subject.review!.evidence!.review_step)).toBe(true)
      }
      expect(project.facts[0]!.review!.actor).toBe(project.facts[0]!.proposer)
      expect(project.candidates[0]!.review!.actor).toBe(project.candidates[0]!.author)
      const names = await readdir(join(cwd, '.sessions'), { recursive: true })
      const logs = await Promise.all(names.filter(name => name.endsWith('.jsonl')).map(name => readFile(join(cwd, '.sessions', name), 'utf8')))
      const text = logs.join('\n')
      expect(text).toContain('self_check_step')
      expect(text).toContain('self_check_read_required')
      expect(text).toContain('screenplay-project-read')
      expect(text).toContain('fixture outer read failure')
      expect(text).toContain('fixture outer candidate failure')
      expect(text).toContain('fixture source read policy denial')
      expect(text).toContain('replaced')
      expect(text).toContain('fixture replaced source read content')
      const files = await readdir(join(cwd, 'delivery'))
      const sidecar = z.object({ review: z.object({ kind: z.string() }) }).parse(JSON.parse(await readFile(join(cwd, 'delivery', files.find(name => name.endsWith('.sources.json'))!), 'utf8')))
      expect(sidecar.review.kind).toBe('self-check')
    },
  })
  expect(stderr).not.toContain('UNHANDLED')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)


it('cold-resumes the same real session fail-closed for old visible rereads and approves only after fresh model-step reads', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'screenplay-cold-resume-'))
  const patch = fileURLToPath(new URL('./fixtures/self-check.cordis.yml', import.meta.url))
  const base = { label: 'screenplay self-check cold resume', cwd, configPath: patch,
    binScript: fileURLToPath(new URL('../../../../apps/cli/src/bin.ts', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)), sourceImport: 'tsx/esm' as const, mode: 'src' as const }
  try {
    await writeFile(join(cwd, 'source.txt'), '甲想：钥匙在我手里。\n')
    const first = await runLoaderSmoke({ ...base, env: { SCREENPLAY_SELF_CHECK_FIXTURE_MODE: 'checkpoint' },
      binArgs: ['--profile', 'headless', '--patch', patch, '--json', '产出并读回，保留待审。'] })
    const header = first.stdout.split('\n').map((line) => { try { return z.unknown().parse(JSON.parse(line)) } catch { return undefined } })
      .map(value => z.object({ type: z.literal('session'), sessionId: z.string() }).safeParse(value)).find(value => value.success)
    if (!header?.success) throw Error('cold-resume fixture omitted session identity')
    const pending = PROJECT_FILE.parse(JSON.parse(await readFile(join(cwd, 'project.json'), 'utf8')))
    expect(pending.facts[0]!.review).toBeUndefined()
    const resumed = await runLoaderSmoke({ ...base, env: { SCREENPLAY_SELF_CHECK_FIXTURE_MODE: 'resume' },
      binArgs: ['--profile', 'headless', '--patch', patch, '--session-id', header.data.sessionId, '--json', '冷恢复后重新读回再自检。'] })
    expect(resumed.stdout).toContain('self_check_read_required')
    const accepted = PROJECT_FILE.parse(JSON.parse(await readFile(join(cwd, 'project.json'), 'utf8')))
    expect(accepted.facts[0]!.review).toMatchObject({ kind: 'self-check', actor: header.data.sessionId })
    expect(accepted.facts[0]!.review!.evidence!.reads.every(read => read.step > pending.facts[0]!.created_step!
      && read.step < accepted.facts[0]!.review!.evidence!.review_step)).toBe(true)
  } finally { await rm(cwd, { recursive: true, force: true }) }
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

it('runs genuine source:user authorization and a separate final report through actual PTC self-check steps', async () => {
  const patch = fileURLToPath(new URL('./fixtures/refinement.cordis.yml', import.meta.url))
  const { stdout, stderr } = await runLoaderSmoke({
    label: 'screenplay source-preserving refinement PTC', tempDirPrefix: 'screenplay-refinement-loader-',
    binScript: fileURLToPath(new URL('../../../../apps/cli/src/bin.ts', import.meta.url)), configPath: patch,
    binArgs: ['--profile', 'headless', '--patch', patch, '--json', '只精修第一集，可以补最小 OS，不改变事件。'],
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)), sourceImport: 'tsx/esm', mode: 'src',
    prepare: async (cwd) => { await writeFile(join(cwd, 'source.txt'), '甲想：钥匙在我手里。') },
    inspect: async (cwd) => {
      const originalBytes = await readFile(join(cwd, 'original.json'), 'utf8')
      const original = PROJECT_FILE.parse(JSON.parse(originalBytes))
      const refined = PROJECT_FILE.parse(JSON.parse(await readFile(join(cwd, 'refinement-v1/qa/screenplay-project.json'), 'utf8')))
      expect(refined.refinement!.allowed_categories).toEqual(['minimal_os'])
      expect(refined.refinement!.authorization).toMatchObject({ source: 'user', quote: '只精修第一集，可以补最小 OS，不改变事件。' })
      expect(refined.refinement!.source_project.sha256).toBe((await import('../src/episode.ts')).sha256(originalBytes))
      expect(refined.facts[0]).toEqual(original.facts[0]); expect(refined.facts[0]!.review!.kind).toBe('self-check')
      expect(refined.accepted).toEqual([refined.candidates[0]!.id]); expect(refined.candidates[0]!.review!.kind).toBe('self-check')
      expect(refined.candidates[0]!.review!.evidence!.reads.some(read => read.kind === 'candidate' && read.id === original.candidates[0]!.id)).toBe(true)
      const files = await readdir(join(cwd, 'delivery'))
      const reportName = files.find(name => name.endsWith('.modification-notes.md'))!
      const report = await readFile(join(cwd, 'delivery', reportName), 'utf8')
      expect(report).toContain('《修改说明》'); expect(report).toContain(refined.candidates[0]!.sha256); expect(report).toContain('self-check / approve')
      const scriptName = files.find(name => name.endsWith('.md') && !name.endsWith('.modification-notes.md'))!
      expect(await readFile(join(cwd, 'delivery', scriptName), 'utf8')).not.toContain('修改说明')
    },
  })
  expect(stdout).toContain('refinement_human_authorization'); expect(stderr).not.toContain('UNHANDLED')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)


it('rejects an otherwise identical refinement request when the real user never granted it', async () => {
  const patch = fileURLToPath(new URL('./fixtures/refinement.cordis.yml', import.meta.url))
  const { stdout, stderr } = await runLoaderSmoke({
    label: 'screenplay missing human refinement grant', tempDirPrefix: 'screenplay-refinement-no-grant-',
    binScript: fileURLToPath(new URL('../../../../apps/cli/src/bin.ts', import.meta.url)), configPath: patch,
    binArgs: ['--profile', 'headless', '--patch', patch, '--json', '整理已有来源，保留原项目。'],
    env: { SCREENPLAY_REFINEMENT_FIXTURE_MODE: 'missing-grant' },
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)), sourceImport: 'tsx/esm', mode: 'src',
    prepare: async (cwd) => { await writeFile(join(cwd, 'source.txt'), '甲想：钥匙在我手里。') },
    inspect: async (cwd) => {
      const original = PROJECT_FILE.parse(JSON.parse(await readFile(join(cwd, 'original.json'), 'utf8')))
      expect(original.accepted).toHaveLength(1); expect(original.refinement).toBeUndefined()
      expect(await readdir(cwd)).not.toContain('refinement-v1')
    },
  })
  expect(stdout).toContain('refinement_human_authorization'); expect(stderr).not.toContain('UNHANDLED')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
