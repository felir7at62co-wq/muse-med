import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface PreviewStep {
  name?: string
  if?: string
  uses?: string
  run?: string
  shell?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
}

const workflow = yaml.load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/build-preview-cloudflare.yml'), 'utf8')) as {
  on: unknown
  permissions: unknown
  concurrency: unknown
  env: Record<string, string>
  jobs: Record<'preview', {
    if: string
    'runs-on': string
    defaults: { run: { shell: string } }
    steps: PreviewStep[]
  }>
}
const preview = workflow.jobs.preview
const upstream = 'deepseek-harness/deepseek-harness'
const muse = 'felir7at62co-wq/muse-med'

function evaluate(expression: string, repository: string, headRepository = repository, author = 'maintainer'): unknown {
  return runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), {
    github: { repository, event: { pull_request: { head: { repo: { full_name: headRepository } }, user: { login: author } } } },
  }, { timeout: 1000 })
}

function enabledSteps(repository: string, headRepository = repository, author = 'maintainer'): PreviewStep[] {
  return preview.steps.filter(step => !step.if || evaluate(step.if, repository, headRepository, author))
}

function stepNamed(name: string): PreviewStep {
  const step = preview.steps.find(candidate => candidate.name === name)
  if (!step) throw Error('Missing preview step: ' + name)
  return step
}

describe('PR preview workflow', () => {
  it.each([
    [upstream, true, 'ubuntu-24.04'],
    [muse, true, 'windows-2025'],
    ['contributor/private-fork', false, 'ubuntu-24.04'],
  ])('selects a repository-owned preview lane for %s', (repository, enabled, runner) => {
    expect(Object.keys(workflow.jobs)).toEqual(['preview'])
    expect(evaluate(preview.if, repository)).toBe(enabled)
    expect(evaluate(preview['runs-on'], repository)).toBe(runner)
    expect(preview.defaults.run.shell).toBe('pwsh')
  })

  it('uses pull-request code without persisting checkout credentials', () => {
    expect(workflow.on).toEqual({ pull_request: { types: ['opened', 'synchronize', 'reopened'] } })
    expect(workflow.permissions).toEqual({ contents: 'read', 'pull-requests': 'write' })
    expect(preview.steps.find(step => step.uses === 'actions/checkout@v7')?.with).toEqual({ 'persist-credentials': false })
    expect(workflow.concurrency).toEqual({
      group: 'build-preview-cloudflare-${{ github.event.pull_request.number }}',
      'cancel-in-progress': true,
    })
  })

  it('keeps the immutable full build and restore-only dependency cache', () => {
    expect(workflow.env.PRIMARY_NODE_VERSION).toBe('24')
    expect(workflow.env.DSH_TELEMETRY_DISABLED).toBe('1')
    for (const repository of [upstream, muse]) {
      const commands = enabledSteps(repository).map(step => step.run)
      expect(commands).toContain('pnpm install --frozen-lockfile')
      expect(commands).toContain('pnpm run build')
      expect(commands.indexOf('pnpm install --frozen-lockfile')).toBeLessThan(commands.indexOf('pnpm run build'))
    }
    expect(preview.steps.filter(step => step.uses?.startsWith('actions/cache'))).toHaveLength(1)
    expect(preview.steps.find(step => step.uses === 'actions/cache/restore@v6')?.with).toMatchObject({
      key: "${{ runner.os }}-node-${{ env.PRIMARY_NODE_VERSION }}-pnpm-${{ hashFiles('pnpm-lock.yaml') }}",
    })
    expect(stepNamed('Configure pnpm store path').run).toContain("Join-Path $env:RUNNER_TEMP 'preview-pnpm-store'")
  })

  it('requires the Muse build and browser behavior check before saving only build output', () => {
    const steps = enabledSteps(muse)
    const commands = steps.map(step => step.run)
    const build = stepNamed('Build Muse market preview artifact')
    const browser = stepNamed('Verify Muse market browser behavior')
    const files = stepNamed('Verify Muse artifact files')
    const artifact = stepNamed('Save verified preview artifact')
    expect(build.run).toBe('pnpm --filter @deepseek-ai/dsh-market-web run build')
    expect(stepNamed('Install Muse browser test dependencies').run).toBe('pnpm --filter @deepseek-ai/dsh-market-web exec playwright install chromium')
    expect(browser).toMatchObject({
      env: { DSH_SNAPSHOT: 'replay', DSH_MARKET_PREBUILT_DIR: '${{ github.workspace }}/tmp/market-cloud-web' },
      run: 'pnpm run test:web:built apps/market-web/tests/browser.e2e.ts',
    })
    expect(commands.indexOf('pnpm run build')).toBeLessThan(steps.indexOf(build))
    expect(steps.indexOf(build)).toBeLessThan(steps.indexOf(files))
    expect(steps.indexOf(files)).toBeLessThan(steps.indexOf(browser))
    expect(steps.indexOf(browser)).toBeLessThan(steps.indexOf(artifact))
    expect(files.run).toContain('tmp/market-cloud-web/index.html -ErrorAction Stop')
    expect(files.run).toContain('Market preview HTML is empty')
    expect(files.run).toContain('Market preview assets are missing')
    expect(files.run).toContain("-Filter '*.map' -Recurse -File | Remove-Item")
    expect(artifact.uses).toBe('actions/upload-artifact@v7')
    expect(artifact.with).toMatchObject({
      name: 'preview-pr-${{ github.event.pull_request.number }}', 'if-no-files-found': 'error', 'retention-days': 7,
    })
    expect(evaluate(String(artifact.with?.path), muse)).toBe('tmp/market-cloud-web/')
    for (const step of [build, browser, files, artifact]) expect(step).not.toHaveProperty('continue-on-error')
    expect(artifact.if).toBeUndefined()
    expect(stepNamed('Summarize Muse preview artifact').run).toContain('not an online preview deployment or a real-model acceptance result')
    expect(stepNamed('Summarize Muse preview artifact').run).toContain('same-origin Muse account gateway')
  })

  it.each([
    [upstream, upstream, 'maintainer', true],
    [upstream, 'contributor/private-fork', 'contributor', false],
    [upstream, upstream, 'dependabot[bot]', false],
    [muse, muse, 'maintainer', false],
    [muse, 'contributor/private-fork', 'contributor', false],
  ])('confines deployment credentials to trusted upstream PRs: %s from %s by %s', (repository, headRepository, author, deploys) => {
    const steps = enabledSteps(repository, headRepository, author)
    for (const name of ['Upload to Cloudflare Pages', 'Verify the protected deployment serves the image', 'Comment the preview URL']) {
      expect(steps.includes(stepNamed(name))).toBe(deploys)
    }
    const credentialSteps = steps.filter(step => Object.values(step.env ?? {}).some(value => value.includes('secrets.')))
    expect(credentialSteps.map(step => step.name)).toEqual(deploys
      ? ['Upload to Cloudflare Pages', 'Verify the protected deployment serves the image', 'Comment the preview URL']
      : [])
    expect(steps).toContain(stepNamed('Save verified preview artifact'))
    expect(steps.includes(stepNamed('Build Muse market preview artifact'))).toBe(repository === muse)
    expect(steps.includes(stepNamed('Build the preview page and pack the VFS image'))).toBe(repository === upstream)
  })

  it('retains upstream per-PR deployment, protected image verification and idempotent comments', () => {
    expect(workflow.env.CF_PROJECT).toBe('dsh-build-preview')
    const commands = enabledSteps(upstream).map(step => step.run)
    const build = 'pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview'
    expect(commands).toContain(build)
    expect(commands.indexOf('pnpm run build')).toBeLessThan(commands.indexOf(build))
    const shape = stepNamed('Shape the upload')
    expect(shape.run).toContain("find apps/web/dist -name '*.map' -delete")
    expect(shape.run).toContain('cp apps/web/dist/preview.html apps/web/dist/index.html')
    const artifact = stepNamed('Save verified preview artifact')
    expect(evaluate(String(artifact.with?.path), upstream)).toBe('apps/web/dist/')
    const deploy = stepNamed('Upload to Cloudflare Pages')
    expect(deploy.run).toContain('npx --yes wrangler@4 pages deploy apps/web/dist')
    expect(deploy.run).toContain('--branch "pr-${{ github.event.pull_request.number }}"')
    const verify = stepNamed('Verify the protected deployment serves the image')
    expect(verify.run).toContain('/preview/vfs-image.tar.gz')
    expect(verify.run).toContain('"$code" != "200"')
    expect(verify.run).toContain('content-encoding:')
    expect(verify.run).toContain('"$magic" != "1f8b"')
    expect(verify.env?.CF_ACCESS_CLIENT_SECRET).toBe('${{ secrets.CF_ACCESS_CLIENT_SECRET }}')
    const comment = stepNamed('Comment the preview URL')
    expect(comment.run).toContain('<!-- dsh-preview-url -->')
    expect(comment.run).toContain('gh pr comment "$PR" --body-file -')
    for (const step of [shape, deploy, verify, comment]) expect(step.shell).toBe('bash')
  })
})
