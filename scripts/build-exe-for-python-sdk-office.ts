/** Keep LibreOffice workers, prebuilt engines, and their dependencies on the real filesystem. */
import { existsSync } from 'node:fs'
import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { officePackageDirectories } from './libreoffice-packages.mjs'

/** pkg applies these exclusions to dependency `files` as well as root asset globs. */
export const OFFICE_ASSET_IGNORES = [
  '**/node_modules/@deepseek-ai/libreoffice-kit/**',
  '**/node_modules/@deepseek-ai/libreoffice-kit-*/**',
]

/**
 * Restore Office packages omitted by legacy production hoisting, including nested dependency versions and the target engine.
 * @param source - Installed build workspace containing the complete Office dependency tree.
 * @param staging - Deployment directory to complete without replacing its existing packages.
 * @param target - Node platform and CPU of the executable.
 * @returns Relative package directories restored into deployment.
 */
export async function restoreOfficeDeployment(source: string, staging: string,
  target: { platform: string; arch: string }): Promise<string[]> {
  const directories = await officePackageDirectories(source, target)
  const restored: string[] = []
  for (const directory of directories) {
    const relativePath = relative(source, directory)
    const destination = join(staging, relativePath)
    if (existsSync(join(destination, 'package.json'))) continue
    const nestedModules = join(directory, 'node_modules')
    await mkdir(dirname(destination), { recursive: true })
    await cp(directory, destination, { recursive: true, dereference: true,
      filter: path => path !== nestedModules && !path.startsWith(nestedModules + sep) })
    restored.push(relativePath)
  }
  return restored
}

/**
 * Copy the installed Office dependency tree without changing package contents or executable modes.
 * Harness sidecars require the kit's declared target native engine, or WASM for other targets.
 * Missing target engines fail with their package name; missing required dependencies or paths outside the deployed closure also fail.
 * @param staging - Symlink-free deployed Node closure.
 * @param destination - Target-specific Office directory beside the executable; replaced when present.
 * @param target - Node platform and CPU of the executable.
 * @returns Relative package directories included in the sidecar.
 */
export async function copyOfficeSidecar(
  staging: string,
  destination: string,
  target: { platform: string; arch: string },
): Promise<string[]> {
  const directories = await officePackageDirectories(staging, target)
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  for (const source of directories) {
    const nestedModules = join(source, 'node_modules')
    await cp(source, join(destination, relative(staging, source)), {
      recursive: true,
      filter: path => path !== nestedModules && !path.startsWith(nestedModules + sep),
    })
  }
  return directories.map(directory => relative(staging, directory))
}
