/** Workspace credential precedence, bounded lookup and live edits. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workspaceJubianClient, workspacePipelineToken } from '../src/workspace.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(body: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'jubian-workspace-'))
  roots.push(root)
  await mkdir(join(root, '.agents/secrets'), { recursive: true })
  await writeFile(join(root, '.agents/secrets/pipeline.env'), body)
  return root
}

describe('workspacePipelineToken', () => {
  it('reads the nearest readable file and prefers an admin value over the legacy value', async () => {
    const root = await fixture('JUBIANAI_TOKEN=legacy\nJUBIANAI_ADMIN_TOKEN="admin"\n')
    const child = join(root, 'project')
    await mkdir(child)
    expect(await workspacePipelineToken(child)).toBe('admin')
    await mkdir(join(child, '.agents/secrets'), { recursive: true })
    await writeFile(join(child, '.agents/secrets/pipeline.env'), "JUBIANAI_ADMIN_TOKEN=''\nJUBIANAI_TOKEN='nearest'\n")
    expect(await workspacePipelineToken(child)).toBe('nearest')
    await writeFile(join(child, '.agents/secrets/pipeline.env'), 'UNRELATED=value\n')
    expect(await workspacePipelineToken(child)).toBe('')
  })

  it('continues past an unreadable file and stops after twelve directories', async () => {
    const root = await fixture('JUBIANAI_TOKEN=parent\n')
    const child = join(root, 'child')
    await mkdir(join(child, '.agents/secrets/pipeline.env'), { recursive: true })
    expect(await workspacePipelineToken(child)).toBe('parent')
    const eleven = join(root, ...Array.from({ length: 11 }, (_, index) => `level-${index}`))
    await mkdir(join(eleven, 'last'), { recursive: true })
    expect(await workspacePipelineToken(eleven)).toBe('parent')
    expect(await workspacePipelineToken(join(eleven, 'last'))).toBe('')
  })
})

describe('workspaceJubianClient', () => {
  it('uses the credential store first, honors disabled workspace secrets and reads live changes', async () => {
    const root = await fixture('JUBIANAI_TOKEN=workspace-a\n')
    const authorization: string[] = []
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      authorization.push(new Headers(init?.headers).get('Authorization') ?? '')
      return new Response('{"code":200,"data":{}}')
    }
    const credential = vi.fn(async () => 'stored')
    const subject = workspaceJubianClient({ credential, fetch }, true, root)
    await subject.request({ method: 'GET', path: '/fixture' })
    credential.mockResolvedValue(' ')
    await subject.request({ method: 'GET', path: '/fixture' })
    await writeFile(join(root, '.agents/secrets/pipeline.env'), 'JUBIANAI_TOKEN=workspace-b\n')
    await subject.request({ method: 'GET', path: '/fixture' })
    await expect(workspaceJubianClient({ credential, fetch }, false, root)
      .request({ method: 'GET', path: '/fixture' })).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' })
    expect(authorization).toEqual(['Bearer stored', 'Bearer workspace-a', 'Bearer workspace-b'])
    expect(credential).toHaveBeenCalledTimes(4)
  })
})
