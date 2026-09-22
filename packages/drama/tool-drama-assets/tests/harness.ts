/**
 * Fixtures shared by this package's specs: the project tree, the manifest, the
 * provider pages the remote reads answer with, and the plugin context.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { JubianClient } from '@deepseek-ai/dsh-jubian'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** The token every stub transport answers with; it never leaves the test. */
const TOKEN = 'stub-token'

/** One asset row as `/aigc/asset/list` answers it, with only the fields this comparison reads. */
export interface AssetFixture {
  id: number
  delFlag?: string
  assetName?: string
  assetType?: number
  url?: string
  createTime?: string
}

/** One material row as `/aigc/material/list` answers it. */
export interface MaterialFixture {
  id: number
  assetId?: number | null
  /** The material's own name field, which the reader prefers over `assetName`. */
  name?: string
  assetName?: string
  assetType?: number
  isUsed?: number
  hsAssetStatus?: string
  assetUrl?: string
  createTime?: string
}

/** One page the stub transport answers, and the record of every path it was asked for. */
export interface StubTransport {
  /** The client the tool under test sends its reads through. */
  readonly client: JubianClient
  /** Every request path the client asked for, in order. */
  readonly calls: string[]
  /** Every request method the client used, in order. */
  readonly methods: string[]
}

/**
 * Build a transport that answers the two list endpoints from fixtures.
 *
 * The asset list pages exactly as the provider does: rows are sliced, and the
 * response declares the fixture's own length as its total.
 * @param assets - Every asset row the project holds.
 * @param materials - Every material row the project holds.
 * @param options - Per-list overrides: a declared `total`, or a `rows` value that is not
 *   the list a reader expects.
 * @returns The client plus the record of what it was asked for.
 */
export function stubTransport(assets: AssetFixture[], materials: MaterialFixture[],
  options: { assetTotal?: number; assetRows?: unknown } = {}): StubTransport {
  const calls: string[] = []
  const methods: string[] = []
  const client = new JubianClient({
    credential: async () => TOKEN,
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const path = (url as URL).toString()
      calls.push(path)
      methods.push(String(init?.method))
      if (path.includes('/aigc/asset/list')) {
        const pageNum = Number(/pageNum=(\d+)/.exec(path)?.[1] ?? 1)
        return new Response(JSON.stringify({ code: 200, data: {
          total: options.assetTotal ?? assets.length,
          rows: options.assetRows ?? assets.slice((pageNum - 1) * 1000, pageNum * 1000),
        } }), { status: 200 })
      }
      if (path.includes('/aigc/material/list')) {
        return new Response(JSON.stringify({ code: 200, data: { total: materials.length, rows: materials } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 200, data: { total: 0, rows: [] } }), { status: 200 })
    },
  })
  return { client, calls, methods }
}

/** The manifest one project holds, with the ids and records a spec cares about. */
export function manifestDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 4,
    script_id: 2708,
    items: [
      { stable_id: 'char_lu', type: 'character', name: '陆沉舟', jubian_asset_id: 125204 },
      { stable_id: 'prop_box', type: 'prop', name: '公文箱', jubian_asset_id: 125300 },
    ],
    lead_readonly_records: [
      { stable_id: 'lead_lin', type: 'character', name: '林晚', jubian_asset_id: 125400 },
    ],
    ...overrides,
  }
}

/**
 * Create one temporary project directory.
 * @param document - The manifest to write, or `undefined` for a project with no manifest.
 * @returns The project directory's absolute path.
 */
export async function tempProject(document?: Record<string, unknown>): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), 'drama-assets-spec-'))
  if (document !== undefined) {
    await writeFile(join(project, 'assets_manifest.json'), JSON.stringify(document, null, 2), 'utf8')
  }
  return project
}

/**
 * Write one file below a directory, creating the directory.
 * @param path - Absolute file path.
 * @param body - File contents.
 */
export async function writeInto(path: string, body: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, body, 'utf8')
}

/**
 * Remove one temporary directory.
 * @param path - Absolute directory path.
 */
export async function cleanup(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

/**
 * Mount the plugin against a stub tool registry and a stub credential store.
 * @param credential - The value the credential store resolves for the Jubian token reference.
 * @returns The definitions the plugin registered, plus the references the store was asked for.
 */
export function mountContext(credential = 'stored-token'):
{ ctx: Context; registered: ToolDefinition[]; resolvedRefs: string[] } {
  const registered: ToolDefinition[] = []
  const resolvedRefs: string[] = []
  const ctx = {
    tools: { register: (definition: ToolDefinition) => { registered.push(definition); return () => {} } },
    credentials: { resolve: (ref: string) => {
      resolvedRefs.push(String(ref))
      return Promise.resolve(credential === '' ? undefined : { value: credential })
    } },
  } as unknown as Context
  return { ctx, registered, resolvedRefs }
}

/** The one `drama_assets` definition the mounted plugin registers. */
export function dramaAssets(registered: ToolDefinition[]): ToolDefinition {
  const tool = registered.find(candidate => candidate.name === 'drama_assets')
  if (tool === undefined) throw new Error('drama_assets was not registered')
  return tool
}
