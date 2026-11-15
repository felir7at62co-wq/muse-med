/** Process view for the kernel-lock test child; production process enumeration is separately exercised. */
export function readWorkspaceProcessSnapshot(): Promise<{ platform: 'posix'; stdout: string; stderr: string }> {
  return Promise.resolve({ platform: 'posix', stdout: `${process.pid} isolated-owner-child\n`, stderr: '' })
}
