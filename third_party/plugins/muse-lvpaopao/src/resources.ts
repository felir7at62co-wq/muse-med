/** Paths passed to Python must refer to actual unpacked filesystem resources. */
import { fileURLToPath } from 'node:url'

/**
 * Resolve the native source directory beside the source or built bridge module.
 * @param moduleUrl - Bridge module URL supplied by the Host.
 * @returns Native files outside Electron's virtual app.asar filesystem.
 */
export function nativeResourcesDirectory(moduleUrl: string): string {
  return fileURLToPath(new URL('../native/', moduleUrl))
    .replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2')
}
