/** Built SDK-profile replay of complete required market bindings and immutable version selections. */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { DeepSeekHarness, validatedSessionEvent } from '../src/index.ts'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const CLI = join(ROOT, 'apps/cli/lib/bin.js')
const CASE = join(ROOT, 'snapshots/session/muse-skill-market-version-binding')
const EXPECTED = new URL('./expected/market-binding-runtime.json', import.meta.url)
const INPUT = 'Load the version-bound-review Skill, switch its default publication from version one to version two, '
  + 'load it again in this executed Session, then exercise the blank Session created before the switch and a fresh Session. '
  + 'Observe the full actual Skill results and bindings. Reply exactly SKILL_VERSION_BINDING_VERIFIED.'

/** Match the wire event without adding a market plugin type dependency to the generic SDK. */
function isMarketBinding(event: { readonly type: string }): boolean { return event.type === 'muse-market/bound' }

// This owner consumes built lib entries, including activation.js, through the ordinary public SDK launcher.
it.skipIf(!existsSync(CLI))('retains full required V1 bindings and V2 blank/fresh projections through the real sdk profile', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'sdk-market-binding-'))
  try {
    const home = join(cwd, 'home'), scope = join(home, 'profiles/sdk/node_modules/@deepseek-ai')
    await mkdir(scope, { recursive: true })
    await symlink(join(ROOT, 'packages/test-support/llm-replay'), join(scope, 'dsh-llm-replay'), process.platform === 'win32' ? 'junction' : 'dir')
    const harness = new DeepSeekHarness({
      dshBin: CLI, profile: 'sdk', dshHome: home, cwd, processCwd: cwd,
      patches: [join(CASE, 'cordis.snapshot.yml')],
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
      initializeTimeoutMs: 110_000, requestTimeoutMs: 110_000,
      env: { ...process.env, DEEPSEEK_API_KEY: '', DSH_TELEMETRY_DISABLED: '1', DSH_EXAMPLE_MODE: 'lib',
        DSH_SNAPSHOT: 'replay', DSH_SNAPSHOT_FILE: join(CASE, 'session.v4.jsonl'),
        DSH_SNAPSHOT_CHILD_FILES: [join(CASE, 'session.1.v4.jsonl'), join(CASE, 'session.2.v4.jsonl')].join(delimiter) },
    })
    try {
      const result = await harness.run(INPUT)
      const bindings = result.events.filter(isMarketBinding)
      expect(bindings).toHaveLength(1)
      const firstRequest = result.events.find(event => event.type === 'request/header')
      expect(firstRequest).toBeDefined()
      expect(bindings[0]!.seq).toBeLessThan(firstRequest!.seq)
      const lifecycle: Record<string, unknown> = {}
      const toolResults = result.events.filter(event => event.type === 'tool/result')
      expect(toolResults).toHaveLength(5)
      for (const event of toolResults) {
        expect(event.data.message.isError).not.toBe(true)
        if (!['call_version_2', 'call_version_4', 'call_version_5'].includes(event.data.message.toolCallId)) continue
        const text = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
        lifecycle[event.data.message.toolCallId] = JSON.parse(text)
      }
      for (const event of bindings) {
        expect(event).not.toHaveProperty('ignorable')
        expect(event).not.toHaveProperty('skipped')
        expect(event).not.toHaveProperty('unreported')
      }
      const proof: unknown = JSON.parse(await readFile(join(cwd, 'market-version-proof.json'), 'utf8'))
      const expected: unknown = JSON.parse(await readFile(EXPECTED, 'utf8'))
      const actual = {
        finalResponse: result.finalResponse, finishReason: result.finishReason,
        bindingEvents: bindings.map(event => ({ type: event.type, data: event.data })),
        lifecycle, proof,
      }
      expect(actual).toEqual(expected)
      const rootNotifications = result.notifications.filter(notification => notification.method === 'session.event'
        && notification.params.sessionId === result.sessionId).map(notification => validatedSessionEvent(notification.params.event))
      expect(rootNotifications.filter(isMarketBinding)).toEqual(bindings)
      expect(result.events.filter(event => event.type === 'request/header')).toHaveLength(1)
    } finally { await harness.close() }
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
