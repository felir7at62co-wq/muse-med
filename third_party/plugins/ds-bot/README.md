# Muse Bot

English | [中文](README.zh.md)

Muse Bot adds persistent Bot conversations, a team roster, group chats, shared work and per-Bot memory to the existing Muse desktop application. It is the Muse adaptation of [DS-Bot](https://github.com/Fei2411/DS-Bot), distributed as the native `ds-bot` Cordis plugin. The source revision and upstream version are fixed by [the source inventory](../sources.json); the product keeps the module name and wire routes for compatibility while its interface uses Muse Bot branding.

## Desktop use

Use the Conversation / Bot switch beside the MUSE account at the bottom of the sidebar. Conversation mode opens ordinary Sessions; Bot mode opens the persistent team. Create a Bot, select its model and reasoning level, and send it a task. A Bot uses the existing Muse model catalog, account, workspace and tools. New model choices respect provider and model visibility; existing Bot selections are retained. Its conversation remains an ordinary Harness Session, and the original Muse task interface remains available. Group chats let Bots coordinate messages without requiring a separate planning, review or approval workflow.

Ordinary Sessions and forks are not automatically registered as Bots. Existing saved Bots, including entries registered by earlier Muse versions, keep their identities, current and historical Sessions, model settings and memory. Explicitly adopt a Session from Bot settings when it should become a persistent team member. Switching modes only changes the displayed interface; it does not stop work or create another Bot.

Automatically listed Session Bots use the same model and reasoning level as their native conversation. Choosing either interface updates that Session without changing the profile default. Older saved Bot model preferences remain stored but do not override the native selection. Side answers and new parts use the current selection; memory review uses that model at its existing lowest supported reasoning level. Independently created Bots keep their own model settings.

Bot-owned parts remain accessible in the classic workspace history for compatibility. Switching to Conversation mode selects its own last ordinary Session instead of moving the displayed Bot part into that mode. Neither mode moves or deletes historical Sessions.

Settings → Bots → Use an existing conversation remains available when automatic registration is disabled. It registers the selected Session in place and opens its original conversation; the Session title supplies its default Bot name. The user can assign the Main Bot role in the same settings page. A Main Bot coordinates the work and can execute simple tasks directly, delegating where useful. Main Bots appear in order at the top of the sidebar, with at most three per row; ordinary pinned Bots remain in the list. Opening a Bot or conversation collapses an expanded sidebar on phone-width windows; wider windows preserve the current sidebar state. On desktop, both modes keep a 56px collapsed rail so the account and mode switch remain reachable. Unloading the plugin releases its rail retention.

New teams use the DS Bot Chief of Staff role in the `bot-coordinator` preset, with Muse as a separate `short-drama` specialist. Existing Bot identities and Sessions keep their current presets and history. The shared team workspace retains Muse's bundled short-drama tools. Its settings include shared MCP servers, skills and capability packs, which can be attached to individual Bots. The account footer remains owned by Muse. Bots can still discover and load their existing skills and use attached capabilities. Host tools, permissions and saved capability definitions are unchanged. The About page shows Muse Bot product information without a repository or license section.

Open Settings → Feedback to fill in Muse's existing Session feedback form. The user chooses the content and submits it; opening the form does not send feedback or diagnostics. The same page can preview, copy and save local diagnostics.

Bot state and memory default to `muse-bot/` inside the active Muse home. Conversation history stays in the existing Session store. The adaptation does not automatically import the separate experimental Muse Bot application's state or change existing Muse task histories.

Muse Bot includes DS Bot's local memory without a separate service. `remember`, `recall` and `forget` retain preferences, decisions, corrections, useful facts and working methods across conversations. Each Bot has its own Markdown notes; team and group notes retain their existing access rules. Core notes enter each new conversation's context, while detailed topics are recalled on demand. Background review runs after a turn by default and uses the Bot's normal Muse model route to keep lasting information, rather than copying every message. It may add model usage; it does not require a Hindsight installation or credentials. Existing notes, journals and source references stay in place. Memory is local to this Muse home and does not synchronize between computers; current user instructions and project files take priority.

The Host exposes `museTeam.registerSessionAsBot(sessionId, { name?, role?, main? })`, `resolveCurrentSession(botId)` and `switchCurrentSession(botId, sessionId)` for the native IM adapter. The Bot ID remains stable when the user explicitly changes its current Session; the earlier Session remains in its history. Goals and jobs remain attached to their original Session. Registration and switching validate independent Session ownership and roll back roster changes if saving fails. An explicit switch may absorb an untouched automatic roster entry; customized or collaborating Bots retain their identities. Ordinary adopted user and goal turns keep native restart behavior; admitted Bot collaboration messages retain their original exchange recovery.

Native Feishu routes each app registration and chat ID to one Bot; threads retain their native reply location within their group. Existing group and private Sessions are registered without restarting them. The adapter passes the group or peer name as `nameHint`, using existing chat/message metadata without requesting contact permissions. The interface displays the chat title; a distinct addressable Bot name remains visible when titles repeat or need sanitizing. Missing metadata leaves the original Session title in use, and a user rename takes priority over later hints. Authentication, workspace isolation, message deduplication, cards, files and sending receipts remain owned by the native IM runtime. A Bot with a verified chat binding shows a circular Feishu mark above its activity indicator or Main Bot star while the Feishu connection and Host are available; the mark disappears on disconnect. Explicit `/new` and `/use` select a current Session for the same Bot rather than creating another team identity.

## Phone browser access

Open Muse over HTTPS, sign in with the computer's account, and select that computer. Android Chrome and iPhone Safari use the existing Bot conversations, live task progress, confirmation cards and file previews; adding the page to the home screen retains its selected computer. Selecting a conversation during initial loading takes priority over the default Main Bot landing, including while its Session list is still loading. The computer and Muse must remain running. A disconnected phone stops observing but does not cancel computer tasks; reconnect before sending further input. The [account gateway](../../../services/muse-accounts/README.md#desktop-website-access) owns login and computer routing.

## Browser message receipts

`POST /api/bot` accepts an optional `clientRequestId` on the `send` endpoint. The new-chat browser sender stores the request identifier, first target `sessionId` and a content fingerprint until admission is confirmed; its retries keep that original target even when the Bot moves to a new part. The ordinary conversation composer retains its native Session submission mechanism. Repeating the same request returns its original receipt; reusing the identifier for different content or another recipient is refused. Legacy calls without this field retain their boolean acknowledgement.

The `submission` endpoint takes the same fields and returns `status: accepted | missing | unknown`. `accepted` confirms native Session admission, not task completion. After a lost response, query this receipt before retrying. A `missing` result permits resubmission with the original identifier and unchanged payload; `unknown` permits observation only. The existing team request ledger retains a fingerprint and receipt, while the original text stays in the native Session. Reconciliation can confirm a pending receipt from that Session after a Host restart.

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
        memoryReview: true
        autoSessionBots: false
        sessionBotSyncIntervalMs: 30000
        github: false
        updateCheck: false
```

`agentPreset` chooses the registered Muse preset for new specialist Bot Sessions; `mainAgentPreset` chooses it for newly created Main Bots. `ensureMuseSpecialist` creates one Muse specialist when none is already configured, preserving existing specialist identities. All required presets must be available; creation never falls back to another preset. `contextManagement: host` leaves context compaction with the current Host. `goals: host` retains the Host goal tools and continuation behavior. `updateCheck: false` disables independent plugin and Harness update offers; Muse application updates supply the reviewed plugin. `github: false` disables the optional built-in GitHub MCP connector. The bundle does not replace the profile's web-search provider, model routes, account settings or permission policy.

`memoryReview: false` disables automatic background review while retaining the memory tools, saved notes and panel. Reviews use the selected Bot model, request its lowest supported reasoning level and start with a 2,048-token output budget; a truncated response can retry once with 8,192 tokens. Provider failures can fall back to the configured default model. These are ordinary model requests, charged through the existing Muse route. Host shutdown cancels and drains pending reviews before disposal completes; a canceled review does not save a late model response. Manually adopted Sessions keep their native model selection through catalog refreshes until an explicit model or effort change makes that selection Bot-managed. Automatically listed Session Bots retain native selection ownership after those changes.

`autoSessionBots: false` is the default and leaves ordinary Sessions outside the Bot roster. Saved automatic entries still refresh source availability without changing their identity, settings or memory; archived or missing sources remain saved but cannot receive group work. Restoring a source makes its entry available again. The manual adoption entry and native Feishu bindings still work. `sessionBotSyncIntervalMs` sets the roster's metadata refresh interval in milliseconds; native Session changes invalidate the cached result. Newly created Bot Sessions continue to use `short-drama`; registration preserves an existing Session's preset.

Changing a group working folder moves its member conversation to a new part at a later turn, including when the Host manages context. Host-managed Sessions move only when the target folder exists and the goal service confirms there is no unfinished goal. An ongoing group reply finishes in its original folder; earlier parts and their histories remain available. The change does not enable Bot-managed compaction or overflow recovery.

Only the Host holding the team's write lock can generate or save learning proposals. A read-only instance retains existing queues and proposals and rejects an explicit learning run before calling a model. Disabling learning or memory retains the saved learning data. Host shutdown stops new learning answers, cancels reviews and waits for admitted approvals and their saved results before releasing the team write lock.

Skill refusals are scoped to the Bot that received them. Refusals without a saved Bot identifier remain on disk but do not enter model requests; AGENTS.md refusals retain their project-folder scope. See the [learning-data upgrade guide](../../../docs/upgrade-guide/v0.2.2-rc.1/bot-learning-decline-ownership/guide.md) for legacy records.

A failed learning approval keeps its review content and error available for retry or decline across conversation-card remounts in the same client plugin instance. An already closed proposal disappears when the Host returns `bot/stale`. Client plugin disposal clears retained review content, cancels admitted answers and waits for them to settle; another client instance starts without that recovery state.

`create_bot` accepts `preset` and `resident_tools`; `update_bot` can replace both. A preset change applies to future new Sessions, while the current conversation keeps its existing preset. Resident tools are exact names saved on the Bot record. The shared Harness `tool_search` finds tools by capability; `tool_context` loads, pins, unpins or releases them. Each Bot's own chat, group chats and future conversation parts use its resident list. The capability catalog is shared, authorization still applies, and loading a name does not grant permission. Failed residency saves reject the operation and restore the previous Bot setting. Tool results remain in Session history after a release.

The Desktop composition keeps the registered Bot team tools available from the first model request, including `ask_user`, `show_view` and secure credential cards. Ordinary DSH Agent sessions exclude Bot management tools, and tool visibility does not grant Main Bot rights. User-selected additional tools retain their existing pin and release behavior. The integrated source uses DS Bot 0.2.4, including private Bot controls, approved learning proposals, avatar selection, Office tools and shared cards. Muse retains its existing shell, account footer, model and search services, Host context management and goal handling; the upstream standalone application and frame takeover are not activated.

Office `pptx inventory` and `pptx layout` resolve unrotated nested group boxes into slide coordinates in inches, applying each group’s child origin and horizontal and vertical scales. Layout checks use those boxes for off-slide shapes and overlapping text; text overflowing inside a box still needs rendering.

The optional `home` configuration selects a different Bot-state directory. Bot model and effort settings remain selectable in the interface; creating or messaging a Bot may issue a normal model request using the configured provider. Authentication and provider availability are governed by Muse's existing services.

The conversation activity row distinguishes waiting for a reply from receiving visible text and labels its clock as total turn time. Context status uses the recorded calibrated estimate and working target when paired; its tooltip lists the model window separately. Missing paired metadata retains the legacy context display. Ordinary tool calls update the running activity row without leaving separate transcript rows. Interactive questions, views, credential cards and team events remain visible when thinking is hidden.

Appearance changes save when the settings page closes. Selecting a preset accent or restoring the theme accent cancels any earlier pending custom color. Idle color inputs follow accepted preference updates.

The browser settings page reports whether the optional Bot browser automation is enabled. Saved grants remain visible when it is disabled, but new grants cannot be added; those grants do not change permissions for Muse's other browser tools. The browser panel and open-page reading remain separate from automation.

Submitting a browser handoff answer prepares the current Bot Session before consuming the hold. Preparation failures leave the original hold retryable; a replaced hold, switched Session or removed Bot refuses the old answer. Once dispatch starts, the same handoff cannot be submitted again even if dispatch or Session saving fails. `bot/handoff-unconfirmed` means the answer may already be queued and saving is unconfirmed; check the conversation before sending another request.

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
