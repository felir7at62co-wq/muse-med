# Company media snapshot

English | [中文](README.zh.md)

This keyless scenario launches the shipped `headless` profile, discovers the four production company-media tools, and uses the real Muse account transport, local importer and `present` tool. An isolated loopback gateway supplies public metadata, an unfinished download, the original task's completed receipt, a repeated submission, a partial manifest, and HTTP rate and permission failures. Its synthetic login remains in a private temporary account directory.

The committed one-second H.264 fixture passes the real FFprobe and FFmpeg commands selected from `PATH`. Missing executables fail the scenario. The complete `workspace.expected/` tree checks the imported bytes, fixed source receipt fields and independent verification report; only the receipt's declared working-directory token is expanded. The production `present` call must persist a `deliverables/presented` event. A partial job's unlisted file remains unavailable.

Run the read-only replay from the repository root:

```sh
pnpm exec vitest run --config vitest.snapshot.config.ts snapshots/session/headless.snapshot.ts -t 'muse-media-tools|company media expected workspace'
```

To harvest current production output from the authored model responses, refresh only this scenario and review every generated diff:

```sh
DSH_SNAPSHOT=refresh pnpm exec vitest run --config vitest.snapshot.config.ts snapshots/session/headless.snapshot.ts -t 'muse-media-tools'
```

The scenario calls no live model or platform and reads no production login. It checks the assembled tool, file and delivery behavior; it does not establish live platform availability or GUI acceptance.
