# Cloud hit transcription

English | [中文](README.zh.md)

This worker takes one Hongguo series at a time from the Muse data station. The data station owns candidate ranking and lease expiry. Muse reviews a claimed candidate when the station requests it, downloads and checks the complete series, transcribes each episode in a dedicated SDK Session, and records progress on the data station.

Workshop uploads use the same episode runner and delivery verification. See the [Workshop integration](../../services/muse-workbenches/README.md).

## Requirements

- Use Python 3.11 or newer with the matching Harness Python SDK on its import path. Use the built `dsh` and Node from a qualified Linux source release.
- Provide a dedicated SDK home and its cloud transcription patch. Compose the existing speech, video inspection, OCR, manuscript checking, and Word export plugins in that patch. Provide the account session and the qualified media and Office runtimes through the same isolated deployment.
- Install the ordinary Hongguo plugin package in a separate `hongguo` profile. Configure its FFmpeg and FFprobe paths for Linux. See [Hongguo command line](../../third_party/plugins/muse-hongguo-download/CLI.md).
- Give the worker read access to the data station's private service token file. The station API listens on loopback. Use a new private state directory on the worker host.

## Start and inspect

Copy [config.example.json](config.example.json) to the deployment directory and populate its paths. `excludeCatalogs` reads the series IDs in each existing manual queue so the worker skips those series. `onlySeries` limits a pilot to selected series IDs. An empty list allows any eligible unclaimed series. Persist `stateRoot`, `workerId`, and both profile homes together across restarts.

1. Run `python3 -B worker.py /absolute/worker.json --check-runtime` to boot both profiles without a model request.
2. Run `python3 -B worker.py /absolute/worker.json --inspect` to read station counts and preview the next eligible series.
3. Run `python3 -B worker.py /absolute/worker.json --once` for the pilot. Use `--run` in a dedicated service for continuous work. Run it as the dedicated worker account with a process-group shutdown policy and write access to the state directory and the two profile homes.

`publishChecked` set to false retains the complete draft for content review and records the station outcome as 待处理. Use true for an authorized publication run. The station accepts the full Markdown screenplay, while the worker retains each episode's checked Word document. Automatic checks bind the Word and Markdown to the video, speech result, complete video review, and OCR. Content review is a separate step from these checks.

## Recovery

Keep the active receipt and the series directory after interruption. A restart checks the same station job and claims it with the same worker identity. Downloads resume the downloader's own task after the configured cooldown. Muse reuses checked episodes and resumes an incomplete episode in its original Session, with the original source, workspace, model, and profile. The speech tool admits one start for that episode and reads the existing job thereafter. Ambiguous ownership, a changed source, missing validation, or exhausted attempts require inspection.

Progress renews the lease. A lost lease stops the current native process. A failed report can be reconciled against the station on restart. Immutable episode receipts, the full-script manifest, and the station outcome remain in the private series directory.

## Local verification

Run `python3 -B -m unittest discover -s integrations/muse-hit-transcription -p 'test_*.py'` from the repository root. The tests use a loopback station and scripted native stages, covering claim loss, restart, media integrity, retention of partial downloads, and publication response loss. Verify the actual Linux media paths with `--check-runtime` and a narrow pilot before continuous use.
