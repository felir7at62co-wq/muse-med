/** Execute the capture preparation guard without replaying or rewriting any Session. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const require = createRequire(join(root, 'apps/desktop/package.json'))
const yaml = require('js-yaml') as { load(value: string): unknown }
const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

interface CaptureGroup {
  id: string
  expectedTests: number
  expectedCanonicalPaths: string[]
  expectedInputInventory: string[]
  replay: { expectedTests: number }
}
interface CapturePlan { groups: CaptureGroup[] }
interface CaptureWorkflow { jobs: { capture: { steps: { id?: string; run?: string }[] } } }
const workflow = yaml.load(await readFile(join(root, '.github/workflows/linux-snapshot-capture.yml'), 'utf8')) as CaptureWorkflow
const plan = JSON.parse(await readFile(join(root, '.github/workflows/linux-snapshot-capture-plan.json'), 'utf8')) as CapturePlan
const run = workflow.jobs.capture.steps.find(step => step.id === 'baseline')?.run
if (run === undefined) throw new Error('Capture baseline is missing')
const baseline = run.split("node --input-type=module <<'NODE'\n")[1]?.split('\nNODE')[0]
if (baseline === undefined) throw new Error('Capture baseline Node program is missing')
const declaration = "const plan = JSON.parse(readFileSync('.github/workflows/linux-snapshot-capture-plan.json', 'utf8'))"
if (!baseline.includes(declaration)) throw new Error('Capture plan declaration changed')

async function hashes(paths: readonly string[]) {
  return await Promise.all(paths.map(async path => [path,
    createHash('sha256').update(await readFile(join(root, path))).digest('hex')] as const))
}

// All cases read one immutable repository baseline. Re-reading it before each
// case would duplicate the full inventory read already done by preparation.
const inputBaseline = new Map(await hashes([...new Set(plan.groups.flatMap(group => group.expectedInputInventory))]))

async function prepare(group: CaptureGroup, mutation = '', differentTemp = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-capture-plan-')); temporary.push(directory)
  // This fixture supplies only the already-completed probe receipt consumed by preparation.
  // The real workflow runs the separate native write/denial probe before this guard.
  await writeFile(join(directory, 'muse-linux-sandbox-probe.json'), JSON.stringify({
    enforcement: 'full', workspaceWrite: true, outsideWriteDenied: true,
  }))
  const before = group.expectedInputInventory.map(path => [path, inputBaseline.get(path)] as const)
  const source = baseline!.replace(declaration, declaration + '\n' + mutation)
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: root, env: { ...process.env, RUNNER_TEMP: directory,
      TEMP: directory, TMP: directory,
      TMPDIR: differentTemp ? join(directory, 'different') : directory, SNAPSHOT_CAPTURE_GROUP: group.id },
    encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
  })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(await hashes(group.expectedInputInventory)).toEqual(before)
  return { result, directory }
}

it.each(plan.groups)('accepts only the complete immutable input inventory for $id', async (group) => {
  const { result, directory } = await prepare(group)
  expect(result.status, result.stderr).toBe(0)
  const receipt = JSON.parse(await readFile(join(directory, 'muse-linux-snapshot-inputs.json'), 'utf8')) as {
    spec: CaptureGroup
    identities: Record<string, unknown>
  }
  expect(receipt.spec).toEqual(group)
  expect(Object.keys(receipt.identities).sort()).toEqual([...group.expectedInputInventory].sort())
})

const selected = plan.groups.find(group => group.id === 'remaining-legacy-writers')
if (selected === undefined) throw new Error('Legacy writer group is missing')
it.each([
  ['an added replay filter', "plan.groups[1].replay.filter += '|unapproved'"],
  ['an omitted protected input', 'plan.groups[1].expectedInputInventory.pop()'],
  ['an omitted managed assertion helper', `{
    const g = plan.groups[1], path = 'snapshots/session/managed-subagent-assertions.ts';
    g.extraInputs = g.extraInputs.filter(p => p !== path);
    g.expectedInputInventory = g.expectedInputInventory.filter(p => p !== path);
  }`],
  ['a missing managed child replay declaration', `{
    const g = plan.groups[1], path = 'snapshots/session/subagent-agent-preset/snapshot.yml';
    delete g.expectedManifests[path].replay;
  }`],
  ['a canonical output', 'plan.groups[1].allowedOutputs[0] = plan.groups[1].expectedCanonicalPaths[0]'],
  ['an invalid new child filename', `{
    const g = plan.groups[1], from = g.newOutputs.find(p => p.endsWith('/writer.1.expected.jsonl'));
    if (!from) throw new Error('Child writer fixture is missing');
    const to = from.replace('writer.1.', 'writer.01.');
    g.newOutputs = g.newOutputs.map(p => p === from ? to : p);
    g.allowedOutputs = g.allowedOutputs.map(p => p === from ? to : p);
    for (const phase of g.phases) phase.outputs = phase.outputs.map(p => p === from ? to : p);
  }`],
] as const)('rejects %s without changing any protected input', async (_label, mutation) => {
  const { result } = await prepare(selected, mutation)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('AssertionError')
})

it('rejects a different temporary root instead of adjusting measured token counts', async () => {
  const { result } = await prepare(selected, '', true)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('Capture and normal CI must use runner-owned temporary storage')
})

it('rejects changed retained-format declarations without touching the retained Sessions', async () => {
  const group = plan.groups.find(value => value.id === 'retained-tools-writers')
  if (group === undefined) throw new Error('Retained format group is missing')
  const { result } = await prepare(group, `{
    const g = plan.groups.find(value => value.id === 'retained-tools-writers');
    const path = g.owners[0].dir + '/snapshot.yml';
    g.expectedManifests[path].sessionFormat.coverage = ['adjacent-migration'];
  }`)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('Manifest drifted')
})
