# Core I/O contract

Inputs:

- A project root path.
- Optional episode numbers.
- Optional asset type: `character`, `scene`, or `prop`.

Outputs:

- Normalized project paths.
- Episode file inventory.
- Asset inventory with name, aliases, episodes, type, visual prompt, image path, and vision-check status where available.
- Manifest/status summaries for resume decisions.

Rule: helpers should be usable from a copied skill bundle and should not require UI modules.

## Episode work scope and coverage

`episodes/manifest.json` has `version: 1` and a nonempty `episodes` object keyed by canonical decimal IDs from `"01"` through `"9999"`. Each row requires the cleaned source text's UTF-8 `sha256`. `expected_episode_count`, when known, is an integer from 1 to 9999 describing the whole story, never the number of locally assigned episodes.

An optional `work_scope` contains exactly `episode_ids`: a nonempty, numerically ascending, duplicate-free list of canonical string IDs. It is the local assignment, confirmed by the user or an authoritative task assignment before writing. It may be nonconsecutive. Every assigned ID needs a manifest row and matching nonempty `episodes/<id>.txt`; missing first, middle or last members fail. IDs cannot exceed the whole-story total. Other contributors' manifest rows may exist without local source files, but local episode files must have manifest entries. Do not derive authorization from the current minimum/maximum ID or from files already on disk.

For an explicitly assigned 140–219 range in a 300-episode story, pass this declaration to `ScriptProcessor.save`; it does not authorize any other episodes:

```python
work_scope = {"episode_ids": [str(number) for number in range(140, 220)]}
processor.save(project_dir, analysis, work_scope=work_scope, expected_episode_count=300)
```

Without `work_scope`, legacy projects require the full `01..expected_episode_count` inventory, or `01..highest_manifest_id` if the total is unknown. The latter cannot establish that the story's final episode is present; confirm and record the total when available. A malformed explicit scope never falls back to legacy inference.

`source_inventory` in `episode_coverage.py` supplies both coverage and pipeline source validation. `pipeline_state.py` projects explicit assignments only and reports `completion_scope=work_scope`, `scope_episodes`, and `story_episode_count`. A completed assignment is not a completed whole story. Existing manual state remains an annotation; it cannot authorize production or replace the current projection.

### Source mapping and acceptance

`shots_and_matches/ep<ID>-source-map.json` keeps `version: 1`, the canonical `episode`, `source_sha256`, project-relative `shot_script`, and `entries`. Each nonempty source line has `source_line`, exact `source_text`, `kind`, and ascending unique `shots`. Speech uses `dialogue`, `os`, or `vo` plus exact `speaker` and `speech_text`; other kinds are `action`, `scene`, `state`, `transition`, or `heading`. Unrecognized speech/action remains pending; written-object recognition does not certify performance or video quality.

Run `episode_coverage.py <project> audit`, then `accept <episode...>` only after inspecting that episode's mapping. In explicit scope, ordered unique subsets can be accepted independently, and `gate <episode...>` requires current acceptance only for the requested subset. All assigned source files still need valid identity and hashes. Legacy mode retains contiguous requests and prefix acceptance. Scope membership is an orchestration precondition, not a remote permission system or proof of budget authorization.

New `ep<ID>-coverage-acceptance.json` records use `version: 2`. `episode_manifest_sha256` hashes canonical JSON of the manifest version, episode ID, that episode's entire entry, and shared `filter_options`. Records also bind the exact source-file bytes, normalized source text, shot-file bytes, and mapping-file bytes. Changes to these dependencies invalidate acceptance. JSON formatting, another episode's entry, local `source_path`/`source_mtime`, and scope membership changes do not invalidate unaffected v2 records; current scope and source validation still run before every gate. A v1 record retains its original whole-manifest hash check; it is never silently reinterpreted as v2.

### Existing project migration

1. Confirm the assignment and whole-story total. Back up `episodes/manifest.json`; record the exact authorized `work_scope.episode_ids` and preserve the true total. Do not shrink the total to the local count or add work outside the assignment.
2. Run `audit`. Restore any missing assigned source from the approved script and reconcile hashes, mappings, speakers and OS/VO. Do not mark pending lines reviewed in bulk.
3. Run `accept <episode...>` for the episodes that passed the actual review. Stale legacy records are replaced only by a fresh successful audit; untouched valid v1 records keep their old hash requirement.
4. Run `gate <episode...>` immediately before an authorized submission and `pipeline_state.py <project> sync` to refresh the scoped projection. A nonzero gate exit stops that submission. No migration step submits paid work.

Use separate local workspaces for independent collaborators, then merge episode rows and artifacts. The scripts do not provide remote locking, atomic multi-file transactions, user identity enforcement, or concurrent writes to one project directory.
