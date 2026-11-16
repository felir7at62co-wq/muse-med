import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { comparedOutputs, driftReport, expectedText, findStaleOutputs, removedLines, textFragments } from './verify-snapshot-drift.ts'

const script = resolve(import.meta.dirname, 'verify-snapshot-drift.ts')
const sentence = 'Keep each dialogue line on its own row with the speaker first.'

describe('textFragments', () => {
  it('reads prose lines without list, heading or YAML key syntax', () => {
    expect(textFragments('skills/format/SKILL.md', `- ${sentence}`)).toEqual([sentence])
    expect(textFragments('skills/format/SKILL.md', `## ${sentence}`)).toEqual([sentence])
    expect(textFragments('presets/agent.cordis.yml', `    description: '${sentence}'`)).toEqual([sentence])
  })

  it('adds the decoded contents of every code string literal and template piece', () => {
    const line = "  description: 'Run one command; it\\'s bounded by the session timeout.'"
      + ' + `Then read ${file} for every remaining episode.`,'
    expect(textFragments('src/tool.ts', line)).toEqual([
      line.trim(),
      'Run one command; it\'s bounded by the session timeout.',
      'Then read',
      'for every remaining episode.',
    ].filter(fragment => fragment.length >= 24))
  })

  it('keeps short Chinese text that identifies a sentence and drops short or letterless text', () => {
    expect(textFragments('skills/format/SKILL.md', '每句台词都必须带括号说明')).toEqual(['每句台词都必须带括号说明'])
    expect(textFragments('skills/format/SKILL.md', '台词带括号')).toEqual([])
    expect(textFragments('src/limits.ts', '  const limits = [1_000_000, 2_000_000, 3_000_000]')).toEqual(['const limits = [1_000_000, 2_000_000, 3_000_000]'])
    expect(textFragments('src/limits.ts', '  "--------------------------------"')).toEqual([])
  })
})

describe('expectedText', () => {
  it('searches tool schemas by their decoded string values and Markdown as written', () => {
    const schema = JSON.stringify([{ name: 'bash', description: `Quote "paths".\n${sentence}`, parameters: { type: 'object' } }])
    expect(expectedText('snapshots/session/a/tool-schemas.expected.json', schema)).toContain(`Quote "paths".\n${sentence}`)
    expect(expectedText('snapshots/session/a/system-prompt.expected.md', `# Prompt\n${sentence}`)).toBe(`# Prompt\n${sentence}`)
    expect(expectedText('snapshots/session/a/tool-schemas.expected.json', '{ not json')).toBe('')
  })

  it('searches only tool results of Session JSONL, never recorded model or user text', () => {
    const log = [
      JSON.stringify({ type: 'user/message', message: { content: [{ type: 'text', text: `Quote: ${sentence}` }] } }),
      JSON.stringify({ type: 'assistant/message', message: { content: [{ type: 'text', text: sentence }] } }),
      JSON.stringify({ type: 'tool/result', result: { content: [{ type: 'text', text: `skill reference\n${sentence}` }] } }),
      '{ torn line',
    ].join('\n')
    expect(expectedText('snapshots/session/a/session.v4.jsonl', log)).toBe(`tool/result\ntext\nskill reference\n${sentence}`)
  })
})

describe('comparedOutputs', () => {
  it('selects sidecars plus writer oracles, or else the highest Session generation of each role', () => {
    expect(comparedOutputs([
      'snapshots/session/a/session.v2.jsonl',
      'snapshots/session/a/session.v4.jsonl',
      'snapshots/session/a/session.1.jsonl',
      'snapshots/session/a/session.1.v3.jsonl',
      'snapshots/session/a/system-prompt.expected.md',
      'snapshots/session/a/system-prompt.1.expected.md',
      'snapshots/session/a/snapshot.yml',
      'snapshots/session/b/session.v3.jsonl',
      'snapshots/session/b/session.v4.jsonl',
      'snapshots/session/b/writer.expected.jsonl',
      'snapshots/session/b/writer.1.expected.jsonl',
      'snapshots/session/b/tool-schemas.expected.json',
      'snapshots/web/c/session.jsonl',
      'snapshots/web/c/workspace.expected/notes.md',
    ])).toEqual([
      'snapshots/session/a/session.1.v3.jsonl',
      'snapshots/session/a/session.v4.jsonl',
      'snapshots/session/a/system-prompt.1.expected.md',
      'snapshots/session/a/system-prompt.expected.md',
      'snapshots/session/b/tool-schemas.expected.json',
      'snapshots/session/b/writer.1.expected.jsonl',
      'snapshots/session/b/writer.expected.jsonl',
      'snapshots/web/c/session.jsonl',
    ])
  })
})

describe('removedLines', () => {
  it('collects removed text lines per source, including deleted and quoted paths, and skips binary sources', () => {
    const diff = [
      'diff --git a/skills/format/SKILL.md b/skills/format/SKILL.md',
      '--- a/skills/format/SKILL.md',
      '+++ b/skills/format/SKILL.md',
      '@@ -3 +3 @@',
      `-- ${sentence}`,
      '+- Replacement text that the model now reads instead.',
      'diff --git a/src/old.ts b/src/old.ts',
      '--- a/src/old.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      "-export const text = 'retired text'",
      'diff --git "a/skills/台词\\tformat.md" "b/skills/台词\\tformat.md"',
      '--- "a/skills/台词\\tformat.md"',
      '+++ "b/skills/台词\\tformat.md"',
      '@@ -1 +1 @@',
      '-旧的台词格式说明文字',
      '+新的台词格式说明文字',
      'diff --git a/assets/logo.png b/assets/logo.png',
      '--- a/assets/logo.png',
      '+++ b/assets/logo.png',
      '-binary-looking line',
    ].join('\n')
    expect(Object.fromEntries(removedLines(diff))).toEqual({
      'skills/format/SKILL.md': [`- ${sentence}`],
      'src/old.ts': ["export const text = 'retired text'"],
      'skills/台词\tformat.md': ['旧的台词格式说明文字'],
    })
  })
})

describe('findStaleOutputs', () => {
  const removed = new Map([['skills/format/SKILL.md', [`- ${sentence}`]]])
  const sidecars = new Map([
    ['snapshots/session/b/system-prompt.expected.md', `prompt\n- ${sentence}\n`],
    ['snapshots/session/a/system-prompt.expected.md', `prompt\n- ${sentence}\n`],
    ['snapshots/sdk/c/tool-schemas.expected.json', 'unrelated schema text'],
  ])

  it('reports every expected output that still contains text no source contains', () => {
    const asked: string[] = []
    expect(findStaleOutputs(removed, sidecars, (fragment) => { asked.push(fragment); return false })).toEqual([
      { expected: 'snapshots/session/a/system-prompt.expected.md', source: 'skills/format/SKILL.md', fragment: sentence },
      { expected: 'snapshots/session/b/system-prompt.expected.md', source: 'skills/format/SKILL.md', fragment: sentence },
    ])
    expect(asked).toEqual([sentence])
  })

  it('accepts output whose text another source still produces, and never asks about unmatched text', () => {
    expect(findStaleOutputs(removed, sidecars, () => true)).toEqual([])
    const unmatched = new Map([['src/tool.ts', ["  description: 'Text that no committed snapshot has ever contained.',"]]])
    expect(findStaleOutputs(unmatched, sidecars, () => { throw new Error('unmatched text must not be searched') })).toEqual([])
  })
})

describe('driftReport', () => {
  it('names each stale output and the refresh command of its owning suite', () => {
    const report = driftReport([
      { expected: 'snapshots/session/b/system-prompt.expected.md', source: 'skills/x.md', fragment: 'x'.repeat(120) },
      { expected: 'snapshots/session/a/tool-schemas.expected.json', source: 'src/tool.ts', fragment: sentence },
      { expected: 'snapshots/sdk/c/system-prompt.expected.md', source: 'src/tool.ts', fragment: sentence },
      { expected: 'snapshots/web/d/system-prompt.expected.md', source: 'src/tool.ts', fragment: sentence },
    ])
    expect(report[1]).toBe(`  snapshots/session/b/system-prompt.expected.md: "${'x'.repeat(97)}..." (removed from skills/x.md)`)
    expect(report.slice(-4)).toEqual([
      "  pnpm run test:snapshot snapshots/session/headless.snapshot.ts -t 'a|b'",
      "  pnpm run test:snapshot snapshots/sdk/sdk.snapshot.ts -t 'c'",
      "  rg --fixed-strings 'snapshots/web/d' apps/web/tests",
      '  Run the matching test file with pnpm run test:web:built; its filename may differ from the scenario.',
    ])
  })
})

describe('verify-snapshot-drift command', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  interface Repository {
    root: string
    git: (...args: string[]) => string
    write: (path: string, text: string) => void
    run: (...args: string[]) => SpawnSyncReturns<string>
  }

  function repository(): Repository {
    const root = mkdtempSync(join(tmpdir(), 'dsh-snapshot-drift-'))
    roots.push(root)
    const git = (...args: string[]): string => {
      const result = spawnSync('git', ['-c', 'user.name=Snapshot Drift', '-c', 'user.email=drift@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' })
      if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`)
      return result.stdout.trim()
    }
    const write = (path: string, text: string): void => {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    const run = (...args: string[]): SpawnSyncReturns<string> => spawnSync(process.execPath, [script, ...args], {
      cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, DSH_SNAPSHOT_DRIFT_BASE_REF: '', GITHUB_ACTIONS: '' },
    })
    git('init', '-q', '-b', 'main')
    return { root, git, write, run }
  }

  it('fails a change that leaves its removed prompt text in a committed sidecar, and passes once refreshed', () => {
    const { git, write, run } = repository()
    write('skills/format/SKILL.md', `# Format\n\n- ${sentence}\n`)
    write('snapshots/session/screenplay/system-prompt.expected.md', `# Format\n\n- ${sentence}\n`)
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    write('skills/format/SKILL.md', '# Format\n\n- Put the speaker first and keep one dialogue line per row.\n')
    git('commit', '-q', '-am', 'change prompt text')

    const stale = run('--base', base, '--head', 'HEAD')
    expect(stale.error).toBeUndefined()
    expect(stale.signal).toBeNull()
    expect(stale.status).toBe(1)
    expect(stale.stderr).toContain(`snapshots/session/screenplay/system-prompt.expected.md: ${JSON.stringify(sentence)} (removed from skills/format/SKILL.md)`)
    expect(stale.stderr).toContain("pnpm run test:snapshot snapshots/session/headless.snapshot.ts -t 'screenplay'")
    expect(stale.stdout).not.toContain('::warning')
    const annotated = spawnSync(process.execPath, [script, '--base', base, '--head', 'HEAD'], {
      cwd: git('rev-parse', '--show-toplevel'), encoding: 'utf8', timeout: 60_000, env: { ...process.env, GITHUB_ACTIONS: 'true' },
    })
    expect(annotated.status).toBe(1)
    expect(annotated.stdout).toBe("::warning title=Stale recorded-session snapshots::pnpm run test:snapshot snapshots/session/headless.snapshot.ts -t 'screenplay'\n")

    write('snapshots/session/screenplay/system-prompt.expected.md', '# Format\n\n- Put the speaker first and keep one dialogue line per row.\n')
    const refreshed = run()
    expect(refreshed.signal).toBeNull()
    expect(refreshed.status).toBe(0)
    git('commit', '-q', '-am', 'refresh snapshot')
    expect(run('--base', base, '--head', 'HEAD').status).toBe(0)
  })

  it('keeps an invalid base fatal in warning mode', () => {
    const { git, write, run } = repository()
    write('skills/format/SKILL.md', `- ${sentence}\n`)
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    const failed = run('--base', 'missing-ref-for-drift-test', '--warn-only')
    expect(failed.error).toBeUndefined()
    expect(failed.signal).toBeNull()
    expect(failed.status).not.toBe(0)
    expect(failed.stderr).toContain('missing-ref-for-drift-test')
  })

  it('fails when a skill reference the recorded tool read no longer contains its text, but ignores retained generations', () => {
    const { git, write, run } = repository()
    const read = (text: string): string => `${JSON.stringify({ type: 'tool/result', result: { content: [{ type: 'text', text }] } })}\n`
    write('skills/video/references/workflow.md', `- ${sentence}\n`)
    write('snapshots/session/video/session.v3.jsonl', read(`- ${sentence}`))
    write('snapshots/session/video/session.v4.jsonl', read('- Current reference text from the latest recording.'))
    write('snapshots/session/retained/session.v4.jsonl', read(`- ${sentence}`))
    write('snapshots/session/retained/writer.expected.jsonl', read('- Writer oracle text for the retained input.'))
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    write('skills/video/references/workflow.md', '- Current reference text from the latest recording.\n')
    git('commit', '-q', '-am', 'change reference')
    expect(run('--base', base, '--head', 'HEAD').status).toBe(0)

    write('snapshots/session/video/session.v4.jsonl', read(`- ${sentence}`))
    git('commit', '-q', '-am', 'stale latest generation')
    const stale = run('--base', base, '--head', 'HEAD')
    expect(stale.status).toBe(1)
    expect(stale.stderr).toContain(`snapshots/session/video/session.v4.jsonl: ${JSON.stringify(sentence)} (removed from skills/video/references/workflow.md)`)
    expect(stale.stderr).not.toContain('snapshots/session/retained/')
    expect(stale.stderr).not.toContain('session.v3.jsonl')
  })

  it('accepts text that moved to another source and reads pushed ranges from the pre-push protocol', () => {
    const { git, write, run } = repository()
    write('skills/format/SKILL.md', `- ${sentence}\n`)
    write('snapshots/session/screenplay/system-prompt.expected.md', `- ${sentence}\n`)
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    write('skills/format/SKILL.md', '- Unrelated replacement text for this skill file.\n')
    write('skills/shared/SKILL.md', `- ${sentence}\n`)
    git('add', '.')
    git('commit', '-q', '-m', 'move text')
    expect(run('--base', base, '--head', 'HEAD').status).toBe(0)

    // A scenario may load a retired copy from a test fixture; that copy still supplies the text.
    write('skills/shared/SKILL.md', '- Different shared text that replaced the moved sentence.\n')
    write('skills/shared/tests/fixtures/retired/SKILL.md', `- ${sentence}\n`)
    git('add', '.')
    git('commit', '-q', '-m', 'retire moved text to a fixture')
    expect(run('--base', base, '--head', 'HEAD').status).toBe(0)

    git('rm', '-q', 'skills/shared/tests/fixtures/retired/SKILL.md')
    git('commit', '-q', '-m', 'drop moved text')
    const head = git('rev-parse', 'HEAD')
    const push = (input: string): SpawnSyncReturns<string> => spawnSync(process.execPath, [script, '--pre-push'], {
      cwd: git('rev-parse', '--show-toplevel'), encoding: 'utf8', timeout: 60_000, input,
    })
    const zero = '0'.repeat(40)
    const updated = push(`refs/heads/main ${head} refs/heads/main ${base}\nrefs/heads/gone ${zero} refs/heads/gone ${base}\n`)
    expect(updated.signal).toBeNull()
    expect(updated.status).toBe(1)
    expect(updated.stderr).toContain(`${JSON.stringify(sentence)} (removed from skills/format/SKILL.md)`)
    expect(updated.stderr).toContain('a passing owning replay needs no refresh')
    const warning = spawnSync(process.execPath, [script, '--pre-push', '--warn-only'], {
      cwd: git('rev-parse', '--show-toplevel'), encoding: 'utf8', timeout: 60_000,
      input: `refs/heads/main ${head} refs/heads/main ${base}\n`,
    })
    expect(warning.error).toBeUndefined()
    expect(warning.signal).toBeNull()
    expect(warning.status).toBe(0)
    expect(warning.stderr).toContain('snapshots/session/screenplay/system-prompt.expected.md')

    // A new branch checks only the commits no remote-tracking ref contains.
    git('update-ref', 'refs/remotes/origin/main', base)
    expect(push(`refs/heads/topic ${head} refs/heads/topic ${zero}\n`).status).toBe(1)
    git('update-ref', 'refs/remotes/origin/main', head)
    expect(push(`refs/heads/topic ${head} refs/heads/topic ${zero}\n`).status).toBe(0)
  })

  it('treats snapshot workspace seeds as sources and recorded output as never sourcing itself', () => {
    const { git, write, run } = repository()
    const read = (text: string): string => `${JSON.stringify({ type: 'tool/result', result: { content: [{ type: 'text', text }] } })}\n`
    write('packages/editing/skills/compose/SKILL.md', `- ${sentence}\n`)
    write('snapshots/session/seeded/workspace/.dsh/skills/compose/SKILL.md', `- ${sentence}\n`)
    write('snapshots/session/seeded/session.v4.jsonl', read(`- ${sentence}`))
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    write('packages/editing/skills/compose/SKILL.md', '- Rewritten guidance for composing workspaces.\n')
    git('commit', '-q', '-am', 'rewrite packaged skill')
    expect(run('--base', base, '--head', 'HEAD').status).toBe(0)

    git('rm', '-q', 'snapshots/session/seeded/workspace/.dsh/skills/compose/SKILL.md')
    git('commit', '-q', '-m', 'drop the seed')
    expect(run('--base', base, '--head', 'HEAD').status).toBe(1)
  })
})
