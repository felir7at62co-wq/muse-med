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

Editing input projection requires both prepared `editing/<ID>-timeline.json` and `editing/<ID>-sources.json`: nonempty matching shot lists, continuous integer microsecond clocks starting at zero and existing source files. Existing pairs using `editing/ep<ID>-...` remain readable; a partially written current pair does not fall back to an older pair. Notes, directories and other filenames are not completion evidence. Projection compares complete canonical episode IDs, so `14`, `140`, and `1000` remain distinct.

An optional `body_end` follows the [draft input rules](../../tweet-drama-draft-build/references/io-contract.md): it ends at the last clip, except for an explicitly included two-second freeze inside the final clip. `completion_basis=editing_inputs` and `editable_draft_verified=false` distinguish input preparation from the external editor's actual editable draft and its media QA.

### Source mapping and acceptance

`shots_and_matches/ep<ID>-source-map.json` keeps `version: 1`, the canonical `episode`, `source_sha256`, project-relative `shot_script`, and `entries`. Each nonempty source line has `source_line`, exact `source_text`, `kind`, and ascending unique `shots`. Speech uses `dialogue`, `os`, or `vo` plus exact `speaker` and `speech_text`; other kinds are `action`, `scene`, `state`, `transition`, or `heading`. Unrecognized speech/action remains pending; written-object recognition does not certify performance or video quality.

Run `episode_coverage.py <project> source-lines <ID>` before authoring a map. This read-only command returns `source_sha256` and every nonempty source line in `entries`, with exact text, one-based line number, contextual `kind`, and any speaker and speech text. Its classifier is also used by preflight and coverage validation. Review the rows and supply actual shot membership; it neither supplies shot numbers nor writes a map or acceptance. Unknown rows remain present with `kind: null` and a `reason`; generic `offscreen` rows also require OS/VO clarification. Such rows populate `pending_lines` and produce a nonzero exit, as do unreadable or empty sources. A successful exit means classification completed without pending rows, not that actions or a map passed review. Preserve pending rows for review rather than dropping them. Internal single-line helpers cannot substitute for this contextual result. Existing complete maps should be audited before replacement; any map edit requires renewed acceptance before a gate can pass.

Before episode authoring, `episode_coverage.py <project> source-scan` scans the entire declared assignment using that same classifier, checks manifest/source integrity and aggregates every unresolved row with its episode, line, exact text and reason. It writes no source, mapping, acceptance or media files. Missing or changed source yields `failed`, unresolved notation yields `pending`, and fully classified intact input yields `passed`; classification alone does not authorize generation or establish video quality. The command accepts no episode list and never changes the assigned scope.

Run `episode_coverage.py <project> audit`, then `accept <episode...>` only after inspecting that episode's mapping. In explicit scope, ordered unique subsets can be accepted independently, and `gate <episode...>` requires current acceptance only for the requested subset. All assigned source files still need valid identity and hashes. Legacy mode retains contiguous requests and prefix acceptance. Scope membership is an orchestration precondition, not a remote permission system or proof of budget authorization.

New `ep<ID>-coverage-acceptance.json` records use `version: 2`. `episode_manifest_sha256` hashes canonical JSON of the manifest version, episode ID, that episode's entire entry, and shared `filter_options`. Records also bind the exact source-file bytes, normalized source text, shot-file bytes, and mapping-file bytes. Changes to these dependencies invalidate acceptance. JSON formatting, another episode's entry, local `source_path`/`source_mtime`, and scope membership changes do not invalidate unaffected v2 records; current scope and source validation still run before every gate. A v1 record retains its original whole-manifest hash check; it is never silently reinterpreted as v2.

Character declarations may use `人物`, `出场人物`, `登场人物`, `角色`, `角色表`, `CHARACTERS` or `CAST` followed by a colon. These rows map as `scene`. When no roster exists, plain, unannotated dialogue prefixes can establish identities; an annotated line cannot establish its own identity. Performance comparison preserves complete `source_text` while comparing the established speaker and spoken text. Undeclared annotated identities, identity/time-period changes, combined voice-mode notes, quoted content and unresolved metadata remain pending. Explicit OS/VO suffixes retain their meaning; generic `画外音` does not establish an OS/VO subtype. Shot scripts accept the existing `shots/第13集镜头脚本.md` and `shots/EP13-9x16.md` naming forms with matching numeric episode IDs; renaming or duplicating existing scripts is unnecessary.

The same structural performance normalization applies to source and shot speaker prefixes and explicit shot speaker fields. Balanced parentheses and square-bracket groups, including nested performance groups, preserve the established identity; they do not require an action-word dictionary, a genre, a character name or a project-specific rule. This notation treats unquoted, nonempty descriptive notes as performance unless they signal identity, period, voice or unresolved metadata such as `待定`, `未知备注` or `TBD`. The notation does not certify semantic understanding or action depiction. Speaker fields must still agree, and spoken words and voice mode are not discarded. Quoted payloads remain pending because they may contain additional speech. Diagnostics distinguish unresolved metadata on a known identity from identity, period, voice and quotation ambiguity. Repair unsupported syntax without rewriting the original to fit the parser, substituting manual notes for `accept/gate` or offering a bypass; keep paid submission blocked while required checks remain unresolved.

Explicit voice markers may precede or follow a separate recognized performance annotation: `甲 VO（声音发颤）`, `甲（难以置信）VO` and `甲（VO）（眼眶通红）` retain the same speaker and VO. Conflicting or repeated markers, mixed notes such as `（OS，声音发颤）`, and identity or quotation ambiguity remain unresolved. Source and shot prefixes and speaker fields use the same parser. In shots, the compiler's `发声类型：vo` can carry an explicit OS label or prefix; without a semantic label or prefix it denotes VO. Generic `（画外音）` still does not establish a subtype. Contradictory semantic labels or a voice-marked speaker declared as dialogue fail validation.

Marked directions can contain quoted object sounds without becoming dialogue. Recognition requires a supported object-sound token and paired Chinese, ASCII or corner quotes. Explicit sound suffixes include `“铛”的一声脆响`, `“吱呀”一声` and `“沙沙”的枝叶断裂声`. Exclamatory impact quotations such as `“砰！砰！”` or `“啪！”` additionally require a physical impact cue in that direction. Human voice cues, remaining speech hints, other quotes or colon clauses keep the direction pending; a recognized sound cannot hide another clause. Unknown sounds, human vocalizations, unmatched quotes and quotes inside speaker annotations remain unresolved. The silent idioms `二话不说` and `不由分说` do not themselves introduce spoken text. A marked direction with unresolved speech is not interpreted as a speaker prefix, and an explicit action-line speech prefix must resolve to a declared identity when a roster exists. This comparison-only recognition preserves the complete source line and does not verify sound or action depiction.

A marked direction ending in an addressed question or a terminal `说/说道/喊/喊道` cue can map as `action` when its final sentence starts with a declared actor and the next nonempty line is that actor's separate dialogue. An earlier descriptive sentence is allowed without earlier speech hints. Quoted or colon-delimited content, parenthetical or identity ambiguity, intervening action or scene boundaries and OS/VO prevent this recognition. A different following speaker reports both identities and stays pending; it cannot establish missing words. Exact standalone `【下集钩子】` and `【全剧终】` markers map as headings and retain their mapping rows; arbitrary bracketed content does not. These rules do not certify action depiction or permit pending rows to be accepted in bulk.

### Existing project migration

1. Confirm the assignment and whole-story total. Back up `episodes/manifest.json`; record the exact authorized `work_scope.episode_ids` and preserve the true total. Do not shrink the total to the local count or add work outside the assignment.
2. Run `audit`. Restore any missing assigned source from the approved script and reconcile hashes, mappings, speakers and OS/VO. Do not mark pending lines reviewed in bulk.
3. Run `accept <episode...>` for the episodes that passed the actual review. Stale legacy records are replaced only by a fresh successful audit; untouched valid v1 records keep their old hash requirement.
4. Run `gate <episode...>` immediately before an authorized submission and `pipeline_state.py <project> sync` to refresh the scoped projection. A nonzero gate exit stops that submission. No migration step submits paid work.

For an authorized single-episode continuation, run `accept 13 --episode-only`, then `gate 13 --episode-only` after reviewing its mapping. This option accepts exactly one explicit in-scope episode and skips only the prerequisite for earlier coverage records. Current source integrity, the requested episode's complete mapping, exact speech, OS/VO and acceptance hashes still apply. Neither command changes `work_scope`, the whole-story total, prior records or media. The option is rejected for `audit`, `preflight`, omitted episodes or multiple episodes; default whole-project behavior remains unchanged. Actual assignment changes still require a confirmed scope, never a declaration made merely to hide a failed episode.

Missing historical acceptance records mean missing coverage evidence, not a verdict that every old video failed. A blocked gate pauses the requested paid submission; it does not prohibit reading, free previews or diagnosis, and it does not require regenerating completed videos. Valid pending or failed evidence is never relabeled as passed to migrate a project.

For `accept`, `accept_status=passed` and `accepted_episodes` describe the requested acceptance; the outer `status` still describes the project's full audit and may remain pending for other episodes. Use the subsequent requested `gate` result for that submission, not the outer audit status as a whole-story completion claim.

Use separate local workspaces for independent collaborators, then merge episode rows and artifacts. The scripts do not provide remote locking, atomic multi-file transactions, user identity enforcement, or concurrent writes to one project directory.
