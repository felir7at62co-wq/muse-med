/** Bind staged Deep View cards to live native root Sessions on the reviewed Host. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { reviewedHostVersion } from './host-runtime.mjs'

const sourceFiles = Object.freeze({
  'package.json': '5946ec40c81d14e3ec27842280b390f1c778d509b927c542c90d4075568b6be0',
  'src/host/install.js': '501dc0206b9fddd98b6c69f4a43ad9557ef823b0b5671ffe3f40e5fc8c7244a0',
  'test/fake-ctx.js': '776deb6c5c16e3553c2c5e612cce47aa71e7e4365e58f642a348e90a63615fb5',
  'test/host.test.js': '98b86b92328698bcccd47b7cb4b796764aada3f9134e2960f0332ebd218678a1',
})

/** Reviewed adaptation recorded in the packed plugin's SOURCE.json. */
export const deepViewHostCompatibility = Object.freeze({
  hostVersion: reviewedHostVersion,
  sourceFiles,
  dshEngine: `0.2.2-rc.1 || ${reviewedHostVersion}`,
  liveRoot: 'native Registry identity and Session origin',
  answerOwner: 'requested Session identity',
  keylessHostChecks: 'production AgentRegistry, AgentLoop and Sessions',
})

/**
 * Validate retained input bytes and adapt only a private build copy.
 * @param {string} directory Private staging directory containing the copied plugin.
 * @returns {object} Recorded compatibility metadata.
 * @throws When any reviewed source file or replacement anchor differs.
 */
export function applyDeepViewHostCompatibility(directory) {
  const sources = new Map()
  for (const [file, hash] of Object.entries(sourceFiles)) {
    const bytes = readFileSync(join(directory, file))
    if (createHash('sha256').update(bytes).digest('hex') !== hash) {
      throw new Error(`community plugins: Deep View source requires review: ${file}`)
    }
    sources.set(file, bytes.toString('utf8'))
  }
  const edit = (file, before, after) => {
    const source = sources.get(file)
    if (source.split(before).length !== 2) throw new Error(`community plugins: Deep View overlay anchor changed: ${file}`)
    sources.set(file, source.replace(before, after))
  }
  edit('src/host/install.js', '!ctx.agents.roots().includes(agent)', "agent.session.header.origin === 'subagent'")
  edit('src/host/install.js',
    "    if (resolved.agent === undefined) return fail('The conversation is unavailable. Reopen it before answering.', 'deep-view/unavailable')",
    "    if (resolved.agent === undefined || resolved.agent.id !== id || resolved.agent.session.id !== id) return fail('The conversation is unavailable. Reopen it before answering.', 'deep-view/unavailable')")
  edit('test/fake-ctx.js',
    '  const agentsRegistry = { map: new Map(), get(id) { return this.map.get(id) }, roots() { return [...this.map.values()].filter(agent => agent.root !== false) } }',
    '  const agentsRegistry = { map: new Map(), get(id) { return this.map.get(id) } }')
  edit('test/host.test.js', "  const agent = { id: 'a1', root: true,", "  const agent = { id: 's1',")
  edit('test/host.test.js', "session: { id: 's1', get seq()", "session: { id: 's1', header: {}, get seq()")
  edit('test/host.test.js', "  ctx.agentsRegistry.map.set('a1', agent)", "  ctx.agentsRegistry.map.set('s1', agent)")
  edit('test/host.test.js',
    "  const child = { ...fixture.agent, id: 'child', root: false }",
    "  const child = { ...fixture.agent, id: 'child', session: { ...fixture.agent.session, id: 'child', header: { origin: 'subagent' } } }")
  const manifest = JSON.parse(sources.get('package.json'))
  manifest.engines.dsh = `${manifest.engines.dsh} || ${reviewedHostVersion}`
  sources.set('package.json', JSON.stringify(manifest, null, 2) + '\n')
  for (const [file, source] of sources) writeFileSync(join(directory, file), source)
  return deepViewHostCompatibility
}
