---
description: "Durable independent TTS and explicit character-period voice references."
kind: "reference"
---

# Muse audio operations

English | [中文](audio.zh.md)

`planMuseAudio` installs the owned audio services after `planCloudPrefix`. It removes credential logging and fabricated zero usage from the upstream TTS service, and replaces automatic project-wide voice fallback with an explicit storyboard binding. The production page's **Sounds and speech** dialog and the logged `localmini_voice` / `localmini_tts` tools share upload, playback, history and explicit adoption. Existing audio files remain available.

## Independent TTS

Select a storyboard, dialogue or narration, an enabled OpenAI/MiniMax TTS configuration, and a native supplier voice ID. Uploading a reference does not clone a TTS voice. Generation reserves its `operation_id` in SQLite before supplier dispatch. Identical replays return the original generation; changed inputs with the same ID fail. A concurrent request does not submit another supplier call. Interrupted or uncertain calls remain `unknown` and are never automatically dispatched again. A different UUID cannot repeat the same unresolved request: the input fingerprint check and generation reservation share an immediate SQLite transaction.

Original returned bytes are saved under the operation's fixed path and SHA-256. FFprobe must identify audio, and FFmpeg must decode the complete file, before the generation becomes completed. Completion does not adopt the audio. Adoption verifies the original SHA again and updates the storyboard and selected version in one database transaction; failed binding never reports success. Recovery checks only the original saved file and never calls the supplier. History distinguishes independent TTS from the video's original sound. New records retain immutable original speech text and its SHA; legacy rows without the original text return null rather than a guessed reconstruction. The UI can copy retained text into the editing field. Supplier usage is unreported, not zero.

The adapter reuses the upstream [OpenAI speech](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create) binary client and [MiniMax synchronous TTS](https://platform.minimax.io/docs/api-reference/speech-t2a-http) hex-audio client. OpenAI input is limited to 4,096 characters; MiniMax input must be below 10,000. MiniMax uses the configured base URL or `https://api.minimax.io`, with `/v1/t2a_v2`; the legacy GroupId query is not used. This MiniMax adapter accepts speed 1 only. No provider request or model permission is verified by saving configuration.

`cancel_wait` records persistent cancellation intent and stops the UI's local wait. The reused synchronous supplier clients have no confirmed remote-cancellation operation; the original call may still complete and incur a charge. Cancellation never marks the supplier cancelled, clears an unknown outcome or authorizes another paid attempt. Inspect the same generation in history; recovery reads only retained original bytes.

`localmini_tts` exposes `capabilities`, `generate`, `history`, `get`, `recover`, `adopt` and `cancel_wait`. Generation requires explicit speech text, kind, configuration, configured model, supplier voice and speed. Its first attempt uses the free budget quote before creating a Host receipt; missing or insufficient project authorization/price blocks this attempt without synthesis, while an existing original receipt is replayed without a new quote. The supplier reservation still checks the budget again in the dispatch transaction. Only the owner configures amounts in the studio. Writes pin the current `database_id`; cloud writes also require the current `account_id`. Original generation and adoption operation IDs are distinct. Provider credentials remain private in the studio.

## Formal video voice references

Each uploaded version names an exact character and explicit life period. The file must be a 2–30-second WAV with one audio stream, one or two channels, and signed 16/24/32-bit integer PCM. Existing 15-second versions remain unchanged. The stored bytes and asset SHA are immutable; selection is separate. Upload and adoption never infer a life period from costume, episode or name.

A package binding names each exact voice asset, character, period and SHA in upload order. Zero references explicitly clears it; up to ten distinct character-period references can be saved. Repeating a character-period with ambiguous versions is refused. Saving compares the previous binding's `operation_id`; voices must belong to characters actually bound on this package. Ordinary image edits preserve the current voice selection. The provider publishes the whole ordered mapping, and an unknown save reconciles by readback without another PUT.

The [Ark creation API](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh&redirect=1) defines the per-model reference limits. Under `volcengine_omni`, known Seedance 2.5 profiles accept at most ten audio references, each 2–30 seconds and at most 30 seconds in total. Known Seedance 2.0 profiles accept at most three references, each 2–15 seconds and at most 15 seconds in total, with an image or video input. Official profiles require the official origin and an exact documented model ID; aliases require an explicit `settings.muse_model_capabilities[model].profile`. Other models/protocols remain unsupported or unknown. Split packages explicitly or use independent TTS; the adapter never silently drops audio or automatically creates paid subrequests.

The actual Ark request contains each verified original WAV as `reference_audio`, followed in the prompt by its numbered character/life-period mapping, following the [official multi-reference guidance](https://docs.volcengine.com/docs/ark/seedance-2-5-prompt-guide?lang=zh). Native generation attempts freeze their ordered input metadata in immutable history, even if later model validation rejects dispatch. Clearing or changing a current binding does not rewrite those earlier inputs. File SHA, request size and model limits are checked before supplier dispatch. Raw audio fields on the ordinary video endpoint are refused rather than ignored; use the formal binding API. These checks establish submitted inputs, not acoustic identity, cloning quality, account permission or successful paid acceptance.

`localmini_voice` exposes `capabilities`, `inventory`, `upload`, `adopt`, `binding`, `bind` and `video_inputs`. Upload reads a bounded regular file inside the initiating Session workspace through its filesystem provider; receipt metadata retains the exact SHA. Saved references do not clone an OpenAI/MiniMax TTS voice. Native audio assets and history remain usable, but do not establish that the current Jubian model accepts voice references. Jubian video uses only supplier inputs explicitly listed in its preparation; missing support must stop and be reported rather than described as a successful voice binding.

## HTTP API

All paths below start with `/api/v1/muse/audio`. Existing `/api/v1/audio/extract` and `/extract/batch` use the same durable generation service and require operation IDs.

| Method and path | Action |
| --- | --- |
| `GET /capabilities?config_id=…&model=…` | Private-key-free TTS choices/database identity; optional exact video model voice limits |
| `GET /voices?drama_id=…` | Version inventory, adopted state and adapter capabilities |
| `POST /voices` | Multipart `file`, `character_id`, `voice_period_id`, `operation_id` |
| `POST /voices/:id/adopt` | Select this character-period version with `operation_id` |
| `GET /video-bindings/:storyboardId` | Exact current binding; a missing storyboard returns 404 |
| `PUT /video-bindings/:storyboardId` | `{operation_id,expected_operation_id,voices:[{voice_asset_id,character_id,voice_period_id,sha256}]}`; first binding expects `null` |
| `GET /video-inputs?storyboard_id=…` | Immutable generation-attempt speaker mappings |
| `POST /tts` | `{operation_id,storyboard_id,tts_kind,config_id,model,voice_id,text,speed}`; no automatic adoption |
| `GET /tts?storyboard_id=…` / `GET /tts/:operationId` | Original generation metadata and selected state |
| `POST /tts/:operationId/recover` | Verify the original file only |
| `POST /tts/:operationId/cancel` | Stable `operation_id`; record cancelled waiting without asserting supplier cancellation |
| `POST /tts/:operationId/adopt` | `{operation_id,sha256}`; verify and explicitly select completed audio |

The UI persists only request fingerprints and operation UUIDs, scoped by the database identity; it does not store speech text in its operation cache. Failure to persist an operation ID stops dispatch. Explicitly creating another version can incur another supplier charge. Refresh and inspect unknown generations before doing so.

## Storage and verification

The owner applies complete SQL, including immutable-asset triggers, under monotonic `muse_audio_schema` version 2. Its transaction migrates version 1 forward without rewriting existing voice assets or audio bytes; old original speech text remains unavailable when it was never saved. It does not edit or use the upstream semicolon-splitting migration runner. Back up the existing SQLite database and complete storage directory together. `muse_audio.request_timeout_ms` defaults to 120,000, accepts 1,000–900,000; `probe_timeout_ms` defaults to 30,000, accepts 1,000–300,000.

Run `node --test integrations/localminidrama/tests/muse-audio.test.mjs`. Fixtures use private SQLite databases, loopback HTTP suppliers and real FFmpeg/FFprobe. They verify replay, unknown outcomes, invalid audio, database failures, immutable voice versions, exact ownership, HTTP routes and UI operation persistence. `FFMPEG_PATH` and `FFPROBE_PATH` select test binaries. Missing-tool skips are not acceptance evidence. The owner suite also covers multiple explicit speakers through the actual Ark builder, rejection before dispatch, schema migration and cancellation intent without duplicate synthesis. The independent `snapshots/session/muse-localmini-audio` case replays a readonly Muse turn with these tools; it does not call a supplier. No real supplier credentials, paid generation or acoustic identity test is included.
