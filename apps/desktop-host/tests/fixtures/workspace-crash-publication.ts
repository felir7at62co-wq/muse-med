/** Process-death injection at the shared publication API for POSIX and Win32 migration. */
import { resolve } from 'node:path'
import { publishWorkspacePath as publish } from '../../src/workspace-owner-lease.ts'
export * from '../../src/workspace-owner-lease.ts'

/** Stop the owned fixture before its selected migration root can be published.
 * @param source - Prepared staging path.
 * @param target - Destination selected by the real migration.
 * @param replace - Existing publication replacement policy.
 * @returns Completion for publications other than the selected migration root.
 */
export async function publishWorkspacePath(source: string, target: string, replace: boolean): Promise<void> {
  const ownedRoot = process.argv[3]
  if (ownedRoot !== undefined && resolve(target) === resolve(ownedRoot)) {
    process.stdout.write('MIGRATION_BEFORE_PUBLICATION\n', () => { process.kill(process.pid, 'SIGKILL') })
    await new Promise<never>(() => {})
  }
  await publish(source, target, replace)
}
