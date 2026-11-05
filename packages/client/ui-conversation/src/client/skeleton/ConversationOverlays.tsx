/** Strict Session overlay adapter outside the scrollport and Chat query container. */
import type { ConversationOverlayHostProps } from '../contract/slots.ts'
import { resolveActiveView } from '../view-selection.ts'

/**
 * Publish the resolved View to non-flowing Session overlays.
 * @param props - Session store, registered Views, and overlay entries.
 * @returns Overlay entries for the selected Session and View.
 */
export function ConversationOverlays({ useStore, useConversationViews, renderSlot }: ConversationOverlayHostProps) {
  const active = resolveActiveView(useConversationViews(value => value), useStore(s => s.view))
  return renderSlot('conversation.content.overlay', { activeView: active?.id ?? null })
}
