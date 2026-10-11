import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanRepository as scanRepositoryLinks } from './verify-public-repository-links.ts'
import { scanRepository as scanConcreteTerms } from './verify-concrete-terms.ts'

const tailFile = 'zz-final.md'
const requiredAreas = ['AGENTS.md', 'packages/example.ts', 'docs/example.md', 'vendor/example.ts',
  '.agents/notes/archived/example.md']

function indexFiles(root: string, files: string[]): void {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key.toUpperCase())))
  const options = { cwd: root, env, encoding: 'utf8' as const }
  execFileSync('git', ['init', '--quiet'], options)
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { ...options, input: '' }).trim()
  execFileSync('git', ['update-index', '--index-info'], {
    ...options, input: files.map(file => `100644 ${blob}\t${file}\n`).join(''),
  })
}

describe('complete tracked-source policy scans', () => {
  it.each([
    { name: 'repository links', scan: scanRepositoryLinks, line: 1 },
    { name: 'concrete terminology', scan: scanConcreteTerms, line: 2 },
  ])('reads a manifest exceeding one MiB and rejects its final file for $name', ({ scan, line }) => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-tracked-source-'))
    try {
      const padding = Array.from({ length: 6000 }, (_value, index) =>
        `padding/${String(index).padStart(5, '0')}-${'x'.repeat(180)}.md`)
      const files = [...requiredAreas, ...padding, tailFile]
      expect(Buffer.byteLength(files.join('\0'))).toBeGreaterThan(1024 * 1024)
      indexFiles(root, files)
      const repository = ['deepseek-ai', 'deepseek-harness-sdk'].join('/')
      writeFileSync(join(root, tailFile), [`https://github.com/${repository}`, 'prove' + 'nance', ''].join('\n'))
      expect(scan(root)).toEqual([{ file: tailFile, line }])
      writeFileSync(join(root, tailFile), 'provider metadata\n')
      expect(scan(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a Git index that omits required repository areas', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-tracked-source-'))
    try {
      indexFiles(root, [tailFile])
      expect(() => scanConcreteTerms(root)).toThrow('tracked-file discovery omitted a required repository area')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
