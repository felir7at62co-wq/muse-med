/** Startup variables required by native executables before model evaluation. */

/** Native search, Windows paths, temporary paths, and Electron's Node mode retained only in the OS environment. */
export const STARTUP_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'ELECTRON_RUN_AS_NODE'])
