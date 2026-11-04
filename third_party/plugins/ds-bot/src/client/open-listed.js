/** Wait for listed Sessions and preserve explicit navigation over delayed default landings. */

/**
 * Open only listed Sessions; newer requests and external navigation cancel a pending wait.
 * @param {{list: object, open: function, refresh?: function, current?: function}} options Session list and navigation operations.
 * @returns {function} Opener with guard() for delayed landings and cancel() for disposal.
 */
export function listedOpener({ list, open, refresh, current }) {
  let drop = () => {}
  let version = 0
  let pending = false
  const cancel = () => {
    drop()
    drop = () => {}
    pending = false
  }
  const show = (target) => {
    version += 1
    cancel()
    const listed = () => list.getSnapshot().byId?.[target] !== undefined
    const from = current?.()
    let opening = false
    pending = true
    const update = () => {
      const main = current?.()
      if (opening) {
        if (current === undefined || main === target || (main !== from && main !== undefined)) cancel()
        return
      }
      if (main !== from) { cancel(); return }
      if (!listed()) return
      opening = true
      try { open(target) } catch (error) { cancel(); throw error }
      if (current === undefined || current() === target) cancel()
    }
    drop = list.subscribe(update)
    update()
    if (!opening && pending) refresh?.()
  }
  show.guard = () => {
    const at = version
    const from = current?.()
    return () => at === version && !pending && current?.() === from
  }
  show.cancel = () => { version += 1; cancel() }
  return show
}
