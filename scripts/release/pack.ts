/**
 * Pack one release family's whole publish set into a single directory, in
 * publish order, and record that order for the publish step.
 *
 * The pack step is the release boundary: it runs without credentials, produces
 * every tarball from one commit, and hands the publish step exactly those bytes
 * ([rationale](../../.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md)).
 *
 * Repacking is skipped for a member whose recorded inputs still describe the
 * tarball in the destination: the decision is a content digest over the files
 * `pnpm pack` reads, the packer, and the member's family dependencies, written
 * beside the tarballs, never a timestamp
 * ([rationale](../../.agents/notes/implemented/process/2026-09-27-packaging-resume-and-unchanged-package-skip.md)).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pnpmInvocation } from '../pnpm-invocation.ts'
import { releaseFamily, tarballName, type ReleaseFamily, type ReleaseMember } from './families.ts'
import {
  collectPackInputs,
  decideMemberPack,
  fileSha256,
  memberDigest,
  newPackManifest,
  packManifestFile,
  readPackManifest,
  type PackInputs,
  type PackManifestMember,
} from './pack-plan.ts'
import { attempt, isEntry, runConcurrent } from './process.ts'
import { PUBLISH_ORDER_FILE, tarballFiles } from './tarball.ts'

/** Where pack output lands when `--out` is omitted. */
const DEFAULT_OUTPUT = 'dist/npm'

/** One member's pack decision, computed before any packer runs. */
interface MemberPlan {
  readonly member: ReleaseMember
  readonly filename: string
  readonly tarball: string
  readonly inputs: PackInputs
  readonly digest: string
  readonly reuse: boolean
  readonly reason: string
  /** The row this run keeps when it reuses, which is the one the decision matched. */
  readonly recorded: PackManifestMember | undefined
}

/**
 * Name the package manager that writes the tarballs, from the root manifest.
 * @param root - repository root.
 * @returns The declared `packageManager` value, or a marker when none is declared.
 */
function packageManagerIdentity(root: string): string {
  const manifest: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const declared = manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)
    ? (manifest as Record<string, unknown>).packageManager
    : undefined
  return typeof declared === 'string' && declared !== '' ? declared : 'unspecified'
}

/**
 * The commit being packed.
 * @param root - repository root.
 * @returns The full HEAD hash, or `unknown` outside a Git checkout.
 */
function packedCommit(root: string): string {
  const probe = attempt('git', ['rev-parse', 'HEAD'], { cwd: root })
  return probe.status === 0 ? probe.stdout.trim() : 'unknown'
}

/**
 * Every family member reachable from one member through declared dependencies.
 * @param member - the member whose closure is collected.
 * @param declaredFor - the family members one member name declares.
 * @returns The reachable member names, excluding the member itself.
 */
function dependencyClosure(
  member: ReleaseMember,
  declaredFor: (name: string) => readonly string[],
): string[] {
  const reached = new Set<string>()
  const visit = (name: string): void => {
    for (const dependency of declaredFor(name)) {
      if (reached.has(dependency) || dependency === member.name) continue
      reached.add(dependency)
      visit(dependency)
    }
  }
  visit(member.name)
  return [...reached].sort((left, right) => left.localeCompare(right))
}

/**
 * Whether the recorded inputs cover every path the packed tarball carries.
 *
 * The inputs are built as a superset, so this is the check that says so. A
 * member that fails it is never reused: the next run cannot know which
 * unrecorded file changed.
 * @param inputs - package-relative paths the digest covered.
 * @param payload - tarball member paths.
 * @returns True when every payload file is one of the inputs.
 */
function inputsCoverPayload(inputs: readonly string[], payload: readonly string[]): boolean {
  const covered = new Set(inputs)
  return payload
    .map(file => file.replaceAll('\\', '/').replace(/^package\//u, '').replace(/\/+$/u, ''))
    .filter(file => file !== '')
    .every(file => covered.has(file))
}

/** Pack one member and record what its tarball now carries. */
async function packMember(
  family: ReleaseFamily,
  plan: MemberPlan,
  destination: string,
): Promise<PackManifestMember> {
  const invocation = pnpmInvocation(['--dir', plan.member.directory, 'pack', '--pack-destination', destination])
  await runConcurrent(invocation.command, invocation.args)

  const filename = tarballName(plan.member)
  const tarball = join(destination, filename)
  if (!existsSync(tarball)) throw new Error(`${plan.member.name} produced no tarball at ${tarball}`)
  const payload = tarballFiles(tarball)
  family.validatePayload(plan.member, payload)
  const inputsMatchPayload = inputsCoverPayload(plan.inputs.files, payload)
  if (!inputsMatchPayload) {
    console.log(
      `release pack: ${plan.member.name} packs paths its recorded inputs do not cover;`
      + ' it is repacked on every run',
    )
  }
  return {
    name: plan.member.name,
    version: plan.member.version,
    tarball: filename,
    bytes: statSync(tarball).size,
    sha256: fileSha256(tarball),
    inputSha256: plan.inputs.sha256,
    digest: plan.digest,
    fileCount: plan.inputs.files.length,
    inputsMatchPayload,
  }
}

/** The recorded row for a member a run keeps, as it stands in the destination. */
function reusedMember(plan: MemberPlan, previous: PackManifestMember): PackManifestMember {
  return { ...previous, bytes: statSync(plan.tarball).size }
}

/**
 * @returns The validated `--concurrency` value; 1 (the default) packs the
 * members one at a time, exactly as the credentialed publish workflows run it.
 */
function parseConcurrency(raw: string | undefined): number {
  if (raw === undefined) return 1
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== raw) {
    throw new Error(`--concurrency must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return parsed
}

/** Pack the family named by `--family` into `--out`. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { family: { type: 'string' }, out: { type: 'string' }, concurrency: { type: 'string' } },
    allowPositionals: false,
  })
  if (values.family === undefined) throw new Error('usage: pack.ts --family <dsh|vendor> [--out dist/npm] [--concurrency 1]')
  const concurrency = parseConcurrency(values.concurrency)

  const family = releaseFamily(values.family)
  const root = process.cwd()
  const destination = resolve(root, values.out ?? DEFAULT_OUTPUT)
  const members = family.publishOrder(family.members(root)).order
  family.verifyBuildArtifacts(root)
  family.verifyVersions(members)

  mkdirSync(destination, { recursive: true })
  const manifestPath = join(destination, packManifestFile(family.id))
  const previous = readPackManifest(manifestPath)
  const packageManager = packageManagerIdentity(root)
  const byName = new Map(members.map(member => [member.name, member]))
  const workspaceLicense = join(root, 'LICENSE')
  const digests = new Map(members.map(member => [
    member.name,
    collectPackInputs(resolve(root, member.directory), member.manifest, { workspaceLicense }),
  ]))
  const inputsOf = (name: string): PackInputs => {
    const inputs = digests.get(name)
    if (inputs === undefined) throw new Error(`release pack: no pack inputs collected for ${name}`)
    return inputs
  }
  const declaredFor = (name: string): readonly string[] => {
    const entry = byName.get(name)
    if (entry === undefined) throw new Error(`release pack: ${name} is not a member of family ${family.id}`)
    return family.memberDependencies(entry, byName)
  }

  const plans: MemberPlan[] = members.map((member) => {
    const inputs = inputsOf(member.name)
    const digest = memberDigest({
      inputSha256: inputs.sha256,
      dependencies: dependencyClosure(member, declaredFor)
        .map(name => ({ name, inputSha256: inputsOf(name).sha256 })),
      packageManager,
    })
    const filename = tarballName(member)
    const tarball = join(destination, filename)
    const recorded = previous?.members.find(row => row.name === member.name)
    const decision = decideMemberPack({ previous: recorded, filename, digest, tarball })
    return { member, filename, tarball, inputs, digest, reuse: decision.reuse, reason: decision.reason, recorded }
  })

  // Members pack in a bounded pool; the recorded publish order stays the
  // members' order regardless of completion order, because each worker writes
  // its result at the member's own position.
  const order = new Array<string>(members.length)
  const rows = new Array<PackManifestMember>(members.length)
  let reused = 0
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, members.length) }, async () => {
    while (cursor < members.length) {
      const index = cursor
      cursor += 1
      const plan = plans[index]
      if (plan === undefined) break
      const shown = relative(root, plan.tarball).replaceAll('\\', '/')
      if (plan.reuse) {
        const recorded = plan.recorded
        if (recorded === undefined) throw new Error(`release pack: ${plan.member.name} reused without a record`)
        reused += 1
        console.log(`release pack: reuse ${plan.member.name} digest=${plan.digest.slice(0, 16)} ${shown} (${plan.reason})`)
        rows[index] = reusedMember(plan, recorded)
      } else {
        console.log(`release pack: pack ${plan.member.name} (${plan.reason})`)
        rows[index] = await packMember(family, plan, destination)
      }
      order[index] = plan.filename
    }
  }))

  // A tarball the previous run left and this run does not produce is a member
  // that was removed, renamed, or version-bumped; only the record names it, so
  // only the record can retire it without touching another step's tarballs.
  const produced = new Set(order)
  for (const row of previous?.members ?? []) {
    if (produced.has(row.tarball)) continue
    rmSync(join(destination, row.tarball), { force: true })
    console.log(`release pack: removed ${row.tarball}, which this run does not produce`)
  }

  writeFileSync(join(destination, PUBLISH_ORDER_FILE), `${order.join('\n')}\n`)
  writeFileSync(manifestPath, `${JSON.stringify(newPackManifest({
    family: family.id,
    commit: packedCommit(root),
    packageManager,
    members: rows,
  }), null, 2)}\n`)

  console.log(
    `release pack: family ${family.id}, ${String(order.length)} tarball(s) in ${values.out ?? DEFAULT_OUTPUT}`
    + ` (${String(reused)} reused, ${String(order.length - reused)} packed)`,
  )
}

if (isEntry(import.meta.url)) await main()
