# Script split I/O contract

Input:

- Source script path.
- Project root.
- Optional explicitly authorized `work_scope={"episode_ids": [...]}` and whole-story `expected_episode_count`; see the [shared scope schema](../../tweet-drama-core/references/io-contract.md#episode-work-scope-and-coverage).

Output:

- `episodes/<episode>.txt` or the current project naming convention.
- `episodes/manifest.json` with source hashes, the declared scope and whole-story total when supplied.
- Split report: episode count, source length, retained length, warnings.

Acceptance:

- No meaningful script text is silently dropped.
- Existing episode files are overwritten only when the user requested regeneration.

Scoped saves require exactly the declared episode IDs and preserve other contributors’ files and manifest rows. Omitted or `None` scope/count parameters preserve existing declarations. Invalid existing manifests or mismatched scope fail before writes. Legacy saves without scope retain whole-split replacement and cleanup; do not use that path to merge collaborator work. Concurrent writers to the same project directory are not coordinated: use separate workspaces and merge verified episode artifacts.
