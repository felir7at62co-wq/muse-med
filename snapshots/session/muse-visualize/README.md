# Native visualization cards

English | [中文](README.zh.md)

This keyless scene mounts the actual default `short-drama` preset and Desktop tool-discovery configuration. The first model request exposes `visualize` and `skill`; the scene never calls tool search. A native Skill load precedes real create and update calls. Their persisted result metadata and the saved private-home fragment are checked independently against the complete workspace oracle.

The replay uses the dedicated `snapshot-visualize` model provider without a real-API fallback. Set `MUSE_VISUALIZE_PACKAGE` to the reviewed unpacked package to run the same scene through its built `lib/index.js`; the default uses retained source. Runtime files and assets are staged under the private test home so no personal style files or accounts are read.

Request budgets are reconstructed from the expected messages and sidecars at the actual workspace. Private card paths use the tool's home-relative display and the shipped Headless `session-<UUID>` length; the replay verifies that id format before model requests. Path comparison recognizes only the known workspace's absolute and home-relative spellings.

`apps/web/tests/muse-visualize.e2e.ts` opens the packaged Client with the same native Session data, checks slider interaction and reload, isolates two sessions, and verifies that card prompts only draft text while retaining user drafts and attachments. Browser screenshots and acceptance receipts stay under `.artifacts/visualize-browser-ui/`.
