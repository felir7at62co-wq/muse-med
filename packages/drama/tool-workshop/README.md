---
description: "Let Muse start, stop, resume and report Script Workshop's 视频转剧本 factory job, upload finished scripts to the Workshop's finalized-script library, and read them back for production."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-workshop

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-tool-workshop` registers Muse's Script Workshop tools, which act as the signed-in Muse user through `ctx.workshopConnection`. `workshop_video_transcribe` reports, starts and stops the 视频转剧本 factory job with the five parameters of the Workshop pipeline card: the job claims series from the data station's hit queue, downloads each complete Hongguo series, transcribes every episode with cloud Muse and stores the result as a Workshop script. `script_finalize` uploads a finished script to the finalized-script library after the user agreed; `script_library` reads a library version back and records the Jingliu project it became.

## Table of Contents

- [Use this package](#use-this-package)
- [Actions](#actions)
- [Finalized scripts](#finalized-scripts)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in an Agent preset; the Desktop `short-drama` and `short-drama-v2` presets mount it with `autoStartNamedSeries` read from `MUSE_WORKSHOP_AUTOSTART_NAMED` (`1` only on cloud Muse). It registers the tool once the Host provides `workshopConnection` from `@deepseek-ai/dsh-workbench-connection` and removes it when that service goes away, so a composition without the Workshop connection offers no Workshop tool. Starting or resuming a job asks the user through the Host `approval` service; without it, `start` and `resume` fail with `WORKSHOP_APPROVAL_REQUIRED`. With `autoStartNamedSeries` (default false), `start` and `resume` skip that approval for a job that names its dramas in `only_series`; a job without named dramas still asks, and the tool description tells the model which jobs proceed directly. Cloud Muse sets it so Bots transcribe unattended within the Workshop's slot limit. In the Desktop composition the tool is loaded on demand through `tool_search` under the 剧本工坊 capability; it is not resident. `script_finalize` and `script_library` also need the `fs` and `sandboxPolicy` services and resolve paths against the conversation's workspace; both sit under the same capability.

<a id="actions"></a>
## Actions

| Action | Workshop requests | Result |
| --- | --- | --- |
| `status` | `GET /factory/video-transcribe/status`, then `GET /factory/jobs?limit=50` | `{ service, jobs }`: readiness, the station queue counts, `max_slots`, and the ten newest 视频转剧本 jobs with their state, progress line and delivered, attention and rejected totals |
| `status` with `job_id` | the readiness request, then `GET /factory/jobs/{job_id}` | `{ service, job }`: the job's parameters, slot states and the 20 newest entries of each outcome list |
| `start` | the readiness request, user approval, then `POST /factory/jobs` with `job_type: video_transcribe` | `{ job_id, config }` with the parameters sent |
| `stop` | `GET /factory/jobs/{job_id}`, `POST /factory/jobs/{job_id}/stop` while the job is pending or running, then the job again | `{ stop_requested, job }` |
| `resume` | `GET /factory/jobs/{job_id}`; for a stopped, failed or completed job the readiness request, user approval, `POST /factory/jobs/{job_id}/resume`, then the job again | `{ resumed, job }` |

`start` applies the pipeline card's defaults: `count` 0 (run until stopped), `concurrency` 1, `quality` `720p`, `publish` false and no `only_series` (queue order). `concurrency` must not exceed the deployment's `max_slots`; `only_series` takes Hongguo series IDs of 15 to 25 digits and drops duplicates. A step that is not ready fails with `WORKSHOP_TRANSCRIBE_UNAVAILABLE` and the operator's reason. When the Workshop does not confirm the new job, `start` fails with `WORKSHOP_JOB_OUTCOME_UNKNOWN` and tells the model to check `status` before trying again. A job of another type fails with `WORKSHOP_NOT_TRANSCRIBE_JOB`; a job of another user or a missing one fails with `WORKSHOP_JOB_NOT_FOUND`. Stopping keeps every claimed series; a finished job is reported with `stop_requested: false` and no stop request. `resume` continues the same job with its saved parameters and claimed series; the approval card lists those parameters. A job that is still pending or running, or is running again when the Workshop answers 409, is reported with `resumed: false`. A Workshop that does not confirm `resumed: true` fails the call with `WORKSHOP_RESUME_UNSUPPORTED`.

The pending card title names the action and job, and a `start` card shows the parameters with defaults applied. The completed card title is derived from the persisted result facts: the new job, the stop request, a job's state and percentage, or the readiness and job count.

<a id="finalized-scripts"></a>
## Finalized scripts

`script_finalize` uploads a finished script as a new version of the member's library entry: `POST /script-library` with the title, rights, form, style, the source work's data-station ID and one text per episode. A file with 第N集 headings splits at them; a file without takes the number in its name, else its place in the list. The tool checks the Workshop's limits first (300 episodes, 60,000 characters per episode, 3,000,000 in all) and names the failing episode. The member's entry with the same title receives the new version, and an unchanged text adds none. A licensed adaptation needs `origin`. When the Workshop does not confirm the upload, the tool fails with `WORKSHOP_FINALIZE_OUTCOME_UNKNOWN`. In the Desktop `short-drama-v2` preset the tool runs once `muse-manuscript-delivery` is in effect, and that skill has Muse ask the user with `ask_user_question` before finalizing.

`script_library` `read` writes one version, the newest by default, to `剧本库/<title>-v<version>/第NNN集.md` in the workspace, each file headed with its 第N集 line so `script_finalize` reads it back as the same episodes, and returns the paths. `link` records the Jingliu project ID and title of a picked script with `POST /script-library/{id}/production`, which moves it to 已投产. Picking a version is a lead's action in the Client's 剧本 tab, not a tool action.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workbench connection](../workbench-connection/README.md) — how the tool signs in to the Workshop as the Muse user.
- [Tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-workshop) — the generated schema.

-----

<a id="model-experience"></a>
## Model Experience

### 视频转剧本 tool

#### What the model sees

The [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-workshop) owns the schema and description. In the Desktop composition the definition reaches a request only after `tool_search` loads it; the 剧本工坊 capability and the search keywords name it. Each successful result is the action and its report fields as JSON; failures carry a `WORKSHOP_*` or `INVALID_ARGS` code with a Chinese message.

#### Token effect

A loaded definition adds a fixed schema. A `status` list is about one line per job for at most ten jobs; a single-job report is bounded by the slot count and 20 entries per outcome list, each title and reason cut to 200 characters, under about 2,000 tokens.

#### KV Cache effect

The definition text is fixed; loading it on demand adds it to later requests of that conversation. Results are ordinary tool results appended after the reusable prefix.

### Finalized-script tools

#### What the model sees

Both definitions load on demand under the 剧本工坊 capability, as the 视频转剧本 tool does. `script_finalize` returns the script ID, title, version, whether the text was new, its stage and size; `script_library` returns the version, stage, folder and file paths for `read`, and the stage and project for `link`.

#### Token effect

Each loaded definition adds a fixed schema. A `read` result lists one path per episode, at most 300; the script text goes to workspace files, not into the result.

#### KV Cache effect

The definitions are fixed; results are appended after the reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Resume needs the updated Workshop** — a Workshop release without the 视频转剧本 branch of `POST /factory/jobs/{id}/resume` answers with its outline recovery; the tool reports `WORKSHOP_RESUME_UNSUPPORTED` instead of a resumed job.
- **No duplicate-start check** — `start` does not refuse when another 视频转剧本 job is running; jobs share the deployment's slots, so the second job only takes free ones.
- **Recent jobs only** — `status` without `job_id` scans the 50 newest factory jobs of all types; an older 视频转剧本 job needs its `job_id`.
- **No pick for the model** — Muse cannot pick a version; leads pick in the Client's 剧本 tab, and the Workshop refuses `link` for a script nobody picked.
- **`read` overwrites** — `read` replaces the files of the same version folder without checking for local edits.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The Workshop side is `services/muse-workbenches/video_transcribe.py` and `install_transcribe.py` on branch `muse/workshop-transcribe-workflow`; `options()` there is the shared parameter check this tool mirrors. The finalized-script library is `script_library.py` and `install_scripts.py` on the same branch.

</details>
