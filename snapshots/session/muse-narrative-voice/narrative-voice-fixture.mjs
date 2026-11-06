/** Record a fictional screenplay through the product Muse persona, editing policy and shot compiler. */
import assert from 'node:assert/strict'
import { cp, mkdir, readFile, readdir, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { importSnapshotModule, importSnapshotPackage } from '../muse-fixture-import.mjs'

const [Yaml, Persona, Policy, Guidance, ShotScript] = await Promise.all([
  import(pathToFileURL(createRequire(new URL('../../../apps/desktop-host/package.json', import.meta.url)).resolve('yaml')).href),
  importSnapshotPackage('@deepseek-ai/dsh-persona', new URL('../../../apps/cli/package.json', import.meta.url)),
  importSnapshotModule(new URL('../../../apps/desktop-host/src/editing-policy.ts', import.meta.url),
    new URL('../../../apps/desktop-host/lib/editing-policy.js', import.meta.url)),
  importSnapshotModule(new URL('../../../apps/desktop-host/src/short-drama-guidance.ts', import.meta.url),
    new URL('../../../apps/desktop-host/lib/short-drama-guidance.js', import.meta.url)),
  importSnapshotModule(new URL('../../../packages/drama/tool-shot-script/src/index.ts', import.meta.url),
    new URL('../../../packages/drama/tool-shot-script/lib/index.js', import.meta.url)),
])
const preset = Yaml.parse(await readFile(new URL('../../../apps/desktop-host/presets/short-drama/agent.cordis.yml', import.meta.url), 'utf8'),
  { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] })
const persona = preset.find(row => row.id === 'persona')
assert.ok(persona?.config?.prefix, 'The product short-drama persona must exist')

export const name = 'narrative-voice-fixture'
export const inject = ['tools', 'systemPrompt', 'llm']

/** Mount real product instructions and the offline advisory compiler without video submission tools. */
export function apply(ctx) {
  ctx.on('agent/created', async ({ agent }) => {
    assert.deepEqual(await readFile(join(agent.session.header.cwd, 'director-format.md')),
      await readFile(new URL('../../../packages/drama/skills/skills/tweet-drama-early-shot-script/references/director-format.md', import.meta.url)),
      'The recording reads the current product director-format reference byte-for-byte')
    await agent.ctx.plugin(Persona, persona.config).await()
    await agent.ctx.plugin(Policy).await()
    await agent.ctx.plugin(Guidance).await()
    await agent.ctx.plugin(ShotScript, { reviewMode: 'advisory', sessionVideoSelection: false, productionPackaging: false }).await()
    agent.ctx.effect(() => agent.ctx.tools.restrict({ futureAllow: ['read', 'write', 'drama_shot'], includeOwn: true }))
  })
  ctx.on('llm/stream', async function* (options, next) {
    const system = options.messages.filter(message => message.role === 'system')
      .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n')
    assert.ok(system.includes(persona.config.prefix.trim()), 'The exact current short-drama persona reaches the model')
    assert.ok(system.includes(Policy.NARRATIVE_VOICE_GUIDANCE), 'Shared narrative-voice guidance reaches the model')
    assert.ok(options.tools.some(tool => tool.name === 'drama_shot'), 'The actual shot compiler is available')
    assert.ok(options.tools.every(tool => ['read', 'write', 'drama_shot'].includes(tool.name)), 'Only local screenplay operations are available')
    yield* next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const cwd = agent.session.header.cwd
    const review = JSON.parse(await readFile(join(cwd, 'shot_reviews', '01', 'review.json'), 'utf8'))
    assert.equal(review.review_mode, 'advisory')
    assert.ok(review.shots.length >= 6 && review.shots.length <= 8, 'The six fictional passages produce the requested shot range')
    assert.ok(review.packages.length > 0, 'The real compiler produced video prompts')
    assert.equal(await readFile(join(cwd, 'shot_reviews', '01', 'shot_script.txt'), 'utf8'),
      await readFile(join(cwd, 'director.txt'), 'utf8'), 'The compiled source copy is byte-identical')
    assert.equal(await realpath(review.script), await realpath(join(cwd, 'director.txt')))
    assert.equal(await realpath(review.assets_manifest), await realpath(join(cwd, 'assets_manifest.json')))
    assert.deepEqual(await Promise.all(review.written.map(path => realpath(path))),
      await Promise.all([join(cwd, 'shot_reviews', '01', 'shot_script.txt'), join(cwd, 'shot_reviews', '01', 'review.json')].map(path => realpath(path))))
    for (const entry of ['episodes/01.txt', 'assets_manifest.json', 'director-format.md']) {
      assert.deepEqual(await readFile(join(cwd, entry)), await readFile(new URL(`./workspace/${entry}`, import.meta.url)),
        `The original fictional input ${entry} is unchanged`)
    }
    const capture = process.env.DSH_NARRATIVE_VOICE_CAPTURE
    if (process.env.DSH_SNAPSHOT === 'record' && capture) {
      await mkdir(capture, { mode: 0o700 })
      for (const entry of await readdir(cwd)) {
        if (['.agents', '.dsh', '.snapshot-patches'].includes(entry)) continue
        await cp(join(cwd, entry), join(capture, entry), { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
      }
    }
  })
}
