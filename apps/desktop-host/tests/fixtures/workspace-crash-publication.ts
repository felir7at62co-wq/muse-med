/** Pause before the real platform publication so the parent can kill the actual store owner. */
import { publishWorkspacePath as publish } from '../../src/workspace-owner-lease.ts'
export { acquireWorkspaceOwner } from '../../src/workspace-owner-lease.ts'

/** Preserve real file writes and locking, and expose only the final migration boundary. */
export async function publishWorkspacePath(source: string, target: string, replace: boolean): Promise<void> {
  if (target === process.argv[3] && !replace) {
    process.stdin.resume()
    process.stdout.write('WORKSPACE_BEFORE_PUBLICATION\n')
    await new Promise<never>(() => {})
  }
  await publish(source, target, replace)
}
