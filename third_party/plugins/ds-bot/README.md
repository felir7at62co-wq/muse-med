# Muse Bot

English | [中文](README.zh.md)

Muse Bot adds persistent Bot conversations, a team roster, group chats, shared work and per-Bot memory to the existing Muse desktop application. It is the Muse adaptation of [DS-Bot](https://github.com/Fei2411/DS-Bot), distributed as the native `ds-bot` Cordis plugin. The source revision and upstream version are fixed by [the source inventory](../sources.json); the product keeps the module name and wire routes for compatibility while its interface uses Muse Bot branding.

## Desktop use

Open Muse Bot from the Muse sidebar. Create a Bot, select its model and reasoning level, and send it a task. A Bot uses the existing Muse model catalog, account, workspace and tools. Its conversation remains an ordinary Harness Session, and the original Muse task interface remains available. Group chats let Bots coordinate messages without requiring a separate planning, review or approval workflow.

Settings → Bots → Use an existing conversation registers a listed root Session in place. Its history, working directory, workspace, current model and reasoning level, native questions, live Agent, goals and jobs stay with that Session. Registration sends no greeting or model request. It adds an ordinary member; the user can assign the Main Bot role in the same settings page. A Main Bot coordinates the work and can execute simple tasks directly, delegating where useful.

The team workspace uses Muse's bundled short-drama tools. Its settings omit generic plugin and capability creation entries; the account footer remains owned by Muse. Bots can still discover and load their existing skills and use attached capabilities. Host tools, permissions and saved capability definitions are unchanged. The About page identifies Muse Bot and keeps upstream attribution inside a collapsed open-source license disclosure.

Open Settings → Feedback to fill in Muse's existing Session feedback form. The user chooses the content and submits it; opening the form does not send feedback or diagnostics. The same page can preview, copy and save local diagnostics.

Bot state and memory default to `muse-bot/` inside the active Muse home. Conversation history stays in the existing Session store. The adaptation does not automatically import the separate experimental Muse Bot application's state or change existing Muse task histories.

Muse's existing `hindsight_memory` stores sourced, confirmed user preferences, aesthetic feedback and project decisions on demand. Bot memory covers identity, assignments, coordination agreements and reusable working methods. Per-turn Bot memory review defaults off; existing notes remain readable and editable, and are not migrated or deleted. These stores are not synchronized: explicit edits can still create overlapping notes, and the latest user instruction and current project files take priority.

The Host exposes `museTeam.registerSessionAsBot(sessionId, { name?, role?, main? })`, `resolveCurrentSession(botId)` and `switchCurrentSession(botId, sessionId)` for the native IM adapter. The Bot ID remains stable when the user explicitly changes its current Session; the earlier Session remains in its history. Goals and jobs remain attached to their original Session. Registration and switching validate root Session ownership and roll back roster changes if saving fails.

Native Feishu routes each app registration and chat ID to one Bot; threads retain their native reply location within their group. Existing group and private Sessions are registered without restarting them. The adapter passes the group or peer name as `nameHint`, using existing chat/message metadata without requesting contact permissions. The interface displays the chat title; a distinct addressable Bot name remains visible when titles repeat or need sanitizing. Missing metadata leaves the original Session title in use, and a user rename takes priority over later hints. Authentication, workspace isolation, message deduplication, cards, files and sending receipts remain owned by the native IM runtime. Explicit `/new` and `/use` select a current Session for the same Bot rather than creating another team identity.

## Native configuration

The bundled composition mounts one `muse-bot` row:

```yaml
- insert:
    - id: muse-bot
      name: ds-bot
      config:
        agentPreset: short-drama
        contextManagement: host
        goals: host
        memoryReview: false
        github: false
        updateCheck: false
```

`agentPreset` chooses the registered Muse preset for new Bot Sessions. `contextManagement: host` leaves context compaction with the current Host. `goals: host` retains the Host goal tools and continuation behavior. `updateCheck: false` disables independent plugin and Harness update offers; Muse application updates supply the reviewed plugin. `github: false` disables the optional built-in GitHub MCP connector. The bundle does not replace the profile's web-search provider, model routes, account settings or permission policy.

`memoryReview: true` explicitly enables background review of Bot coordination notes; the default does not issue that extra model request. Adopted Sessions keep their native model selection through catalog refreshes. An explicit model or effort change from the interface or `update_bot` makes that selection Bot-managed.

The optional `home` configuration selects a different Bot-state directory. Bot model and effort settings remain selectable in the interface; creating or messaging a Bot may issue a normal model request using the configured provider. Authentication and provider availability are governed by Muse's existing services.

## Source, packaging and checks

The [controlled builder](../build.mjs) rebuilds the browser module from `src/client`, qualifies peers against the reviewed Host and includes `LICENSE`, `NOTICE` and `SOURCE.json` in the tarball. Its Muse overlay omits the upstream automatic search module and its retired `dsh-web` peer. The package does not include the upstream development application or install another agent engine.

Run the owning build checks from the repository root:

```sh
pnpm --dir third_party/plugins/toolchain run test:bot
```

The package checks validate the native composition, browser entry, source metadata and retained attribution. The recorded-session case exercises the actual roster tool with isolated state. They do not establish paid-provider availability, creative quality, or authenticated account acceptance; desktop verification covers Host activation and the Muse Bot interface separately.

## License and attribution

The retained source is licensed under Apache-2.0. See [LICENSE](LICENSE) and the unchanged upstream [NOTICE](NOTICE) for copyrights and third-party attribution. Muse branding, native preset integration, Host-managed context and goals, and the controlled Desktop packaging are local modifications. Muse does not claim upstream authorship or endorsement.
