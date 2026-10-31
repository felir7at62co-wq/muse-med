/** Carry reviewed pnpm dependency patches into the private production install. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { dump, load } from 'js-yaml'

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('desktop runtime: invalid workspace patch settings')
  return value as Record<string, unknown>
}

/**
 * Copy root patches under content-addressed names and declare them in the private workspace.
 * @param repository - Repository holding the reviewed pnpm workspace and patch files.
 * @param project - Newly created runtime installation project.
 */
export function stageRuntimeDependencyPatches(repository: string, project: string): void {
  const source = object(load(readFileSync(join(repository, 'pnpm-workspace.yaml'), 'utf8')))
  const declarations = object(source.patchedDependencies)
  const target = join(project, 'pnpm-workspace.yaml')
  const workspace = object(load(readFileSync(target, 'utf8')))
  const patchedDependencies: Record<string, string> = {}
  for (const [selector, file] of Object.entries(declarations).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (selector === '' || typeof file !== 'string' || file === '') throw new Error('desktop runtime: invalid dependency patch declaration')
    const input = resolve(repository, file)
    const local = relative(resolve(repository), input)
    if (isAbsolute(file) || local === '..' || local.startsWith('../') || local.startsWith('..\\')) throw new Error('desktop runtime: dependency patch must remain inside the repository')
    const bytes = readFileSync(input)
    const name = `dependency-patches/${createHash('sha256').update(bytes).digest('hex')}.patch`
    mkdirSync(join(project, 'dependency-patches'), { recursive: true })
    writeFileSync(join(project, name), bytes)
    patchedDependencies[selector] = name
  }
  // Build-only dependencies are absent from the production closure; applicable patches must still apply.
  writeFileSync(target, dump({ ...workspace, patchedDependencies, allowUnusedPatches: true }, { lineWidth: -1, noRefs: true }))
}

/**
 * Reject a runtime whose active PI-AI completion implementation lost the reviewed workspace patch.
 * @param repository - Installed release checkout supplying the patched reference dependency.
 * @param project - Production installation project before its modules are materialized.
 */
export function verifyRuntimeDependencyPatches(repository: string, project: string): void {
  const name = '@earendil-works/pi-ai'
  const expectedRoot = join(repository, 'packages/llm/llm-pi-ai/node_modules', name)
  const entry = 'dist/api/openai-completions.js'
  if (!existsSync(join(expectedRoot, 'package.json')) || !existsSync(join(expectedRoot, entry))) {
    throw new Error('desktop runtime: patched PI-AI reference dependency is missing')
  }
  const expected = readFileSync(join(expectedRoot, entry))
  const text = expected.toString('utf8')
  if (!text.includes('function hasTokenUsage(usage)') || !text.includes('if (hasTokenUsage(chunk.usage))')
    || !text.includes('if (!hasTokenUsage(chunk.usage) && hasTokenUsage(choice.usage))')) {
    throw new Error('desktop runtime: workspace PI-AI reference lacks the reviewed token-usage patch')
  }
  if (!readFileSync(join(project, 'node_modules', name, entry)).equals(expected)) {
    throw new Error('desktop runtime: installed PI-AI completion bytes differ from the reviewed patched dependency')
  }
}
