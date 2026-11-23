/** Resolves an application path under the prefix selected when the browser bundle was built. */
export function applicationUrl(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new TypeError('Expected a same-origin application path');
  return `${import.meta.env.BASE_URL.replace(/\/$/u, '')}${path}`;
}
