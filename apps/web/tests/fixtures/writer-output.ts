import { copyFile, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Allocate a private writer fixture owned by the caller's cleanup list.
 * @param roots - Per-test owner that removes every allocated directory after completion.
 * @returns Canonical input and writer-output paths inside the private directory.
 */
export async function createWebWriterFixture(roots: string[]): Promise<{ root: string; input: string; writer: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-web-writer-output-'))
  roots.push(root)
  const input = join(root, 'session.v4.jsonl')
  await copyFile(new URL('../../../../snapshots/web/live-interactions/session.v4.jsonl', import.meta.url), input)
  await writeFile(join(root, 'snapshot.yml'), 'version: 1\nprofile: web\nwriterOutput: true\n')
  return { root, input, writer: join(root, 'writer.expected.jsonl') }
}
