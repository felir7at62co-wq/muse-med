# Muse host retention

English | [中文](README.zh.md)

This service inventories application releases and archived logs independently of company media retention. Its private policy identifies release families, required build files, log roots and explicit pins. It never reads or deletes account databases, employee projects, provider credentials or media volumes as cleanup targets.

## References and protection

The collector extracts only retention-root paths from process commands, working directories, executables, mapped files, environment values, open descriptors, installed systemd files, effective unit properties, environment files, Nginx configuration, Docker mounts and container commands. Raw process arguments and configuration bodies are not persisted. Release symlinks and receipts form dependencies between versions. References from retained versions protect their dependencies transitively; self-references in a historical receipt do not make that release permanently active.

The planner protects directly referenced versions, explicit pins, unknown families, incomplete builds and at least two additional rollback candidates per family. A family without a referenced current version keeps three build-complete versions. Retained rollback candidates preserve their dependencies too. Required-file checks establish build completeness, not a successful live rollback or database downgrade compatibility. No service is switched to an older version during inspection.

Only numbered log archives matching the effective Nginx configuration and archived journal files can become log candidates. Active filenames are outside the selector. Open files, symlinks, recent writes and journal files without an archived state and old final-entry timestamp remain protected. Defaults retain releases and logs for at least 14 days. Missing roots, unreadable references, failed commands and truncated inventories fail the scan; they cannot be interpreted as empty reference sets.

## Preview and recovery

The observer stores private SQLite audit rows and the latest full inventory in `state_dir`. Dry-run mode changes neither release directories nor log archives. Promotion requires at least 24 continuous hours from the same code and policy, no observation gaps exceeding `maximum_gap_seconds`, no errors or target mutations, a recent observation and a matching runtime test qualification. Code or policy changes require a new preview; changing the mode alone does not change the policy digest. Approval identifies a fixed sequence of observations. Re-running promotion after activation does not grant another approval.

Enabled cleanup rechecks references and filesystem identities before each mutation. It atomically moves candidates to an owner-only quarantine on the same filesystem, waits another 24 hours, then rechecks before deletion. A new reference to any pending object restores the entire pending batch, preserving dependencies between quarantined releases. A shrinking rollback reserve also restores its version. Restoration never overwrites a replacement. Uncertain moves, interrupted purges, changed contents and failed scans stop execution for operator review. Dry-run mode suspends both quarantine and deletion, preserving pending objects.

Each invocation moves at most ten objects totalling 1 GiB and separately deletes at most ten quarantined objects totalling 1 GiB. Restoration is not limited by the deletion budget. Active deployment units suspend release selection and final deletion. Deployment writers must take the same exclusive `state_dir/cleanup.lock` before changing release references; an uncoordinated root writer cannot be made safe by periodic scans alone. Existing Nginx rotation remains responsible for creating archives. This service manages only expired closed archives, without truncating active logs or changing journal retention globally.

## Verification

Run `python3 -m unittest discover -s services/muse-host-retention -p 'test_*.py'` and `python3 -m compileall -q services/muse-host-retention`. Build with `python3 services/muse-host-retention/build.py --output .artifacts/host-retention.tar.gz`. The reproducible bundle includes file digests and compiles every Python module. Tests use temporary roots, controlled clocks and real subprocesses, files, symlinks and quarantine recovery. Production inventory requires root read access to process descriptors and system configuration; reports contain paths and protection reasons, not secrets.

## Server operation

Install the verified bundle in an immutable digest-named directory below `/opt/muse/host-retention/releases`, then run its `deploy.py install` as root. Installation verifies every file, runs the isolated tests on the server, writes `/etc/muse/host-retention/policy.json` in dry-run mode and records the first successful observation. Existing policy or audit history stops installation; investigate partial setup before resuming it. The installer creates only `muse-host-retention-observe` and `muse-host-retention-review` units. It does not restart accounts or containers, change media retention or reset its preview.

The periodic timer uses the policy interval. The persistent one-time review timer runs after the first successful observation plus the preview duration and maximum gap allowance. Review records success or failure in `/var/lib/muse-host-retention/review.json`; failure leaves cleanup disabled. Deployment, qualification, approval, the latest inventory and current status are private records in the same directory. The audit database retains the approval observations and pending recovery records. This service does not purge its own audit history. To suspend cleanup, atomically change the policy mode to `dry-run`; do not delete the database or quarantine directories. Changing other policy fields or code requires fresh qualification and a new continuous preview before approval.
