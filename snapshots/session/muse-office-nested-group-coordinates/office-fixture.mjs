/** Nested PowerPoint coordinates pass through the shipped Office CLI and Session log. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { unzipSync, zipSync } from 'fflate'
import { defineTool } from '@deepseek-ai/dsh-tools'

const runFile = promisify(execFile)
const botRoot = fileURLToPath(new URL('../../../third_party/plugins/ds-bot/', import.meta.url))
const EMU = 914400

/** Loader identity for the isolated Office inspection conversation. */
export const name = 'snapshot-office-nested-group-coordinates'
/** Services used by the inspection tool and model-request assertions. */
export const inject = ['tools', 'llm', 'sessions', 'agents']

const transform = (x, y, width, height) => `<a:xfrm><a:off x="${x * EMU}" y="${y * EMU}"/><a:ext cx="${width * EMU}" cy="${height * EMU}"/><a:chOff x="0" y="0"/><a:chExt cx="${EMU}" cy="${EMU}"/></a:xfrm>`
const textShape = (id, name, x) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x * EMU}" y="0"/><a:ext cx="${EMU / 4}" cy="${EMU / 4}"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>${name}</a:t></a:r></a:p></p:txBody></p:sp>`

async function inspect(file, operation, expectedCode) {
  let stdout, stderr, code = 0
  try {
    const result = await runFile(process.execPath,
      [join(botRoot, 'office.js'), 'pptx', operation, file, '--slides', '1', '--json'],
      { encoding: 'utf8', timeout: 10000 })
    stdout = result.stdout
    stderr = result.stderr
  } catch (error) {
    assert.equal(error.killed, false, 'The CLI must settle without timeout or cancellation')
    assert.equal(error.signal, null)
    code = error.code
    stdout = error.stdout
    stderr = error.stderr
  }
  assert.equal(code, expectedCode)
  assert.equal(stderr, '')
  const result = JSON.parse(stdout)
  assert.equal(result.ok, true)
  return result.data
}

/**
 * Inspect two nested shapes in an isolated package and preserve the actual result.
 * @param ctx - Headless Loader context owning the tool and temporary package.
 * @returns Completion after fixture registration.
 */
export async function apply(ctx) {
  const root = await mkdtemp(join(tmpdir(), 'muse-keyless-office-groups-'))
  ctx.effect(() => () => rm(root, { recursive: true, force: true }))
  let ran = false, visibleResult = false, resultText
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'snapshot_office_nested_coordinates',
    description: 'Inspect nested PowerPoint group coordinates and distinguish a real off-slide shape using the local Office CLI.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() {
      assert.equal(ran, false)
      ran = true
      try {
        const parts = unzipSync(await readFile(join(botRoot, 'test/fixtures/office/sample.pptx')))
        parts['ppt/slides/slide1.xml'] = Buffer.from(`<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:grpSp><p:nvGrpSpPr><p:cNvPr id="10" name="outer"/></p:nvGrpSpPr><p:grpSpPr>${transform(5, 1, 2, 1)}</p:grpSpPr><p:grpSp><p:nvGrpSpPr><p:cNvPr id="11" name="inner"/></p:nvGrpSpPr><p:grpSpPr>${transform(1, 0.5, 2, 2)}</p:grpSpPr>${textShape(12, 'inside', 0)}${textShape(13, 'outside', 1)}</p:grpSp></p:grpSp></p:spTree></p:cSld></p:sld>`)
        const file = join(root, 'nested.pptx')
        await writeFile(file, zipSync(parts))
        const inventory = await inspect(file, 'inventory', 0)
        const layout = await inspect(file, 'layout', 1)
        const boxes = inventory.slides[0].shapes.filter(shape => ['inside', 'outside'].includes(shape.name))
          .map(shape => ({ name: shape.name, box: shape.box }))
        assert.deepEqual(boxes, [
          { name: 'inside', box: { x: 7, y: 1.5, w: 1, h: 0.5 } },
          { name: 'outside', box: { x: 11, y: 1.5, w: 1, h: 0.5 } },
        ])
        assert.deepEqual(layout.findings, [
          { slide: 1, rule: 'off-slide', shape: 'outside', box: { x: 11, y: 1.5, w: 1, h: 0.5 } },
        ])
        await rm(root, { recursive: true, force: true })
        await assert.rejects(stat(root), { code: 'ENOENT' })
        resultText = JSON.stringify({
          slideSize: inventory.slideSize, boxes, findings: layout.findings,
          cliExitCodes: { inventory: 0, layout: 1 }, temporaryRootRemoved: true,
        })
        return resultText
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  })))
  ctx.on('llm/stream', async function* (options, next) {
    assert.ok(options.tools.some(tool => tool.name === 'snapshot_office_nested_coordinates'))
    for (const message of options.messages) {
      if (message.role !== 'tool' || message.toolCallId !== 'call_office_nested_coordinates') continue
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      assert.equal(text, resultText)
      visibleResult = true
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', ({ agent }) => {
    const events = agent.session.snapshotEvents()
    const results = events.filter(event => event.type === 'tool/result')
    assert.equal(results.length, 1)
    assert.equal(results[0].data.message.isError, false, JSON.stringify(results[0].data.message.content))
    assert.deepEqual(results[0].data.message.content, [{ type: 'text', text: resultText }])
    assert.equal(ran, true)
    assert.equal(visibleResult, true, 'The actual Office CLI result must reach the next model request')
    assert.deepEqual(events.filter(event => event.type === 'assistant/message').at(-1).data.message.content,
      [{ type: 'text', text: 'The inside shape is at (7, 1.5) inches and remains on the slide. Only the outside shape is off-slide.' }])
  })
}
