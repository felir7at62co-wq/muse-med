# Muse Data Web

This is an isolated development project. Do not modify or restart the existing Muse desktop, account gateway, media gateway, or production Web. Do not read or write `~/.muse`, production credentials, or production databases.

Use the `codex/` branch. Keep server state under this project's ignored `.data/` directory. Bind previews to loopback only. Production authentication and deployment require a separately reviewed integration; local preview identities must never be exposed publicly.

The UI and API distinguish `demo` and `live` records. Preserve source identifiers as strings, metric units, observation times, and collection coverage. Missing metrics are null. Compare observations only within the same source, board, and data origin. Collection failures must preserve the last successful data.

Run focused tests and the application build before handoff. Test browser workflows against a separate test database. Keep all downloaded data, browser profiles, screenshots, logs, and dependency folders ignored. Never push automatically.
