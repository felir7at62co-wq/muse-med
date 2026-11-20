/** Load xterm only after a terminal body is mounted. */
import { lazy, Suspense, type ReactNode } from 'react'
import type { PanelTerminalProps, TerminalBodyProps } from './terminal.tsx'

// One import expression: the startup bundle then names the terminal chunk once.
const loadTerminal = () => import('./terminal.tsx')
const LoadedTerminalBody = lazy(async () => ({ default: (await loadTerminal()).TerminalBody }))

/**
 * Suspend while the package-local terminal chunk arrives.
 * @param props - Terminal body props supplied by the sidebar slot.
 * @returns the deferred terminal renderer.
 */
export function LazyTerminalBody(props: TerminalBodyProps): ReactNode {
  return <Suspense fallback={null}><LoadedTerminalBody {...props} /></Suspense>
}

const LoadedPanelTerminal = lazy(async () => ({ default: (await loadTerminal()).PanelTerminal }))

/**
 * Suspend while the same terminal chunk arrives for a Bot panel tab.
 * @param props - Terminal props supplied by the Bot panel slot.
 * @returns the deferred terminal renderer.
 */
export function LazyPanelTerminal(props: PanelTerminalProps): ReactNode {
  return <Suspense fallback={null}><LoadedPanelTerminal {...props} /></Suspense>
}
