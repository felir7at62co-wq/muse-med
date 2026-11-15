/** Disabled legacy rows may remain in profile backups; the ordinary-session Host never activates Bot modules. */
export const name = 'muse-retired-bot'

/**
 * Reject an explicit attempt to reactivate archived Bot composition through the shared plugin manager.
 * @returns Never; restoration uses the separately retained application and private profile backup.
 */
export function apply(): never { throw new Error('Muse: archived Bot packages cannot be activated in the ordinary-session Desktop profile') }
