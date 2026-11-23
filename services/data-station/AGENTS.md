# Muse Data Web

The data station is a separately deployed service in the Muse repository with its own `package.json` and lockfile; [README.md](README.md) says how to build, test and deploy it. Do not modify or restart the existing Muse desktop, account gateway, media gateway, or production Web. Do not read or write `~/.muse`, production credentials, or production databases.

Keep server state under this project's ignored `.data/` directory. Bind previews to loopback only. Production authentication and deployment require a separately reviewed integration; local preview identities must never be exposed publicly.

The UI and API distinguish `demo` and `live` records. Preserve source identifiers as strings, metric units, observation times, and collection coverage. Missing metrics are null. Compare observations only within the same source, board, and data origin. Collection failures must preserve the last successful data.

Run focused tests and the application build before handoff. Test browser workflows against a separate test database. Keep all downloaded data, browser profiles, screenshots, logs, and dependency folders ignored. Never push automatically.
