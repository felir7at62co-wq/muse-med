/** Muse fixture imports follow the subprocess's source or built execution mode. */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/**
 * @param {string} name - Package declared by the owning workspace.
 * @param {URL} owner - Owning workspace manifest used for installed resolution.
 * @returns Package exports from the active execution mode; names are supplied by the fixture.
 */
export async function importSnapshotPackage(name, owner) {
  return import(process.env.DSH_EXAMPLE_MODE === 'lib'
    ? pathToFileURL(createRequire(owner).resolve(name)).href : name)
}

/**
 * @param {URL} source - Source entry loaded by the source launcher.
 * @param {URL} built - Built entry loaded by plain Node.
 * @returns Module exports from the active execution mode; entries are supplied by the fixture.
 */
export async function importSnapshotModule(source, built) {
  return import((process.env.DSH_EXAMPLE_MODE === 'lib' ? built : source).href)
}
