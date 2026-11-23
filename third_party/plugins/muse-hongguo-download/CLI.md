---
kind: package-reference
description: "Use the Hongguo download and task library from a model-free dsh profile."
---

# Hongguo command line

English | [中文](CLI.zh.md)

## Install

The `muse-hongguo-download/cli` export is a Cordis plugin, not a standalone executable. Install the ordinary plugin tarball into a new dedicated profile with `dsh plugin --profile hongguo add /absolute/path/muse-hongguo-download-0.2.2.tgz`. Apply the packaged `profiles/hongguo/cordis.patch.yml` as that profile's patch. The supplied profile manifest illustrates its base-plus-plugin bundle list; installation maintains the actual dependency entry. Keep an existing profile's configuration intact instead of replacing it with the example.

The profile boots no model runner, HTTP server, desktop account or browser. Configure absolute `ffmpegExecutable`, `ffprobeExecutable` and `bytevc2Executable` paths in the CLI row, or supply the environment variables shown in the example. Run from the intended workspace. Task records remain under that workspace's configured task directory; the dedicated profile stores only its stable local operator identity.

## Commands

```sh
dsh hongguo info --series 7702841940475120702
dsh hongguo download --series 7702841940475120702 --episodes 1,2 --quality 720p
dsh hongguo jobs
dsh hongguo status <task-id>
dsh hongguo pause <task-id>
dsh hongguo resume <task-id>
dsh hongguo cancel <task-id>
dsh hongguo retry <task-id>
dsh hongguo remove <task-id>
dsh hongguo merge <task-id> --series 7702841940475120702 --episodes 1,2 --mode auto --output combined.mp4
```

For `info` and `download`, repeat `--series` for several titles. Omit `--episodes` for the full catalog; provide comma-separated positive numbers for a selection. `--quality` accepts `1080p`, `720p` or `auto`; fixed quality never silently downgrades. `--output` may be relative to the workspace. An external absolute output requires explicit `--permission-mode danger-full-access`; the downloader still rechecks the real destination and refuses links. The default standing policy is workspace-write.

Download, resume and retry wait in the foreground. Ctrl+C requests joined cancellation and preserves verified progress; the CLI does not launch a detached daemon. Pause and cancel target an exact run: `--run-id` selects it explicitly, otherwise the CLI reads status first. `--request-id` reuses a stop-request identity. A pending request remains pending until the owning executor acknowledges completion. The CLI never signals a PID guessed from a task record.

New CLI tasks belong to the profile's local operator identity. `--owner-session` explicitly selects an existing Muse Session's records for inspection or control; it never changes a task's owner or invents a Session for a new CLI task. Use the same canonical workspace to find its tasks. Removing a task record preserves downloaded media.

## Merge

`merge` reads the source task's verified media without downloading missing episodes or changing that task's owner. `--series` selects one title; it may be omitted only when the task identifies one title. Omit `--episodes` to use the original recorded selection, or the entire series when no selection was recorded. Missing episodes cause an error rather than a partial merge being reported as the requested result.

`--mode auto` selects a supported method; `copy` requires compatible streams and fails when they cannot be safely concatenated; `compatible` produces H.264 with AAC when the source selection contains audio. `--output` accepts only a `.mp4` basename in the original checkpoint directory, including when full access is enabled. Omit it to use the merger's safe default name. Existing destinations and original episodes are preserved. Merging waits in the foreground and uses the same joined cancellation and file validation as the chat tool.

## Output

Results are one JSON line on stdout; `--json` is accepted for explicit automation. Progress is JSON on stderr. Exit codes are 0 for success, 1 for operation failure, 2 for invalid arguments, 3 for a pending control acknowledgement, and the dsh launcher's 130 for Ctrl+C. `--help` prints usage without creating an operator identity or task. No media URL, decryption key, account token or native diagnostic is printed.

## Verification

The CLI uses the same task and download library as Muse's chat tools. Tests of the executable path launch a built `dsh` with an ordinary plugin tarball in a dedicated profile; importing `cli.js` is not an application smoke. Main-profile changes, publishing the tarball and platform packaging are separate operations.
