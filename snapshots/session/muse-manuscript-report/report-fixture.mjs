/** Complete default-budget review groups, nested evidence, and stale cursors through the real headless tools. */
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

const revisions = await importSnapshotModule(
  new URL('../../../apps/desktop-host/src/manuscript-revisions.ts', import.meta.url),
  new URL('../../../apps/desktop-host/lib/manuscript-revisions.js', import.meta.url))
export const name = 'manuscript-report-fixture'
export const inject = ['tools']

function text(blocks) { return blocks.filter(block => block.type === 'text').map(block => block.text).join('\n') }

/** @param {import('@deepseek-ai/cordis').Context} ctx - Isolated shipped headless profile. */
export async function apply(ctx) {
  await ctx.plugin(revisions).await()
  ctx.effect(() => {
    const previous = globalThis.fetch
    globalThis.fetch = async () => { throw Error('Manuscript report snapshot refuses network access') }
    return () => { globalThis.fetch = previous }
  })
  let owner, cwd, statePath, auditBaseline, visible = false
  const calls = new Map(), results = new Map()
  ctx.on('agent/created', async ({ agent }) => {
    owner = agent
    cwd = await realpath(agent.session.header.cwd)
    statePath = join(cwd, '.muse', 'manuscript-work')
  })
  ctx.on('session/event', (session, event) => {
    if (session.id !== owner?.id) return
    if (event.type === 'tool/call') calls.set(event.data.callId, event.data)
    if (event.type === 'tool/result') results.set(event.data.message.toolCallId, event.data.message)
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (results.has('call_audit')) {
      const stateFiles = await readdir(statePath)
      const bytes = await readFile(join(statePath, stateFiles[0], 'state.json'))
      if (!auditBaseline) auditBaseline = bytes
      if (!results.has('call_event')) assert.deepEqual(bytes, auditBaseline, 'Audit paging must not advance saved baselines')
    }
    if (results.has('call_final_audit')) {
      for (const [id, result] of results) {
        if (calls.get(id)?.name !== 'manuscript_work' || result.isError) continue
        assert.ok(options.messages.some(message => message.role === 'tool' && message.toolCallId === id
          && text(message.content) === text(result.content)), 'Every complete page must reach the actual model request')
      }
      visible = true
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    assert.equal(agent, owner)
    assert.ok(visible)
    const decoded = new Map()
    for (const [id, result] of results) {
      if (calls.get(id)?.name !== 'manuscript_work') continue
      if (id === 'call_stale') {
        assert.equal(result.isError, true)
        assert.match(text(result.content), /MANUSCRIPT_REPORT_STALE/u)
        continue
      }
      assert.equal(result.isError, false, `Real manuscript call failed: ${id}`)
      const value = text(result.content)
      assert.ok(value.length <= 8000, `Complete result exceeded the default budget: ${id}`)
      decoded.set(id, JSON.parse(value))
    }
    assert.equal(decoded.get('call_relationship').saved, true)
    assert.equal(decoded.get('call_relationship').report_pending, true)
    const first = decoded.get('call_audit'), final = decoded.get('call_final_audit')
    assert.equal(first.report_paged, true)
    assert.notEqual(final.report_sha256, first.report_sha256)
    assert.equal(JSON.parse(calls.get('call_stale').arguments).report_sha256, first.report_sha256)
    const required = new Map(), pages = new Map()
    const discover = value => {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value.report_sections)) for (const group of value.report_sections) required.set(group.section, group.total_items)
      for (const child of Object.values(value)) {
        if (Array.isArray(child)) child.forEach(discover)
        else if (child && typeof child === 'object') discover(child)
      }
    }
    discover(first)
    let nested = false
    for (const [id, value] of decoded) {
      if (!id.startsWith('call_page_')) continue
      assert.equal(value.report_sha256, first.report_sha256)
      const group = pages.get(value.report_section) ?? []
      group.push(value)
      pages.set(value.report_section, group)
      if (value.items.some(row => row?.report_item_paged)) nested = true
      discover(value)
    }
    assert.ok(nested, 'The large relationship must require a nested collection directory')
    for (const [section, total] of required) {
      const group = pages.get(section)
      assert.ok(group, `Unread report collection: ${section}`)
      let offset = 1
      for (const page of group) {
        assert.equal(page.report_offset, offset)
        offset += page.items.length
        assert.equal(page.continuation?.report_offset ?? null, offset > total ? null : offset)
      }
      assert.equal(offset, total + 1)
    }
    assert.ok(required.has('relationships.0.evidence'))
    assert.ok(required.has('relationships.0.source_contexts'))
    const evidence = pages.get('relationships.0.evidence').flatMap(page => page.items)
    const source = await readFile(new URL('./workspace/source.txt', import.meta.url), 'utf8')
    assert.deepEqual(evidence.map(row => row.quote), source.trimEnd().split('\n').slice(6))
    for (const filename of ['source.txt', 'draft.md']) assert.equal(await readFile(join(cwd, filename), 'utf8'),
      await readFile(new URL(`./workspace/${filename}`, import.meta.url), 'utf8'), 'Manuscript bytes must remain unchanged')
    await writeFile(join(cwd, '_probe.json'), JSON.stringify({ realHeadlessTools: true, defaultBudget: 8000,
      everyDeclaredCollectionRead: true, nestedRelationshipEvidenceRead: true, staleAfterSavedNoteRejected: true,
      completePagesModelVisible: true, auditReadOnly: true, manuscriptBytesUnchanged: true,
      networkAccessAllowed: false, semanticUnderstandingAssessed: false }, null, 2) + '\n')
    const runtime = join(process.env.DSH_HOME, '.runtime-ledgers')
    await mkdir(runtime, { recursive: true, mode: 0o700 })
    await rename(join(cwd, '.muse'), join(runtime, 'manuscript-state'))
  })
}
