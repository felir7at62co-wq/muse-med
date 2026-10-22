import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { formatNodeNextFailure, linkNodeNextDirectory, nodeNextDirectoryLinkType, removeNodeNextConsumer } from './verify-node-next-types.ts'

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-node-next-links-'))
  onTestFinished(() => { removeNodeNextConsumer(root) })
  return root
}

describe('NodeNext consumer directory links', () => {
  it('uses privilege-free junctions only on Windows', () => {
    expect(nodeNextDirectoryLinkType('win32')).toBe('junction')
    expect(nodeNextDirectoryLinkType('linux')).toBe('dir')
    expect(nodeNextDirectoryLinkType('darwin')).toBe('dir')
  })

  it('reads real workspace and @types links, then removes only the consumer', () => {
    const root = fixture()
    const target = join(root, 'source package')
    const consumer = join(root, 'consumer')
    const nodeModules = join(consumer, 'node_modules')
    mkdirSync(target)
    mkdirSync(join(nodeModules, '@types'), { recursive: true })
    const sentinel = join(target, 'index.d.ts')
    const contents = 'export declare const untouched: unique symbol;\n'
    writeFileSync(sentinel, contents)
    writeFileSync(join(consumer, 'index.ts'), 'import "workspace";\n')
    for (const link of [join(nodeModules, 'workspace'), join(nodeModules, '@types', 'node')]) {
      linkNodeNextDirectory(target, link)
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(realpathSync(link)).toBe(realpathSync(target))
      expect(readFileSync(join(link, 'index.d.ts'), 'utf8')).toBe(contents)
    }
    removeNodeNextConsumer(consumer)
    expect(existsSync(consumer)).toBe(false)
    expect(readFileSync(sentinel, 'utf8')).toBe(contents)
    removeNodeNextConsumer(consumer)
    expect(readFileSync(sentinel, 'utf8')).toBe(contents)
  })

  it('unlinks a link-shaped cleanup root without descending into its source', () => {
    const root = fixture()
    const target = join(root, 'source')
    const link = join(root, 'consumer')
    mkdirSync(target)
    const sentinel = join(target, 'keep.txt')
    writeFileSync(sentinel, 'keep source bytes\n')
    linkNodeNextDirectory(target, link)
    removeNodeNextConsumer(link)
    expect(existsSync(link)).toBe(false)
    expect(readFileSync(sentinel, 'utf8')).toBe('keep source bytes\n')
  })

  it('removes dangling links without following the deleted target', () => {
    const root = fixture()
    const target = join(root, 'source')
    const link = join(root, 'consumer')
    mkdirSync(target)
    linkNodeNextDirectory(target, link)
    removeNodeNextConsumer(target)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    removeNodeNextConsumer(link)
    expect(() => lstatSync(link)).toThrow()
  })
})

describe('NodeNext failure diagnostics', () => {
  it('prints an actual filesystem failure with its complete stack and context', () => {
    const root = fixture()
    const target = join(root, 'source')
    const link = join(root, 'already exists')
    mkdirSync(target)
    mkdirSync(link)
    let caught: unknown
    try {
      linkNodeNextDirectory(target, link)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    if (!(caught instanceof Error)) throw new Error('Expected the real symlink call to fail')
    const formatted = formatNodeNextFailure(caught)
    expect(formatted).toContain(caught.stack)
    expect(formatted).toContain("code: 'EEXIST'")
    expect(formatted).toContain("syscall: 'symlink'")
    expect(formatted).toContain('path: ')
    expect(formatted).toContain('dest: ')
    expect(formatted).toContain('already exists')
    expect(lstatSync(link).isDirectory()).toBe(true)
    expect(lstatSync(link).isSymbolicLink()).toBe(false)
  })

  it('retains both compiler output streams alongside the process error', () => {
    const error = Object.assign(new Error('tsc exited with status 2'), {
      code: 2,
      stdout: Buffer.from('index.ts(1,1): error TS2307: Cannot find module.\n'),
      stderr: 'compiler stderr remains visible\n',
    })
    const formatted = formatNodeNextFailure(error)
    expect(formatted).toContain(error.stack)
    expect(formatted).toContain('code: 2')
    expect(formatted).toContain(error.stdout.toString())
    expect(formatted).toContain(error.stderr)
  })

  it('does not hide non-Error thrown values or errors without a stack', () => {
    expect(formatNodeNextFailure('unexpected failure')).toContain('unexpected failure')
    const error = new Error('no stack available')
    delete error.stack
    expect(formatNodeNextFailure(error)).toBe('Error: no stack available')
  })
})
