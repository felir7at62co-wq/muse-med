# Native visualization cards

English | [中文](README.zh.md)

This keyless scene mounts the actual default `short-drama` preset and Desktop tool-discovery configuration. The first model request exposes `visualize` and `skill`; the scene never calls tool search. A native Skill load precedes real create and update calls. Their persisted result metadata and the saved private-home fragment are checked independently against the complete workspace oracle.

The replay uses the dedicated `snapshot-visualize` model provider without a real-API fallback. Source replay uses retained source; `DSH_EXAMPLE_MODE=lib` uses the retained reviewed `lib/index.js`. Set `MUSE_VISUALIZE_PACKAGE` to the reviewed unpacked package to use its built entry instead. Runtime files, assets, and explicit Host peer links are staged under the private test home so no personal style files or accounts are read.

`apps/web/tests/muse-visualize.e2e.ts` opens the packaged Client with the same native Session data, checks slider interaction and reload, isolates two sessions, and verifies that card prompts only draft text while retaining user drafts and attachments. Browser screenshots and acceptance receipts stay under `.artifacts/visualize-browser-ui/`.

Exact request-budget expectations expand the committed prompt, schemas and tool text using the allocated workspace and Session id. Source assets use `.dsh/plugins/dsh-visualize`; built assets use the audited installation under `.dsh/profiles/headless/node_modules/@nagi-ovo/dsh-visualize`. Expected inputs bind only the visualization description's three asset references and the declared Skill result's one Base directory line to that layout; other text and tool arguments retain their bytes. Runtime-context paths retain the resolved directory; visualization store paths retain the configured home spelling, including Windows aliases. The fixture restores its temporary home variables on disposal and leaves canonical recordings unchanged.
