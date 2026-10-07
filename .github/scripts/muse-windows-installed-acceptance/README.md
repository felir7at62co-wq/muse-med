# Original Windows installer acceptance utility

This private utility verifies and installs the original Windows x64 artifact from run `37567499544`, artifact `11460053986`. The mandatory `MUSE_CI_TRANSFER_SOURCE_COMMIT` configuration must match the artifact record, source checkout and installed application. It creates no build or release output and makes no update-feed or publication request. Run only on a new disposable GitHub Actions `windows-2025` runner; both scripts reject another execution environment.

The original ZIP contains five flat files. The extra `builder-debug.yml` diagnostic must match its fixed 7,902 bytes and SHA-256; it remains outside the three published files declared by the unsigned build record.

The raw ZIP must have `766360946` bytes and SHA-256 `88ebf218fcc748dd620443b0565cc7be4ad4be0c768b684598299cd4230c4c47`. Supply fresh GitHub artifact metadata obtained by `gh api repos/felir7at62co-wq/muse-med/actions/artifacts/11460053986`; the utility matches its ID, exact name, size, digest, expiration, workflow-run ID `37567499544`, exact source head and repository identity. The installed EXE, sidecar blockmap and `latest.yml` must also match every SHA-256, SHA-512 and size in `unsigned-build.json`.

Check out the exact source commit for the existing smoke helpers and run `pnpm install --frozen-lockfile` with the repository's pinned pnpm. Do not run a build or packaging command. Preserve these utility files at `.artifacts/muse-release-20261006-gxgg057c/windows-audit/` so `accept-installed.ts` can resolve the helpers from the same checkout. The TypeScript imports resolve `../../../apps/desktop` relative to the utility file: both utility files must therefore sit together exactly three directories below the checked-out repository root. `.artifacts/muse-windows-acceptance/helpers/` and `.github/scripts/muse-ci-transfer/` are also valid layouts. Running them directly from `RUNNER_TEMP` is invalid. If an operations workflow stores them temporarily before checking out the application commit, copy them into one of these repository-relative layouts after checkout. Its workflow commit does not become the application source commit.

The caller downloads the raw artifact ZIP into its chosen fixed path and saves the fresh API response to an untracked file. The invocation is:

```powershell
$errors = $null
$tokens = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(
  '.artifacts/muse-release-20261006-gxgg057c/windows-audit/accept-original-installer.ps1',
  [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw 'Acceptance utility has a PowerShell parse error' }
pwsh -NoProfile -File .artifacts/muse-release-20261006-gxgg057c/windows-audit/accept-original-installer.ps1 `
  -ArtifactZip $fixedWinZip -ArtifactMetadata $artifactMetadataFile `
  -EvidenceRoot (Join-Path $env:RUNNER_TEMP "muse-installed-acceptance-$env:GITHUB_RUN_ID") `
  -SourceRoot $env:GITHUB_WORKSPACE -PrepareBundledVisualCpp
if ($LASTEXITCODE -ne 0) { throw 'Original Windows installer acceptance failed' }
```

The utility uses the runner's 7-Zip to extract the NSIS container and its original `app-64.7z`. It verifies the embedded `vc_redist.x64.exe` against the locked size, complete hash and valid Microsoft signature. `-PrepareBundledVisualCpp` authorizes installation of that exact bundled prerequisite only on this disposable runner when its installed runtime is below `14.51.36247.0`. A prerequisite result requiring a restart is refused. This preparation does not qualify the installer's interactive administrator-consent flow; silent installation defaults to declining the prerequisite when it is missing.

The same verified Muse EXE installs into a new directory beneath `RUNNER_TEMP` with `/S /currentuser /no-desktop-shortcut /D=<directory>`; `/D=` is last, and no `/force-run` is supplied. The shipped assisted installer does not launch the GUI in this silent mode. Only desktop-shortcut creation can be disabled through its supported runtime flag; the shipped installer may create a Start-menu link on this disposable runner. The utility refuses a pre-existing Muse process.

After exit code zero, it checks installed executable version fields, ASAR product version, application ID, exact source commit and clean-build marker. It compares every original application payload file with the installed counterpart by complete SHA-256 and byte count, rejects unexpected installed files outside the four exact installer-generated names, and records one inventory digest. The two 7-Zip bootstrap licenses must match the same original EXE's extracted NSIS files by complete size and SHA-256, and remain unchanged after the runtime smoke. It checks the exact private filenames `.env`, `.env.windows`, `.env.macos` and `devices.json` in both physical payload and ASAR. Hongguo's runtime allowlist carries `devicepool.pyc` and a validated generic `config.json`; saved `devices.json` is excluded. The owned-download archive test also rejects a `devices.json` archive member and passed in the original build workflow. This is a filename exclusion check, not a universal secret scan.

The existing `smokePreparedRuntime` checks the sealed complete archived dsh descriptor, ASAR and unpacked file membership and bytes; runs native Koffi, Sharp, PTY, pnpm, ripgrep and HTML checks with a fresh native cache; starts the shipped Hongguo Java signer on loopback and its CPython offline/AES probes with joined cleanup; and runs the normal packaged Host/profile smoke, six product presets, skills, real DOCX/XLSX/PPTX conversion and shipped Office CLI with empty PATH. All source control scripts come from the exact application commit, while executable code under test comes from the installed application. The utility hashes every installed original payload member again after the smoke.

Retain `installer-result.json`, `installed-acceptance.json` and the three private diagnostic logs regardless of success. Upload only those five files plus the raw artifact identity receipt; do not upload the full extracted/installed directories. The reports distinguish completion from failed or interrupted execution. Existing build diagnostics are under `diagnostics/2026-10-07T03-38-10.210Z-2mOji5/` and prove the original build's success; they do not prove that this acceptance utility has run.

The result supports silent installation and installed native/runtime behavior on a provisioned GitHub Windows runner. It does not establish an interactive GUI install, real Hongguo/Fanqie/Douyin network downloads, end-user sign-in, a machine without development tools, installer prerequisite consent, EV signing/SmartScreen behavior, update installation or uninstall behavior. Those require separate target-machine evidence. The prior `final-installer-live` fixture is explicitly macOS ARM64 and cannot serve as Windows evidence.
