# Drama Render File-Capture Design

## Problem
`drama_render prepare` cannot probe valid media in the DSH Windows runtime because `createSpawnChannel` captures child stdout/stderr through Node pipes, while this runtime rejects piped child stdio with EPERM. Independent FFprobe confirms the media is valid.

## Approved approach
Keep the existing `ProcessChannel` contract and all FFmpeg parsing unchanged. Add a Windows-safe channel that redirects stdout/stderr to unique temporary files, reads them after process exit, then removes them. Make `createMediaToolkit` use this channel by default. Preserve injected channels and existing error semantics.

## Acceptance criteria
- Real child stdout and stderr are captured without `stdio: pipe`.
- Non-zero exits preserve stderr and exit code.
- Missing executables report code 127.
- Temporary files are removed on success and failure.
- Existing renderer tests pass.
- `drama_render prepare` successfully probes project media.
