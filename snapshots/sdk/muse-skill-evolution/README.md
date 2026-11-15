# Native Session Skill learning

English | [中文](README.zh.md)

This keyless SDK scenario keeps the shipped profile alive between turns. A chat-only turn produces no review. A root turn writes and rereads a real file, then its completed evidence creates a persisted, tool-free native review Session on the same model route. The returned JSON proposal creates a real owned Skill, which the next ordinary root turn discovers and loads through the native `skill` tool.

Between turns, the fixture wraps the existing native `/permission workspace-write` handler to wait for the plugin's background queue before executing the unchanged permission command. This existing command supplies a synchronization point without calling the model. This wait does not create a review, a proposal or a Skill. The isolated workspace contains the real generated `SKILL.md`, the verified task file and an independent evidence summary. The only replaced service is the model backend; request headers, review input, response, catalog publication and tool results remain native Session data. The dedicated `snapshot-evolution` provider has no real-API fallback, so replay activation failures cannot send model traffic externally.

The default fixture imports the plugin source. Set `MUSE_SKILL_EVOLUTION_PACKAGE` to an already-built, unpacked plugin directory to exercise that artifact's exported `src/index.js` through the same SDK profile without compiling during the test. The fixture copies the package into its private home and resolves peers from the same workspace as the Host, using source peers for the TSX launcher and built exports for plain Node. It never installs registry peers.
