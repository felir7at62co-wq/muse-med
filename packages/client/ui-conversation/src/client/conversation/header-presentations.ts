/** Reversible presentation contributions over the deployment's header default. */
import type { HeaderPresentation } from '../../header-presentation.ts'
import { ConversationDefinitionRegistry } from './definition-registry.ts'

/** One plugin-owned header preference; later registrations take precedence. */
interface HeaderContribution {
  readonly id: string
  readonly presentation: HeaderPresentation
}

/** Observable header preferences that restore the preceding value on disposal. */
export class HeaderPresentations extends ConversationDefinitionRegistry<HeaderContribution> {
  /**
   * Read the plugin override used before the deployment's header default.
   * @returns The last registered preference, or undefined for the deployment default.
   */
  getSnapshot(): HeaderPresentation | undefined {
    return this.entries().at(-1)?.presentation
  }

  /**
   * Register a preference for the caller's lifetime without replacing navigation.
   * @param contribution - Unique plugin identity and desired presentation.
   * @returns Idempotent disposer restoring the preceding preference.
   */
  register(contribution: HeaderContribution): () => void {
    return this.registerDefinition(contribution.id, contribution,
      `header presentation "${contribution.id}" is already registered`,
      `uiConversation.headerPresentations.register(${JSON.stringify(contribution.id)})`)
  }
}
