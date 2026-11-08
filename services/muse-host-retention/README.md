# Muse host retention

English | [中文](README.zh.md)

This service inventories application releases and archived logs independently of company media retention. Its private policy identifies release families, required build files, log roots and explicit pins. It never reads or deletes account databases, employee projects, provider credentials or media volumes as cleanup targets.

## References and protection

The collector extracts only retention-root paths from process commands, working directories, executables, open descriptors, installed systemd files, effective unit properties, environment files, Nginx configuration, Docker mounts and container commands. Raw process arguments and configuration bodies are not persisted. Release symlinks and receipts form dependencies between versions. References from retained versions protect their dependencies transitively; self-references in a historical receipt do not make that release permanently active.

The planner protects directly referenced versions, explicit pins, unknown families, incomplete builds and at least two additional rollback candidates per family. A family without a referenced current version keeps three build-complete versions. Retained rollback candidates preserve their dependencies too. Required-file checks establish build completeness, not a successful live rollback or database downgrade compatibility. No service is switched to an older version during inspection.

Only numbered log archives matching the effective Nginx configuration and archived journal files can become log candidates. Active filenames are outside the selector. Open files, symlinks, recent writes and journal files without an archived state and old final-entry timestamp remain protected. Defaults retain releases and logs for at least 14 days. Missing roots, unreadable references, failed commands and truncated inventories fail the scan; they cannot be interpreted as empty reference sets.

## Verification

Run `python3 -m unittest discover -s services/muse-host-retention -p 'test_*.py'` and `python3 -m compileall -q services/muse-host-retention`. Tests use temporary roots, controlled snapshots and real symlinks. Production inventory requires root read access to process descriptors and system configuration; reports contain paths and protection reasons, not secrets.
