/**
 * Collapse an expanded phone sidebar after opening its conversation.
 * @param {{toggleSidebar(): void}} layout Shell controller exposing the sidebar toggle.
 * @returns {void} Preserves collapsed and wider-window sidebar states.
 */
export function closePhoneSidebar(layout) {
  if (window.innerWidth > 640) return
  const column = document.querySelector('[class*="_sidebarCol"]')
  const frame = column?.parentElement
  if (frame && !frame.hasAttribute('data-sidebar-collapsed')) layout.toggleSidebar()
}
