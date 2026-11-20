---
description: "Let Muse report, start and stop Script Workshop's 视频转剧本 factory job with the parameters of the Workshop pipeline card."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-workshop

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-tool-workshop` registers the model-facing `workshop_video_transcribe` tool. It is the Muse entry to Script Workshop's 视频转剧本 step: a factory job that claims series from the data station's hit queue, runs the station's audience review, downloads the complete Hongguo series and transcribes every episode with cloud Muse, then stores each delivered series as a Workshop script. The tool sends the same five parameters as the Workshop pipeline card, as the Muse user who is signed in. The Workshop owns the job, its slots and its results; this package only calls its factory API through `ctx.workshopConnection`.

## Table of Contents

- [Use this package](#use-this-package)
- [Actions](#actions)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in an Agent preset; the Desktop `short-drama` preset, which every Bot uses, mounts it with no configuration. It registers the tool once the Host provides `workshopConnection` from `@deepseek-ai/dsh-workbench-connection` and removes it when that service goes away, so a composition without the Workshop connection offers no Workshop tool. Starting a job asks the user through the Host `approval` service; without it, `start` fails with `WORKSHOP_APPROVAL_REQUIRED`. In the Desktop composition the tool is loaded on demand through `tool_search` under the 剧本工坊 capability; it is not resident.

<a id="actions"></a>
## Actions

| Action | Workshop requests | Result |
| --- | --- | --- |
| `status` | `GET /factory/video-transcribe/status`, then `GET /factory/jobs?limit=50` | `{ service, jobs }`: readiness, the station queue counts, `max_slots`, and the ten newest 视频转剧本 jobs with their state, progress line and delivered, attention and rejected totals |
| `status` with `job_id` | the readiness request, then `GET /factory/jobs/{job_id}` | `{ service, job }`: the job's parameters, slot states and the 20 newest entries of each outcome list |
| `start` | the readiness request, user approval, then `POST /factory/jobs` with `job_type: video_transcribe` | `{ job_id, config }` with the parameters sent |
| `stop` | `GET /factory/jobs/{job_id}`, `POST /factory/jobs/{job_id}/stop` while the job is pending or running, then the job again | `{ stop_requested, job }` |

`start` applies the pipeline card's defaults: `count` 0 (run until stopped), `concurrency` 1, `quality` `720p`, `publish` false and no `only_series` (queue order). `concurrency` must not exceed the deployment's `max_slots`; `only_series` takes Hongguo series IDs of 15 to 25 digits and drops duplicates. A step that is not ready fails with `WORKSHOP_TRANSCRIBE_UNAVAILABLE` and the operator's reason. When the Workshop does not confirm the new job, `start` fails with `WORKSHOP_JOB_OUTCOME_UNKNOWN` and tells the model to check `status` before trying again. A job of another type fails with `WORKSHOP_NOT_TRANSCRIBE_JOB`; a job of another user or a missing one fails with `WORKSHOP_JOB_NOT_FOUND`. Stopping keeps every claimed series; a finished job is reported with `stop_requested: false` and no stop request.

The pending card title names the action and job, and a `start` card shows the parameters with defaults applied. The completed card title is derived from the persisted result facts: the new job, the stop request, a job's state and percentage, or the readiness and job count.

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

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No resume of a stopped job** — a stopped standalone job keeps its claimed series, but only a Workshop pipeline run can resume it; `start` creates a new job.
- **No duplicate-start check** — `start` does not refuse when another 视频转剧本 job is running; jobs share the deployment's slots, so the second job only takes free ones.
- **Recent jobs only** — `status` without `job_id` scans the 50 newest factory jobs of all types; an older 视频转剧本 job needs its `job_id`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The Workshop side is `services/muse-workbenches/video_transcribe.py` and `install_transcribe.py` on branch `muse/workshop-transcribe-workflow`; `options()` there is the shared parameter check this tool mirrors.

</details>
