# Muse Bot

English | [中文](README.zh.md)

Muse Bot adds persistent Bot conversations, a team roster, group chats, shared work and per-Bot memory to the existing Muse desktop application. It is the Muse adaptation of [DS-Bot](https://github.com/Fei2411/DS-Bot), distributed as the native `ds-bot` Cordis plugin. The source revision and upstream version are fixed by [the source inventory](../sources.json); the product keeps the module name and wire routes for compatibility while its interface uses Muse Bot branding.

## Desktop use

Open Muse Bot from the Muse sidebar. Create a Bot, select its model and reasoning level, and send it a task. A Bot uses the existing Muse model catalog, account, workspace and tools. New model choices respect provider and model visibility; existing Bot selections are retained. Its conversation remains an ordinary Harness Session, and the original Muse task interface remains available. Group chats let Bots coordinate messages without requiring a separate planning, review or approval workflow.

When the Muse Bot interface opens or the roster is queried, visible independent Muse Sessions become ordinary Bots in place, including ordinary forks. Subagents, team-room Sessions, earlier Bot parts, standalone DSH Agent Sessions and archived Sessions are excluded. Their history, working directory, workspace, model, reasoning level and preset remain with the original Session, as do native questions, live Agents, goals and jobs. Automatic registration reads list metadata without restoring inactive Agents, sending greetings or requesting a model.

When a Bot starts a new conversation part in a registered workspace, that part also appears in the classic workspace's Session list. Switching to the classic view attaches the currently displayed Bot part if its unchanged working directory matches a registered workspace and it has no workspace yet. A folder without a registered workspace remains an ungrouped working directory; other conversation parts are not moved.

Settings → Bots → Use an existing conversation remains available when automatic registration is disabled. It registers the selected Session in place and opens its original conversation; the Session title supplies its default Bot name. The user can assign the Main Bot role in the same settings page. A Main Bot coordinates the work and can execute simple tasks directly, delegating where useful. Main Bots appear in order at the top of the sidebar, with at most three per row; ordinary pinned Bots remain in the list. Opening a Bot or conversation preserves the sidebar's current expanded or collapsed state at every window width. On desktop, Bot mode keeps the same 56px avatar rail as Web when collapsed; leaving Bot mode restores the native collapse behavior.

New teams use the DS Bot Chief of Staff role in the `bot-coordinator` preset, with Muse as a separate `short-drama` specialist. Existing Bot identities and Sessions keep their current presets and history. The shared team workspace retains Muse's bundled short-drama tools. Its settings omit generic plugin and capability creation entries; the account footer remains owned by Muse. Bots can still discover and load their existing skills and use attached capabilities. Host tools, permissions and saved capability definitions are unchanged. The About page shows Muse Bot product information without a repository or license section.

Open Settings → Feedback to fill in Muse's existing Session feedback form. The user chooses the content and submits it; opening the form does not send feedback or diagnostics. The same page can preview, copy and save local diagnostics.

Bot state and memory default to `muse-bot/` inside the active Muse home. Conversation history stays in the existing Session store. The adaptation does not automatically import the separate experimental Muse Bot application's state or change existing Muse task histories.

Muse's existing `hindsight_memory` stores sourced, confirmed user preferences, aesthetic feedback and project decisions on demand. Bot memory covers identity, assignments, coordination agreements and reusable working methods. Per-turn Bot memory review defaults off; existing notes remain readable and editable, and are not migrated or deleted. These stores are not synchronized: explicit edits can still create overlapping notes, and the latest user instruction and current project files take priority.

The Host exposes `museTeam.registerSessionAsBot(sessionId, { name?, role?, main? })`, `resolveCurrentSession(botId)` and `switchCurrentSession(botId, sessionId)` for the native IM adapter. The Bot ID remains stable when the user explicitly changes its current Session; the earlier Session remains in its history. Goals and jobs remain attached to their original Session. Registration and switching validate independent Session ownership and roll back roster changes if saving fails. An explicit switch may absorb an untouched automatic roster entry; customized or collaborating Bots retain their identities. Ordinary adopted user and goal turns keep native restart behavior; admitted Bot collaboration messages retain their original exchange recovery.

Native Feishu routes each app registration and chat ID to one Bot; threads retain their native reply location within their group. Existing group and private Sessions are registered without restarting them. The adapter passes the group or peer name as `nameHint`, using existing chat/message metadata without requesting contact permissions. The interface displays the chat title; a distinct addressable Bot name remains visible when titles repeat or need sanitizing. Missing metadata leaves the original Session title in use, and a user rename takes priority over later hints. Authentication, workspace isolation, message deduplication, cards, files and sending receipts remain owned by the native IM runtime. A Bot with a verified chat binding shows a circular Feishu mark above its activity indicator or Main Bot star while the Feishu connection and Host are available; the mark disappears on disconnect. Explicit `/new` and `/use` select a current Session for the same Bot rather than creating another team identity.

## Native configuration

The bundled composition mounts one `muse-bot` row:

```yaml
- insert:
    - id: muse-bot
      name: ds-bot
      config:
        agentPreset: short-drama
        mainAgentPreset: bot-coordinator
        ensureMuseSpecialist: true
        contextManagement: host
        goals: host
        memoryReview: false
        autoSessionBots: true
        sessionBotSyncIntervalMs: 30000
        github: false
        updateCheck: false
```

`agentPreset` chooses the registered Muse preset for new specialist Bot Sessions; `mainAgentPreset` chooses it for newly created Main Bots. `ensureMuseSpecialist` creates one Muse specialist when none is already configured, preserving existing specialist identities. All required presets must be available; creation never falls back to another preset. `contextManagement: host` leaves context compaction with the current Host. `goals: host` retains the Host goal tools and continuation behavior. `updateCheck: false` disables independent plugin and Harness update offers; Muse application updates supply the reviewed plugin. `github: false` disables the optional built-in GitHub MCP connector. The bundle does not replace the profile's web-search provider, model routes, account settings or permission policy.

`memoryReview: true` explicitly enables background review of Bot coordination notes; the default does not issue that extra model request. Adopted Sessions keep their native model selection through catalog refreshes. An explicit model or effort change from the interface or `update_bot` makes that selection Bot-managed.

`autoSessionBots: false` disables automatic Session registration while retaining the manual entry. `sessionBotSyncIntervalMs` sets the roster's metadata refresh interval in milliseconds; native Session changes invalidate the cached result. Newly created Bot Sessions continue to use `short-drama`; registration preserves an existing Session's preset.

`create_bot` accepts `preset` and `resident_tools`; `update_bot` can replace both. A preset change applies to future new Sessions, while the current conversation keeps its existing preset. Resident tools are exact names saved on the Bot record. The shared Harness `tool_search` finds tools by capability; `tool_context` loads, pins, unpins or releases them. Each Bot's own chat, group chats and future conversation parts use its resident list. The capability catalog is shared, authorization still applies, and loading a name does not grant permission. Failed residency saves reject the operation and restore the previous Bot setting. Tool results remain in Session history after a release.

The Desktop composition keeps the registered Bot team tools available from the first model request, including `ask_user`, `show_view` and secure credential cards. Ordinary DSH Agent sessions exclude Bot management tools, and tool visibility does not grant Main Bot rights. User-selected additional tools retain their existing pin and release behavior. The card registration uses a selective DS Bot 0.2.4 update: a Bot-scoped `show_view` takes priority over another plugin’s global renderer and is removed on Agent or plugin disposal. The plugin retains its 0.2.2 base, Muse renderer, model routes and Muse web search.

The optional `home` configuration selects a different Bot-state directory. Bot model and effort settings remain selectable in the interface; creating or messaging a Bot may issue a normal model request using the configured provider. Authentication and provider availability are governed by Muse's existing services.

The conversation activity row distinguishes waiting for a reply from receiving visible text and labels its clock as total turn time. Ordinary tool calls retain a collapsed record of tool names and returned, failed or pending status without exposing arguments or raw results.

Returned reasoning summaries are visible when the user has not set the thinking-display preference. An explicit off setting remains off. This preference changes display only; it does not request hidden reasoning or generate a summary when the model returns none.

## Source, packaging and checks

The [controlled builder](../build.mjs) rebuilds the browser module from `src/client`, qualifies peers against the reviewed Host and includes `LICENSE`, `NOTICE` and `SOURCE.json` in the tarball. Its Muse overlay omits the upstream automatic search module and its retired `dsh-web` peer. The package does not include the upstream development application or install another agent engine.

Run the owning build checks from the repository root:

```sh
pnpm --dir third_party/plugins/toolchain run test:bot
```

The repository development dependencies pin `esbuild` to the version declared by this plugin. Run the retained keyless tests against this checkout's built Harness peers from the repository root:

```sh
DSH_HARNESS="$PWD" node --import ./third_party/plugins/ds-bot/test/harness-resolve.mjs --test "third_party/plugins/ds-bot/test/*.test.js"
```

Retained upstream team fixtures explicitly select their original coordinator, preset, Bot-managed context and memory review. Question and view fixtures use an existing team without automatically creating a specialist. `muse-host.test.js` separately checks the default coordinator and Muse specialist setup. The test resolver uses the actual Web and base profile bundle dependencies; its regression checks compare the resolved modules with those profile consumers.

The package checks validate the native composition, browser entry, source metadata and retained attribution. The recorded-session case exercises the actual roster tool with isolated state. They do not establish paid-provider availability, creative quality, or authenticated account acceptance; desktop verification covers Host activation and the Muse Bot interface separately.

Source lint covers `src`, entry modules, scripts and tests. The generated `client.js` is excluded from lint; `node scripts/build-client.mjs --check` verifies it against `src/client` with the declared esbuild version.

## License and attribution

The retained source is licensed under Apache-2.0. See [LICENSE](LICENSE) and the unchanged upstream [NOTICE](NOTICE) for copyrights and third-party attribution. Muse branding, native preset integration, Host-managed context and goals, and the controlled Desktop packaging are local modifications. Muse does not claim upstream authorship or endorsement.
