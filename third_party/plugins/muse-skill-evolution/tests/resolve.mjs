/** Resolve private-plugin Host peers through this checkout's built package exports. */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../../..')
const manifests = new Map()
for (const group of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
  if (!group.isDirectory()) continue
  const directory = join(root, 'packages', group.name)
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifest = join(directory, entry.name, 'package.json')
    if (existsSync(manifest)) manifests.set(JSON.parse(readFileSync(manifest, 'utf8')).name, manifest)
  }
}
for (const name of ['cordis', 'schemastery']) manifests.set(`@deepseek-ai/${name}`, join(root, 'vendor', name, 'package.json'))
registerHooks({
  resolve(specifier, context, nextResolve) {
    const name = specifier.split('/').slice(0, 2).join('/')
    const manifest = manifests.get(name)
    if (!manifest || !context.parentURL?.includes('/muse-skill-evolution/')) return nextResolve(specifier, context)
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    const key = specifier === name ? '.' : `.${specifier.slice(name.length)}`
    const exported = pkg.exports?.[key]
    const target = typeof exported === 'string' ? exported : exported?.import ?? exported?.default
    if (!target) return nextResolve(specifier, context)
    return nextResolve(pathToFileURL(resolve(manifest, '..', target)).href, context)
  },
})
