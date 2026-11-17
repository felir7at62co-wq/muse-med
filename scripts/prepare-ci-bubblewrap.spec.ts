/** Transport fallback must retain the pinned payload check before sandbox setup. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const script = resolve(import.meta.dirname, 'prepare-ci-bubblewrap.sh')
const primary = 'https://launchpad.net/ubuntu/+source/bubblewrap/0.12.0-1/+build/33546835/+files/bubblewrap_0.12.0-1_amd64.deb'
const fallback = 'https://archive.ubuntu.com/ubuntu/pool/main/b/bubblewrap/bubblewrap_0.12.0-1_amd64.deb'

// Only the child's external commands are substituted. The production shell
// still chooses the URL, enforces digest failure and runs the functional probe.
const commands = String.raw`
uname() { if [[ "$1" == '-s' ]]; then echo Linux; else echo x86_64; fi; }
curl() {
  local url
  for url in "$@"; do :; done
  local output=''
  while (( $# > 0 )); do
    if [[ "$1" == '--output' ]]; then output="$2"; shift; fi
    shift
  done
  printf '%s\n' "$url" >> "$RUNNER_TEMP/requests"
  if [[ "$FIXTURE_MODE" == 'all-fail' || "$url" == *launchpad.net* && "$FIXTURE_MODE" == *fallback* ]]; then
    printf partial > "$output"
    return 22
  fi
  printf payload > "$output"
}
sha256sum() {
  local digest archive
  read -r digest archive
  [[ "$digest" == 'db4d572a7927bfd34cc9b8e24b56983efa8e0483d03da6c810f6caae081dcc36' ]] || return 91
  [[ "$(cat "$archive")" == payload ]] || return 92
  [[ "$FIXTURE_MODE" != *corrupt* ]] || return 1
  printf verified > "$RUNNER_TEMP/verified"
}
dpkg-deb() {
  [[ -f "$RUNNER_TEMP/verified" ]] || return 93
  [[ "$1" == '--extract' ]] || return 94
  mkdir -p "$3/usr/bin"
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "$RUNNER_TEMP/probes"\n' > "$3/usr/bin/bwrap"
  chmod +x "$3/usr/bin/bwrap"
}
sudo() { return 1; }
source "$1"
`

it.skipIf(process.platform === 'win32').each([
  { mode: 'primary', requests: [primary], accepted: true },
  { mode: 'fallback', requests: [primary, fallback], accepted: true },
  { mode: 'all-fail', requests: [primary, fallback], accepted: false },
  { mode: 'primary-corrupt', requests: [primary], accepted: false },
  { mode: 'fallback-corrupt', requests: [primary, fallback], accepted: false },
])('keeps digest and functional checks for $mode transport', ({ mode, requests, accepted }) => {
  const root = mkdtempSync(join(tmpdir(), 'ci-bubblewrap-transport-'))
  try {
    const path = join(root, 'github-path')
    const child = spawnSync('bash', ['-c', commands, 'bubblewrap-fixture', script], {
      env: { PATH: process.env.PATH, RUNNER_TEMP: root, GITHUB_PATH: path, FIXTURE_MODE: mode },
      encoding: 'utf8', timeout: 10_000,
    })
    expect(child.error).toBeUndefined()
    expect(child.signal).toBeNull()
    expect(child.status, child.stderr).toBe(accepted ? 0 : 1)
    expect(readFileSync(join(root, 'requests'), 'utf8').trim().split('\n')).toEqual(requests)
    expect(existsSync(path)).toBe(accepted)
    expect(existsSync(join(root, 'probes'))).toBe(accepted)
    if (accepted) {
      expect(readFileSync(join(root, 'probes'), 'utf8').trim().split('\n')).toEqual([
        '--version', '--ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true',
      ])
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
