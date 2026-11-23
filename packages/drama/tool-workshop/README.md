---
description: "Let Muse upload finished scripts to Script Workshop's finalized-script library, read them back for production, and stage single-episode revisions of cloud drafts for review."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-workshop

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-tool-workshop` registers Muse's Script Workshop tools, which act as the signed-in Muse user through `ctx.workshopConnection`. `script_finalize` uploads a finished script to the finalized-script library after the user agreed; `script_library` reads a library version back and records the Jingliu project it became. `workshop_script_editor` reads cloud drafts and stages a single-episode candidate for the editor to review.

## Table of Contents

- [Use this package](#use-this-package)
- [Finalized scripts](#finalized-scripts)
- [Cloud draft editing](#cloud-draft-editing)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in an Agent preset; the Desktop `short-drama` and `short-drama-v2` presets mount it. The plugin has no configuration. It registers `workshop_script_editor` once the Host provides `workshopConnection` from `@deepseek-ai/dsh-workbench-connection` and removes it when that service goes away, so a composition without the Workshop connection offers no Workshop tool. `script_finalize` and `script_library` also need the `fs` and `sandboxPolicy` services and resolve paths against the conversation's workspace. In the Desktop composition the three tools are loaded on demand through `tool_search` under the 剧本工坊 capability; none is resident.

<a id="finalized-scripts"></a>
## Finalized scripts

`script_finalize` uploads a finished script as a new version of the member's library entry: `POST /script-library` with the title, rights, form, style, the source work's data-station ID and one text per episode. A file with 第N集 headings splits at them; a file without takes the number in its name, else its place in the list. The tool checks the Workshop's limits first (300 episodes, 60,000 characters per episode, 3,000,000 in all) and names the failing episode. The member's entry with the same title receives the new version, and an unchanged text adds none. A licensed adaptation needs `origin`. When the Workshop does not confirm the upload, the tool fails with `WORKSHOP_FINALIZE_OUTCOME_UNKNOWN`. In the Desktop `short-drama-v2` preset the tool runs once `muse-manuscript-delivery` is in effect, and that skill has Muse ask the user with `ask_user_question` before finalizing.

`script_library` `read` writes one version, the newest by default, to `剧本库/<title>-v<version>/第NNN集.md` in the workspace, each file headed with its 第N集 line so `script_finalize` reads it back as the same episodes, and returns the paths. `link` records the Jingliu project ID and title of a picked script with `POST /script-library/{id}/production`, which moves it to 已投产. Picking a version is a lead's action in the Client's 剧本 tab, not a tool action.

-----

<a id="cloud-draft-editing"></a>
## Cloud draft editing

`workshop_script_editor` loads on demand under the Script Workshop capability. It searches drafts visible to the signed-in member, reads a draft's episode list, outline and story bible, and retrieves the saved text and revision of one episode at a time.

A proposal stages the full revised text of one episode and a short change summary against the saved revision. The proposal is visible for review in the script panel. Only the editor's action in that panel can apply the candidate to the saved draft. After a stale-revision response, read the updated episode before preparing another candidate.

<a id="further-exploration"></a>
## Further Exploration

- [Workbench connection](../workbench-connection/README.md) — how the tools sign in to the Workshop as the Muse user.
- [Tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-workshop) — the generated schema.

-----

<a id="model-experience"></a>
## Model Experience

### Finalized-script tools

#### What the model sees

Both definitions load on demand under the 剧本工坊 capability. `script_finalize` returns the script ID, title, version, whether the text was new, its stage and size; `script_library` returns the version, stage, folder and file paths for `read`, and the stage and project for `link`.

#### Token effect

Each loaded definition adds a fixed schema. A `read` result lists one path per episode, at most 300; the script text goes to workspace files, not into the result.

#### KV Cache effect

The definitions are fixed; results are appended after the reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No pick for the model** — Muse cannot pick a version; leads pick in the Client's 剧本 tab, and the Workshop refuses `link` for a script nobody picked.
- **`read` overwrites** — `read` replaces the files of the same version folder without checking for local edits.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The Workshop side is in [`services/workshop`](../../../services/workshop/README.md): the finalized-script library is `backend/app/script_library.py` and the draft editor routes are `backend/app/script_editor.py`.

</details>
