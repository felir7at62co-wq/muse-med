# Portable adapter tests

Set `MUSE_PURGE_PACKAGE_DIR` to an absolute directory containing the built optional package, including its `yaml` runtime dependency, then run `node --test third_party/optional-plugins/dsh-purge-community/tests/*.test.mjs`. These tests never locate an installed Muse or read a user profile.

Node 24 or newer is required. Windows runs include real isolated Node process trees using copied `node.exe` files, with paths containing spaces and non-ASCII characters. Other platforms run the portable assertions and explicitly skip the three Windows process cases. Generated files live in a unique operating-system temporary directory and are removed after each worker. Set `MUSE_PURGE_KEEP_TEST_FILES=1` to retain them for diagnosis.

The tests cover backup identity, missing-file recovery, original-byte restoration, concurrent ledger writes, native Muse shutdown behavior, known prompt and hook patch layouts, repeated application, and custom preset preservation. The fixed source fixtures are documented in `fixtures/NOTICE.md`.

The earlier full real-Cordis/SystemPrompt and real-Electron checks require a prepared application runtime and remain separate acceptance evidence. A portable CI run must not report those checks as executed merely because this suite passes. No model request, paid generation or real application shutdown is performed here.
