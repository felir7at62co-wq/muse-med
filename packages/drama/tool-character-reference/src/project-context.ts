/** Host-owned Session project resolution for public character lookup. */
import { lstat, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type SettingsForms from '@deepseek-ai/dsh-settings'
import type { Session } from '@deepseek-ai/dsh-session'
import { readProjectBible } from '@deepseek-ai/dsh-drama-settings'

interface ProjectChoice {
  readonly scriptId: number
  readonly title: string | null
  readonly characters: readonly ProjectCharacter[]
  /** Never projected into a model-visible tool result. */
  readonly directory: string
}

interface ProjectCharacter {
  readonly character_id: string
  readonly name: string
  readonly role_class: 'lead' | 'important_support' | 'support' | 'extra' | null
  readonly asset_id: number | null
}

interface HumanSelection {
  readonly text: string
}

const MAX_PROJECTS = 64

function scriptId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function safeTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const title = value.trim()
  return title.length > 0 && title.length <= 160 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(title)
    ? title : null
}

/** Read only direct project roots; a directory scan is never itself a selection. */
async function choices(settings: SettingsForms, workspace: string): Promise<ProjectChoice[]> {
  try {
    if (!workspace.trim()) throw new Error('missing workspace')
    const root = resolve(workspace)
    const roots = [root]
    const workshop = join(root, 'short-drama')
    // A racing deletion is handled by the outer fail-closed error boundary.
    const workshopEntry = existsSync(workshop) ? await lstat(workshop) : undefined
    if (workshopEntry !== undefined) {
      if (workshopEntry.isSymbolicLink() || !workshopEntry.isDirectory()) throw new Error('unsafe workshop')
      const children = await readdir(workshop, { withFileTypes: true })
      if (children.length > MAX_PROJECTS) throw new Error('too many projects')
      for (const child of children) {
        if (child.isSymbolicLink()) throw new Error('unsafe project')
        if (child.isDirectory()) roots.push(join(workshop, child.name))
      }
    }
    const result: ProjectChoice[] = []
    for (const directory of roots) {
      // readProjectBible validates every path ancestor and never writes a missing bible.
      const read = await readProjectBible(settings, directory)
      if (read.status !== 'ready') continue
      const id = scriptId(read.config.jubian_script_id)
      if (id === undefined) continue
      // readProjectBible returns ready only after validating the bible object.
      const bible = read.config.project_bible as { title?: unknown }
      const title = safeTitle(bible.title)
      const rows = 'characters' in bible && Array.isArray(bible.characters) ? bible.characters : []
      if (rows.length > 128) throw new Error('too many characters')
      const characters: ProjectCharacter[] = rows.map((row: {
        character_id?: unknown
        name?: unknown
        role_class?: unknown
        asset_id?: unknown
      }) => {
        const characterId = safeTitle(row.character_id)
        const name = safeTitle(row.name)
        if (characterId === null || characterId.length > 128 || name === null) throw new Error('unsafe character')
        // readProjectBible has already validated any positive asset ID and role enum.
        const assetId = row.asset_id === undefined ? null : Number(row.asset_id)
        const role = row.role_class as ProjectCharacter['role_class'] | undefined
        return { character_id: characterId, name, role_class: role ?? null, asset_id: assetId }
      })
      result.push({ scriptId: id, title, characters, directory })
      if (result.length > MAX_PROJECTS) throw new Error('too many projects')
    }
    return result.sort((a, b) => a.scriptId - b.scriptId || a.directory.localeCompare(b.directory))
  } catch {
    // No local path, malformed project content, or low-level exception reaches the model.
    throw new Error('Character reference could not safely inspect the Session projects.')
  }
}

function explicitlyNamed(human: HumanSelection | undefined, choice: ProjectChoice, all: readonly ProjectChoice[]): boolean {
  if (human === undefined) return false
  const id = String(choice.scriptId)
  if (new RegExp(`(^|[^0-9])${id}([^0-9]|$)`, 'u').test(human.text)) return true
  return choice.title !== null && all.filter(row => row.title === choice.title).length === 1
    && human.text.includes(choice.title)
}

interface ProjectContext {
  readonly list: (session: Session) => Promise<{ readonly script_id: number; readonly title: string | null }[]>
  readonly select: (session: Session, wanted: number) => Promise<{
    readonly script_id: number
    readonly title: string | null
    readonly characters: ProjectCharacter[]
  }>
  readonly resolveCurrent: (session: Session) => Promise<string>
}

/**
 * Create Host-owned Session project selection for public character lookup.
 * @param ctx - Cordis context that publishes current human Session messages.
 * @param settings - Validated drama project settings used by the project-bible reader.
 * @returns Bounded project listing, explicit selection, and current-project resolution.
 */
export function createProjectContext(ctx: Context, settings: SettingsForms): ProjectContext {
  const selected = new WeakMap<Session, ProjectChoice>()
  const human = new WeakMap<Session, HumanSelection>()
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') return
    const text = event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(' ')
    human.set(session, { text })
  })

  const list = async (session: Session) => {
    const workspace = session.header.cwd
    if (workspace === undefined) throw new Error('Character reference requires a Session workspace.')
    const found = await choices(settings, workspace)
    return found.map(row => ({ script_id: row.scriptId, title: row.title }))
  }

  const select = async (session: Session, wanted: number) => {
    if (scriptId(wanted) === undefined) throw new Error('Character reference requires a valid project ID.')
    const workspace = session.header.cwd
    if (workspace === undefined) throw new Error('Character reference requires a Session workspace.')
    const found = await choices(settings, workspace)
    const matches = found.filter(row => row.scriptId === wanted)
    const match = matches[0]
    const named = found.filter(row => explicitlyNamed(human.get(session), row, found))
    const namedMatch = named.length === 1 ? named[0] : undefined
    const humanNamed = namedMatch !== undefined && match !== undefined
      && namedMatch.scriptId === match.scriptId && namedMatch.directory === match.directory
    if (matches.length !== 1 || match === undefined || (found.length !== 1 && !humanNamed)) {
      throw new Error('Ask the user to explicitly identify one current project before selecting it.')
    }
    // Only an explicit human choice persists; an inferred singleton must stay unique on every call.
    if (humanNamed) selected.set(session, match)
    return { script_id: match.scriptId, title: match.title, characters: [...match.characters] }
  }

  const resolveCurrent = async (session: Session): Promise<string> => {
    const workspace = session.header.cwd
    if (workspace === undefined) throw new Error('Character reference requires a Session workspace.')
    const found = await choices(settings, workspace)
    const binding = selected.get(session)
    if (binding !== undefined) {
      const named = found.filter(row => explicitlyNamed(human.get(session), row, found))
      if (named.some(row => row.scriptId !== binding.scriptId || row.directory !== binding.directory)) {
        throw new Error('The current human message names another project; select it explicitly first.')
      }
      const matches = found.filter(row => row.scriptId === binding.scriptId && row.directory === binding.directory)
      const match = matches[0]
      if (matches.length !== 1 || match === undefined) throw new Error('The selected project binding is no longer valid.')
      return match.directory
    }
    // A Session created in the project root already has an explicit Host-owned cwd.
    // A later human message naming another valid project must still go through select.
    const root = resolve(workspace)
    const named = found.filter(row => explicitlyNamed(human.get(session), row, found))
    if (named.some(row => row.directory !== root)) {
      throw new Error('The current human message names another project; select it explicitly first.')
    }
    const direct = found.filter(row => row.directory === root)
    if (direct.length === 1 && direct[0] !== undefined) return direct[0].directory
    // A single validated workspace project is unambiguous; no human selection is needed.
    if (found.length === 1 && found[0] !== undefined) return found[0].directory
    throw new Error('Select the current drama project explicitly before searching character references.')
  }

  return { list, select, resolveCurrent }
}
