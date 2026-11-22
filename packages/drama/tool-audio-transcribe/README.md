---
description: "Transcribe authorized local media through the current Muse Account and keep versioned, timed project outputs."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-audio-transcribe

English | [中文](README.zh.md)

## Summary

The Host tool `audio_transcribe` turns a local audio or video file into a timed transcript through the signed-in Muse account. `start` saves an idempotent receipt before it asks the gateway to submit a billable cloud task; it also accepts an `inputs` list that submits several files in one call with one receipt per file. `inspect` only queries the original task and publishes completed TXT, JSON, and SRT under `transcript/raw/` without another upload. The existing `status` operation can recover an unaccepted task by uploading its staged audio under the original ID and may incur a charge.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Desktop mounts this tool in Standard, PTC, Creative, Editing, and Short Drama presets, excluding Minimal. Sign in to Muse Account before starting a task; the gateway separately enables transcription. The model cannot supply provider credentials.

```json
{"method":"start","project":"<project root>","input":"<authorized local audio or video>","language":"zh","purpose":"screenplay"}
{"method":"start","project":"<project root>","inputs":["<episode 1 media>","<episode 2 media>"],"language":"zh","purpose":"screenplay"}
{"method":"inspect","project":"<same project root>","receipt":"<start receipt path>"}
```

Use `purpose: "subtitles"` for subtitle timing through flash recognition, or `"screenplay"` for audio/video-to-script work through standard recognition. New tasks default to `subtitles`. The receipt and every audio part retain the resolved purpose; status and recovery use that value. An unfinished task cannot change purpose. If the same source needs the other purpose and the user has authorized the additional billable transcription, the caller must specify that purpose explicitly: the new task gets a separate versioned receipt and job ID while the old task remains intact. Omitting purpose cannot create a new cross-purpose billable task. Receipts without a purpose retain legacy routing, including during recovery. The gateway selects its standard version and private resources. Video-to-novel and video-to-script speech sources prefer authorized ASR; OCR supplements reliably visible text only for unsubmitted work after a confirmed full queue, with allocation based on measured throughput rather than a fixed ratio. An accepted queued task retains its paid identity; queued state alone does not establish exhausted pool capacity. Silent recognition is not a failure. OCR and ASR remain separate source evidence, and neither proves unobserved visual actions. Standard versions are not automatically treated as quality-equivalent or downgraded.

`start` takes either `input` or `inputs`, a list of 1 to `maxBatchInputs` files; both together, an empty list, or a longer list is an argument error. Before any probe, extraction, or upload, a batch rejects a list that names one file twice after relative paths are resolved, or an entry that is not a regular file. It then processes the files in list order, one upload at a time, and `items` returns one result per processed file in input order, each echoing the given string as `input`. Only in a batch, a file with a same-purpose unfinished, complete, silent, or failed receipt is returned from that receipt without another billable task; a single `input` creates a new version after a finished task. A receipt is reused only while its recorded source digest equals the current file's bytes; a file regenerated at the same path, or a finished legacy receipt without a source digest, starts a new version. Host tools that stage their own speech tracks import the receipt operations, `extractSpeechPcm`, `speechWavHeader` and `readPublishedSegments` from the `./runner` subpath. A receipt left `prepared` by a submission the gateway never confirmed is completed through the `status` routine, which queries first and uploads only under the original ID. The batch stops after a file whose own submission or recovery upload in this call was refused, or after a file that fails locally, reported as `{input, error}`; the remaining files are listed in `not_started`. Sending the same list again continues the batch and reuses every receipt already created. Pending items share one top-level `polling_note` instead of one note per item; a lifetime-quota note stays on its item.

`start` and `status` handle `upload_busy` and `request_rate` refusals themselves: when the refusal carries a whole-second `retry_after`, the tool waits that long and offers the same staged audio under the same ID again while the waiting budget `uploadRetryBudgetMs` lasts. One batch shares the budget, and only time spent waiting consumes it, so a long extraction does not use it up. The gateway refuses both codes before it records the ID and makes at most one billable submit per account and ID, so a retry cannot create a second task. A refusal whose delay exceeds the remaining budget, and every other refusal, returns at once; cancellation stops the wait.

Rate refusals report a safe `error_code`, the original receipt, and optional `retry_after_seconds` and `resume_status`. Wait as instructed, then resume that receipt. `status` queries first; after the gateway confirms an unaccepted task, it can upload the staged audio once under its original ID, which can incur a recognition charge. Account quota, expired login, and idempotency conflicts provide no immediate recovery call: resolve the reported blocker before explicitly resuming. `inspect` and `status` accept `wait_seconds` from 0 to 30 (default 0): within that delay budget the tool queries the original task at `pollIntervalMs`, publishes completed outputs, or returns the latest status. Individual requests retain their account timeout. Only the first query can recover an upload during `status`, and a refused recovery upload may be offered again under the same ID within the waiting budget; subsequent polling is read-only. Cancellation stops the delay and further queries. Pending results include `resume_status` and `polling_note`; local receipt files are snapshots and do not update without a tool query. `inspect_receipt` and upload-recovery blockers end native polling immediately. Split results include completed and total part counts. Safe `service_version`, `queued`, `error_code`, `provider_diagnostic`, and `recovery` fields are returned and retained by the receipt and its audio parts when available; old receipts may omit them. A failed receipt with `resume_upload` remains resumable: repeating `start` returns the original receipt, while explicit `status` permits at most one original-ID recovery upload per part. `poll_original` queries the original task, `wait` retains its identity, and `resume_upload` permits only an original-ID upload confirmed not submitted to the provider. `inspect_receipt` stops blind polling: an ended Flash request with `no_query` cannot recover a lost supplier response by waiting and never creates another paid task automatically. A client transport failure still queries the gateway before claiming provider uncertainty. An accepted task whose gateway record disappears is not automatically uploaded again. Split results expose a blocking part’s diagnostics; each original part’s metadata remains in the receipt. Returned absolute paths use `/` on every platform.

When `inspect` queries a task the gateway never accepted, such as after a refused first upload, it returns `preparing` with `error_code: "job-not-found"`, a `resume_status` that names `status` for the same receipt, and a note not to delete the receipt; it writes and uploads nothing. This applies to a `prepared` or `uncertain` receipt without a recorded service or recovery state whose staged audio still exists, and to a split part under the same conditions, which `diagnostic_job_id` names. A missing task that cannot be recovered, because its staged audio expired, a part's retention expired, or the receipt records an accepted service or recovery state, fails with `job-not-found`.

A relative `project` is resolved against the calling Session's workspace (its `cwd`), and a relative `input` or `receipt` against `project`; the Host process directory is never a base, and a relative `project` in a Session without a workspace is an argument error. `start` probes the source, extracts 16 kHz mono PCM WAV with FFmpeg, and stores the job ID and audio digest in `transcript/jobs/`. On Unix, tool-owned transcript directories use mode 0700 and staged audio, receipts, and published files use mode 0600. An uncertain submit retains the receipt. Query that receipt before another request; a confirmed absent server task can be retried with the same key and staged audio. A complete task writes `transcript/raw/<media>-vN.txt` , `.json`, and `.srt`; a silent task keeps only its receipt. The offline Python skill remains available only on an explicit offline request.

Cancelling a call stops active media extraction and HTTP requests, prevents later part submissions or queries, and waits for owned work to settle. Cancellation before a receipt is saved removes staged audio; a persisted receipt retains its audio and original IDs for a later explicit `status` call. An already accepted cloud task may still run and incur charges. Local writes already in progress settle before cancellation returns; no later output publication, receipt replacement, or staged-audio deletion starts. Already published files remain available for receipt-based reconciliation.

Local media commands reject timeout or excessive diagnostic output even when the terminated process exits successfully. Each command limits captured standard output to 65,536 characters and cumulative standard error to 65,536 bytes; extraction failures before a receipt is saved remove staged audio and make no paid submission.

| Config | Default | Meaning |
|---|---|---|
| `ffmpegPath`, `ffprobePath` | `ffmpeg`, `ffprobe` | Desktop supplies its bundled paths through `DSH_FFMPEG_PATH` and `DSH_FFPROBE_PATH`. |
| `commandTimeoutMs` | 600,000 | Local probe or extraction timeout. |
| `maxDurationSeconds` | 18,000 | Maximum media duration accepted locally. |
| `pollIntervalMs` | 2,000 | Delay between original-task queries within a bounded wait. |
| `chunkSeconds` | 600 | Maximum seconds per cloud job; source inputs remain bounded by `maxDurationSeconds`. |
| `maxAudioBytes` | 100,000,000 | Maximum extracted audio chunk size; the server enforces its own limit. |
| `uploadRetryBudgetMs` | 120,000 | Total delay one call spends waiting out `upload_busy` or `request_rate` before offering the same staged upload again; 0 returns the refusal at once. |
| `maxBatchInputs` | 10 | Largest `inputs` list one batch start accepts. |

Provider quota diagnostics distinguish ordinary polling from exhausted trial allowance. Known lifetime quotas return `inspect_receipt` and an operator notice to restore the original application's resource, while preserving the original task and receipt. `recovery.retry_after` is carried into `retry_after_seconds`; bounded waits do not poll before that delay. A later successful query clears obsolete failure fields and publishes the original task's result without another submission.

## Understand the implementation

The Host account service reads its origin-bound saved session and sends the audio to `POST /api/asr/jobs`, then queries `GET /api/asr/jobs/:id` under the same account. It never returns the cookie, signed TOS URL, or provider keys to the model. The gateway owns account isolation, quota, provider execution, and temporary audio cleanup. Standard jobs use private TOS objects; flash jobs send private staged audio directly. Unknown submissions retain their IDs for readback. The server's configuration and release procedure live in [`services/muse-accounts`](../../../services/muse-accounts/README.md).

The gateway selects standard or flash recognition. Flash uses the [recording-file flash API](https://www.volcengine.com/docs/6561/1631584?lang=zh), with at most two hours and 100 MB per request. The tool splits long inputs into configured chunks, keeps a source SHA-256 and per-part IDs in the receipt, then merges sentence and word timestamps onto the original media clock. Default ten-minute PCM chunks use about 19.2 MB each. Extraction trims resampled PCM by sample count and resets output timestamps, so compressed packet timestamps cannot extend a chunk. If a legacy receipt understates an already-submitted chunk, readback checks its original digest and actual staged duration before accepting speech beyond the planned range; out-of-audio timestamps still fail. The part retains this verified duration with its original identity and digest, so later queries preserve warnings and can rebuild missing outputs after staged audio cleanup. `timing_warnings` identifies these legacy chunks, retaining original text and timestamps with possible boundary overlap. Older receipts without a retained duration keep their complete published outputs readable; recovery verifies available original staged audio, or reports that it must be restored when the duration evidence and an output are missing. It never infers duration from recognition timestamps or submits another paid task to recover that evidence. No recovery upload is needed for completed tasks. Completed outputs publish atomically without overwriting different contents; repeated status calls reconcile identical outputs. Flash requests with unknown outcomes remain unresolved and are not automatically charged again.

The tool declares no concurrency safety, so `start`, `inspect`, and `status` calls in one message run one at a time, and it keeps no local upload queue. The gateway already serializes uploads per account, so parallel local uploads would only meet its pending-upload limit, and uploads and queries share its limit of 60 requests a minute per account, which parallel polling would exhaust. `inspect` also saves receipts and publishes outputs, and two concurrent starts of one source could both miss the receipt scan and create two billable versions.

Available speaker IDs are preserved in timed JSON; TXT and SRT retain their existing text-only format. Merging chunks prefixes each ID with its original job identity, so the same provider ID in separate tasks cannot silently merge voices. Completed output and cached readback include `speaker_summary`, computed from the actual JSON: total, labelled and unlabelled segment counts, observed acoustic-group count, and `available`, `partial` or `not_provided` coverage. Missing labels remain usable transcription and do not trigger resubmission. A group count is not a person count; one group does not establish one speaker. Character attribution requires separate audiovisual evidence; these labels provide neither timbre listening nor cross-episode identity verification.

No runtime invariant companion is published because task receipts and registered tools each have one owning storage or registry, with no independently observed state to reconcile.

## Model Experience

### The `audio_transcribe` tool

#### What the model sees

The [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-audio-transcribe) records the start/status schema. Results contain the status, receipt path, job ID, and completed output paths. Completed readback adds speaker-label coverage and a short advisory to consult `output_json` and verify character attribution against timed frames. A generic persisted tool card displays the call and result. A `queue_full` result prepends “Muse 转写队列已满，请稍后重试” to its unchanged JSON, identifying Muse's own queue rather than provider capacity; other error codes retain their existing output. A batch start returns `items` in input order, each a single-file result with its `input` or the `{input, error}` entry that ended the batch, plus `not_started` and one shared `polling_note`; the queue sentence appears once when any item has `queue_full`. A `screenplay` result that is `silent` prepends a note that silence from the service does not show the episode has no dialogue: check burned-in subtitles with `video_ocr` and mouths and frames with `video_inspect`, and, when dialogue is present, transcribe again once with a single `input` and `purpose: "screenplay"`, which creates a new billable version, because a batch returns the existing silent receipt; a second silent result is not retried and the subtitles and frames are used instead; the note appears once per batch. `inspect` of a never-accepted task returns `job-not-found` with a `status` call and a note not to delete the receipt. Media bytes, account cookies, object URLs, and provider credentials are omitted; tool calls and returned paths remain Session data.

#### Token effect

The optional purpose enum, the `inputs` parameter, and one description sentence about batches add a bounded request cost. Each result adds a short status, its receipt-bound purpose when present, and local paths; completed readback adds fixed-size speaker counts and an advisory, while a queue refusal adds one explanatory sentence. A batch result adds one result per processed file, the untouched paths in `not_started`, and one note instead of one per item, bounded by `maxBatchInputs`. Result typing that shows the batch branch, such as a PTC prompt, lists the result fields a second time inside `items`.

#### KV Cache effect

Tool results append without rewriting previous messages. The description and schema, including `inputs` and the batch result branch, belong to the reusable request prefix, so changing them changes that prefix.

## Known Limitations and Deferred Work

- Cloud recognition requires a signed-in Muse account and a deployed gateway with ASR configured. The tool does not fetch web links; source media must be readable locally.
- No speech produces no raw transcript. Provider timing and accuracy still require human review, and the offline model is never selected as an automatic fallback.
- If a remote task remains unresolved past retention, the gateway removes its temporary audio. The next `status` call removes the local staged audio while preserving the receipt and original job ID for read-only reconciliation.
- A batch call lasts about as long as all of its uploads together and reports no progress until it returns.
- Concurrent callers on one account compete for the gateway's pending-upload limit, and every retry is a new upload request that counts toward the per-minute request limit.
- `inspect` reports `job-not-found` as an error, without a recovery call, when the staged audio has expired or the receipt records an accepted service.

### Dev Note

Run the focused runner and account-client tests before changing receipt recovery or response validation. Gateway tests in `services/muse-accounts` cover account isolation, limits, and ambiguous provider submits without making paid calls.
