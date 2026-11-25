/** Injected terminal commands and keyed observable state. */
import type { WebTerminalId } from '@deepseek-ai/dsh-api-terminal-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TerminalView, TerminalViewState } from '@deepseek-ai/dsh-api-terminal-controller/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'

/** The terminal's React-free model is resolved by sidebar occurrence. */
export interface TerminalInjected {
  /** @param key - sidebar occurrence key. @returns its terminal commands. */
  readonly view: (key: string) => TerminalView
  readonly keyedHooks: { readonly terminal: (key: string) => HostObservable<TerminalViewState> }
}


/** The terminal screen follows the resolved application theme through a framework hook. */
export interface TerminalBodyInjected extends TerminalInjected {
  readonly hooks: { readonly theme: HostObservable<ThemeSnapshot> }
}

/** The Bot panel resolves a terminal's React-free model by Session and panel tab. */
export interface PanelTerminalInjected {
  /**
   * @param sessionId - Session the terminal runs in.
   * @param tabId - panel tab identity, which is also its saved content identity.
   * @param terminalId - existing Host terminal the tab shows; a tab without one starts a terminal.
   * @returns the tab's terminal commands and observable state.
   */
  readonly panelView: (sessionId: SessionId, tabId: string, terminalId?: WebTerminalId) => TerminalView
  readonly hooks: { readonly theme: HostObservable<ThemeSnapshot> }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The Bot team's panel: one terminal tab of the Bot whose conversation is `sessionId`.
     * `tabId` names the tab among every open one, `terminalId` an existing Host terminal it shows,
     * and `replace` opens a new terminal in the tab's place.
     */
    'bot.drawer.terminal': {
      kind: 'single'
      scope: 'root'
      owner: { sessionId: SessionId; tabId: string; terminalId?: WebTerminalId; visible: boolean; replace: () => void }
    }
  }
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** An existing Host terminal selected from the Session terminal list. */
    terminal: { terminalId: WebTerminalId } | { shellPath: string }
  }
}
