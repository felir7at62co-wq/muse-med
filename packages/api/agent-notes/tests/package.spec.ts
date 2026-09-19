import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8'),
) as { dependencies?: Record<string, string> }

describe('agent notes package', () => {
  it('declares zod for the published Typert host', () => {
    expect(manifest.dependencies).toHaveProperty('zod')
  })
})
