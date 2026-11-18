# Muse independent production studio

English | [中文](README.zh.md)

Muse’s **Production studio** manages independent projects, scripts, character/scene/prop assets, prompt revisions and videos. The default configuration has no generation backend selected. Existing project and media storage remains usable without a supplier account.

Project edits retain conflict checks and version history. A historical result displays its own saved inputs; absent original prompts or images remain unknown instead of borrowing current card settings. The original database, media and operation receipts must remain together when copying a deployment.

For planning, use the script-reading tool from the Muse conversation. This desktop profile does not enable workbench buttons that dispatch an action into a conversation. Planning reads stored project data and does not submit supplier work.

The server defaults to `muse_generation.enabled: false`. `MUSE_STANDALONE_NO_AI=1` also disables generation even when stored configuration enables it. Disabled mode rejects AI routes and direct text/image/video client calls before supplier access, skips startup task recovery and Agent initialization, and reports `generationBackend: "unconfigured"` and `backgroundGeneration: false` in `/health`. It does not remove saved credentials, projects, assets, tasks or history. Native storage and import routes remain available.

## Retained service

This directory maintains LocalMiniDrama storage and standalone deployment. SQLite and media remain in their persistent volume.

Back up the entire `/var/lib/localminidrama` volume and the Host’s `localminidrama/operations` receipt directory together. Rebuilding a container must reuse its original volume. Native and provider project IDs are different identities; viewing history does not migrate or overwrite either project.

For an existing isolated Windows service, [start-studio.ps1](windows/start-studio.ps1) reads `deployment.json` and starts its saved backend. Its logs remain in `logs/studio-launcher.log`. Use a separate deployment directory and loopback port when preserving another running installation.

## Build and verify

The Dockerfile applies `patch-upstream.mjs` to the pinned upstream revision and builds the standalone frontend. The configuration leaves text, image and video provider defaults empty. See the [standalone deployment guide](standalone/README.md) for running and verifying the workbench against temporary project data without paid requests.

`patch-upstream.mjs` validates pinned upstream replacements before writing. The [Compose configuration](compose.yaml) publishes only host loopback and preserves `localminidrama-data`. It also disables generation regardless of saved settings. Keep a remote deployment on loopback and reach it through approved SSH forwarding; do not expose the management API directly.

See [editing and history](edit-migration.md) and [revisions](revisions.md) for the stored project behavior. [Budget](budget.md) and [audio](audio.md) describe optional protocols; they do not provide a configured generation backend.
