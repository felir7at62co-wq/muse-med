import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { JingliuSession, LocalMedia } from '@deepseek-ai/dsh-jingliu-connection'
import type { ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { installDraft } from '../src/delivery.ts'
import { workflowTools } from '../src/index.ts'

async function temporary(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  onTestFinished(async () => { await rm(dir, { recursive: true, force: true }) })
  return dir
}

function pack(materials: { name: string; url: string; size: number }[]) {
  const content = { tracks: [{ type: 'video', segments: [{ id: 's' }] }], materials: { videos: materials.map(m => ({ path: '__SFMAT__/' + m.name })) } }
  return Buffer.from(zipSync({
    'pack/manifest.json': strToU8(JSON.stringify({ drafts: [{ name: '第1集' }], materials, mat_token: '__SFMAT__', draft_token: '__SFDRAFT__', root_token: '__SFROOT__' })),
    'pack/drafts/第1集/draft_content.json': strToU8(JSON.stringify(content)),
    'pack/drafts/第1集/draft_meta_info.json': strToU8(JSON.stringify({ draft_name: '' })),
  }))
}

// A studio session whose `download` stores files under the given folder, as a desktop Host's does.
function session(files: Record<string, Buffer>, archive: Buffer) {
  const media = vi.fn<NonNullable<JingliuSession['media']>>(async (path, _signal, consume) => {
    await consume(new Response(new Uint8Array(path.endsWith('.zip') ? archive : files[path] ?? Buffer.alloc(0))))
  })
  const download = vi.fn(async (paths: readonly string[], folder: string) => {
    const result = new Map<string, LocalMedia>()
    for (const path of paths) {
      const canonical = path.replace(/^\/fwp\//u, '/fw/')
      const file = join(folder, canonical.slice('/fw/media/'.length))
      await mkdir(join(file, '..'), { recursive: true })
      await writeFile(file, files[canonical] ?? Buffer.alloc(0))
      result.set(canonical, { path: canonical, file, size: (files[canonical] ?? Buffer.alloc(0)).length, contentType: 'video/mp4' })
    }
    return result
  })
  const place = vi.fn(async (file: LocalMedia, target: string) => { await writeFile(target, await readFile(file.file), { flag: 'wx' }) })
  return { media, download, place }
}

it('downloads draft materials once into the production folder and fills their paths into the draft', async () => {
  const root = await temporary('jianying-root-')
  const workspace = await temporary('jingliu-workspace-')
  const shot = Buffer.from('shot video')
  const materials = [{ name: 'a.mp4', url: '/fw/media/generated/a.mp4', size: shot.length }]
  const fake = session({ '/fw/media/generated/a.mp4': shot }, pack(materials))
  const studio: JingliuSession = { identity: 'u', request: vi.fn(), ...fake }
  const folder = join(workspace, 'jingliu', 'p1')
  const result = { url: '/fw/media/exports/jianying/p.zip', shots: 1, materials: 1 }
  const receipt = await installDraft(studio, result, root, 'session:call', new AbortController().signal, folder)
  expect(fake.download).toHaveBeenCalledWith(['/fw/media/generated/a.mp4'], folder, expect.any(AbortSignal))
  expect(fake.media.mock.calls.map(([path]) => path)).toEqual(['/fw/media/exports/jianying/p.zip'])
  const draft = String(receipt.path)
  expect(await readFile(join(draft, 'media', 'a.mp4'))).toEqual(shot)
  expect(await readFile(join(folder, 'generated', 'a.mp4'))).toEqual(shot)
  const content = JSON.parse(await readFile(join(draft, 'draft_content.json'), 'utf8')) as { materials: { videos: { path: string }[] } }
  expect(content.materials.videos[0]?.path).toBe(join(draft, 'media').split('\\').join('/') + '/a.mp4')
  expect(receipt).toMatchObject({ materials: 1, bytes: shot.length })
  expect((await readdir(root)).filter(name => name.startsWith('.muse-draft-'))).toEqual([])
})

it('streams draft materials into the draft when the session keeps no local files, and rejects a wrong size', async () => {
  const root = await temporary('jianying-root-')
  const shot = Buffer.from('shot video')
  const materials = [{ name: 'a.mp4', url: '/fwp/media/generated/a.mp4', size: shot.length }]
  const { media } = session({ '/fwp/media/generated/a.mp4': shot }, pack(materials))
  const result = { url: '/fw/media/exports/jianying/p.zip', shots: 1, materials: 1 }
  const receipt = await installDraft({ identity: 'u', request: vi.fn(), media }, result, root, 'session:call', new AbortController().signal, join(root, 'unused'))
  expect(await readFile(join(String(receipt.path), 'media', 'a.mp4'))).toEqual(shot)
  await expect(stat(join(root, 'unused'))).rejects.toMatchObject({ code: 'ENOENT' })
  const wrong = session({ '/fw/media/generated/a.mp4': Buffer.from('short') }, pack([{ ...materials[0]!, url: '/fw/media/generated/a.mp4' }]))
  await expect(installDraft({ identity: 'u', request: vi.fn(), ...wrong }, result, root, 'session:other', new AbortController().signal, join(root, 'm')))
    .rejects.toMatchObject({ code: 'JINGLIU_INVALID_DRAFT' })
})

const allow = () => vi.fn(async (_exec: ToolRunContext, _reason: string) => true)

function tool(studio: JingliuSession, approve = allow(), cwd: string | null = '/work') {
  const tools = workflowTools({ connect: async () => studio, approve, selected: async () => ({ id: 'p1', title: '雨夜' }) })
  const definition = tools.find(entry => entry.name === 'jingliu_media')!
  return (args: Record<string, unknown>) => {
    const id = ToolCallId('call-1')
    const ctx: ToolRunContext = {
      callId: id, rootCallId: id, token: Symbol() as ToolExecutionToken, arguments: args, name: 'jingliu_media',
      agent: { session: { id: 'session-9', header: { cwd: cwd ?? undefined } } } as ToolRunContext['agent'] & object,
      signal: new AbortController().signal, deferContext() {}, concludeTurn() {},
    }
    return definition.execute(args, ctx)
  }
}

it('downloads studio files into the project folder only on a Host that keeps local files', async () => {
  const workspace = await temporary('jingliu-workspace-')
  const fake = session({ '/fw/media/generated/a.png': Buffer.from('png') }, Buffer.alloc(0))
  const call = tool({ identity: 'u', request: vi.fn(), ...fake }, undefined, workspace)
  await expect(call({ action: 'download', paths: ['/fwp/media/generated/a.png'] })).resolves.toEqual({ project_id: 'p1', files: [
    { path: '/fw/media/generated/a.png', file: join(workspace, 'jingliu', 'p1', 'generated', 'a.png'), size: 3, content_type: 'video/mp4' },
  ] })
  await expect(call({ action: 'download', project_id: 'p2', paths: ['/fw/media/generated/a.png'] })).rejects.toMatchObject({ code: 'JINGLIU_INVALID_PROJECT' })
  await expect(call({ action: 'download', paths: [] })).rejects.toMatchObject({ code: 'JINGLIU_INVALID_ARGUMENTS' })
  const web = tool({ identity: 'u', request: vi.fn(), media: fake.media })
  await expect(web({ action: 'download', paths: ['/fw/media/generated/a.png'] })).rejects.toMatchObject({ code: 'JINGLIU_MEDIA_LOCAL_DISABLED' })
})

it('uploads a workspace file only after the user approves it', async () => {
  const upload = vi.fn(async () => ({ path: '/fw/media/uploads/u1.png', size: 3 }))
  const approve = vi.fn(async (_exec: ToolRunContext, _reason: string) => false)
  const call = tool({ identity: 'u', request: vi.fn(), upload }, approve)
  await expect(call({ action: 'upload', file: 'faces/a.png' })).rejects.toMatchObject({ code: 'JINGLIU_APPROVAL_REQUIRED' })
  expect(upload).not.toHaveBeenCalled()
  approve.mockResolvedValueOnce(true)
  await expect(call({ action: 'upload', file: 'faces/a.png' })).resolves.toEqual({ path: '/fw/media/uploads/u1.png', size: 3, file: join('/work', 'faces', 'a.png') })
  expect(upload).toHaveBeenCalledWith(join('/work', 'faces', 'a.png'), 'p1', expect.any(AbortSignal))
  expect(approve.mock.calls.at(-1)?.[1]).toContain(join('/work', 'faces', 'a.png'))
  await expect(call({ action: 'upload' })).rejects.toMatchObject({ code: 'JINGLIU_INVALID_ARGUMENTS' })
  await expect(tool({ identity: 'u', request: vi.fn(), upload }, approve, null)({ action: 'upload', file: 'a.png' })).rejects.toMatchObject({ code: 'JINGLIU_WORKSPACE_REQUIRED' })
})

it('returns the studio export result instead of installing a draft on a Host that keeps no local media', async () => {
  const exporter = { name: 'export_jianying', description: '导出剪映', role: 'editor', risk: 'read', account_scoped: false, costs: false,
    long_running: false, needs_confirm: false, parameters: { type: 'object', properties: { project_id: { type: 'string' } } } }
  const request = vi.fn<JingliuSession['request']>()
  request.mockResolvedValueOnce({ count: 1, tools: [exporter] }).mockResolvedValueOnce({ ok: true, url: '/fw/media/exports/jianying/p.zip', shots: 1 })
  const draftRoot = vi.fn(async () => '/drafts')
  const tools = workflowTools({ connect: async () => ({ identity: 'u', request }), approve: async () => true, draftRoot })
  const id = ToolCallId('call-1')
  const args = { workflow: 'export_jianying', project_id: 'p1' }
  const ctx: ToolRunContext = {
    callId: id, rootCallId: id, token: Symbol() as ToolExecutionToken, arguments: args, name: 'jingliu_run',
    agent: { session: { id: 'session-9', header: { cwd: '/work' } } } as ToolRunContext['agent'] & object,
    signal: new AbortController().signal, deferContext() {}, concludeTurn() {},
  }
  await expect(tools.find(entry => entry.name === 'jingliu_run')!.execute(args, ctx)).resolves.toMatchObject({ result: { url: '/fw/media/exports/jianying/p.zip' } })
  expect(draftRoot).not.toHaveBeenCalled()
  expect(JSON.stringify(request.mock.calls.at(-1)?.[1]?.body)).not.toContain('single_file')
})
