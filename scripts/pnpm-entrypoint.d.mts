/** Read an installed pnpm manifest and return its existing JavaScript launcher.
 * @param manifestPath - Absolute path to the installed pnpm package.json.
 * @returns JavaScript entry to pass after the Node executable.
 */
export declare function resolvePnpmEntrypoint(manifestPath: string): string
