/** Complete Host teardown and acknowledge it before releasing the child process. */

/**
 * Stop a booted application before acknowledging shutdown and exiting the Host.
 * @param application - The application startup result; startup failure retains its diagnostic exit.
 * @param acknowledge - Send the shutdown acknowledgement and wait for IPC delivery.
 * @returns Completion without an explicit exit only when startup failed.
 * @throws When application teardown or acknowledgement fails; neither failure authorizes an exit.
 */
export async function shutdownDesktopHost(
  application: Promise<{ readonly shutdown: { shutdown(code: number): Promise<void> } }>,
  acknowledge: () => Promise<void>,
): Promise<void> {
  const running = await application.catch(() => undefined)
  await running?.shutdown.shutdown(0)
  await acknowledge()
  if (process.connected) {
    if (process.disconnect === undefined) throw new Error('desktop host: connected IPC has no disconnect method')
    process.disconnect()
  }
  // Disposed plugins may retain event-loop handles after their owned work has stopped.
  if (running !== undefined) process.exit()
}
