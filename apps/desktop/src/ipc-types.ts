/** Shared Desktop IPC payload types without Host runtime dependencies. */

/** Desktop plugin record derived from the installed profile. */
export interface DesktopPluginRecord {
  readonly name: string
  readonly version: string
  readonly enabled: boolean
}

/** One immutable community package shipped with the application. */
export interface DesktopBundledPlugin {
  readonly name: string
  readonly version: string
  /** Whether the profile mounts its bundle; settings may still leave its feature disabled. */
  readonly mounted: boolean
}

/** Validated public metadata, never an executable catalog installation command. */
export interface DesktopCatalogPlugin {
  readonly name: string
  readonly description: Readonly<Partial<Record<'en' | 'zh', string>>>
  readonly repository: string
  readonly npm?: string
  readonly bundled: boolean
}

/** Shell-owned discovery response; local inventory remains available without a network request. */
export interface DesktopPluginCatalog {
  readonly canInstall: boolean
  readonly bundled: readonly DesktopBundledPlugin[]
  readonly plugins: readonly DesktopCatalogPlugin[]
}

/** Backend availability presented by the desktop window. */
export type DesktopBackendState =
  | { readonly phase: 'starting' }
  | { readonly phase: 'ready' }
  /** Rendered message, the original error, and whether the packaged application can still rebuild the profile. */
  | { readonly phase: 'error'; readonly message: string; readonly failure: unknown; readonly profileRecovery?: boolean }
