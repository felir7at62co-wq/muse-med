/** Module script declarations read from a shipped HTML entry. */
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

/**
 * Read module scripts in document order without running them.
 * @param filename - Path to the shipped HTML file.
 * @returns Script source attributes and inline source text.
 */
export function readProductModuleScripts(filename: string): readonly { src: string | null; text: string }[] {
  const dom = new JSDOM(readFileSync(filename, 'utf8'))
  try {
    return Array.from(dom.window.document.querySelectorAll<HTMLScriptElement>('script[type="module"]'), script => ({
      src: script.getAttribute('src'), text: script.text,
    }))
  } finally {
    dom.window.close()
  }
}
