# Release the independent studio

English | [中文](README.zh.md)

The independent studio uses its own Linux systemd unit, unprivileged user, release directory, SQLite database, and media directory. It listens only on loopback and runs with generation disabled. This procedure uses existing authorized server access; it does not install an access key, modify the shared Muse service or Nginx, or publish a listener to the network.

## Build and verify a release

Use Python 3.11 or later and the upstream revision pinned in the [Dockerfile](../Dockerfile). In a clean checkout of that revision, apply `patch-upstream.mjs`, install the frontend dependencies with `npm ci --prefix <checkout>/frontweb`, and run `node integrations/localminidrama/build-web.mjs <checkout> --base /` from the Muse repository. Build while the checkout is quiescent.

```sh
python3 integrations/localminidrama/standalone/package_payload.py build /path/to/checkout /path/to/releases/muse-platform.tgz
python3 integrations/localminidrama/standalone/package_payload.py verify /path/to/releases/muse-platform.tgz --sha256 <trusted-sha256>
```

The output directory must already exist outside the upstream checkout. Build creates a new file without replacing an existing release. The archive contains backend source, migrations, skills, package metadata, the built frontend, and a manifest. It does not contain installed dependencies or provider configuration. Transfer the release and its full checksum through an approved channel; verify the checksum and file manifest on the destination before extraction. Run `python3 -B integrations/localminidrama/standalone/test_package_payload.py` to check the helper without a server.

## Stage and check the Linux release

1. Confirm the independent unit's ownership and status with `systemctl cat muse-standalone-platform.service` and `systemctl show muse-standalone-platform.service -p ActiveState -p MainPID`. Inspect the loopback port, available disk for both the release and an independent backup, memory, and any shared service status read-only. If another service owns port 19590 or any target path, stop the release procedure.
2. Extract the verified archive into a new staging directory, then install backend dependencies inside it as an unprivileged build user with `npm ci --omit=dev` in `backend-node`. Use the Node 22 runtime for both installation and execution. Check that `better-sqlite3` can open an in-memory database under that runtime before making the staged directory an immutable versioned release under `/opt/muse/standalone-platform/releases/`. Do not copy Windows dependencies or reuse a Linux dependency tree from a different lockfile.
3. Use a dedicated `muse-standalone` user and group. Stage [the unit](muse-standalone-platform.service) with both `RELEASE` occurrences replaced by the same release name, and set `ExecStart` to the chosen absolute Node path. Review the unit with `systemd-analyze verify`. Confirm that the host supports systemd's `IPAddressDeny` and `IPAddressAllow` enforcement before starting. Set up [the configuration](config.example.yaml) as `/var/lib/muse-standalone-platform/app/configs/config.yaml`, retaining any already verified independent configuration. Keep the runtime data writable only for the dedicated user; it must not include any shared or upstream data path.

## Back up and start the independent unit

For an upgrade, stop only the independent unit and confirm it is inactive. Save the unit, the private configuration, a SQLite backup made using SQLite's backup API, and the associated complete storage directory together in a new private backup directory. Verify the backup using `PRAGMA quick_check` and compare its media inventory with the source. For a new deployment, start with an empty independent data directory or import a verified database and media copy authorized for this deployment. Never point the unit to an original live data store, merge tenants, or copy provider credentials into the active database.

Install the validated unit and run `systemctl daemon-reload` followed by `systemctl start muse-standalone-platform.service`. Check the independent unit and fetch `http://127.0.0.1:19590/health`: expect `status: "ok"`, `generationBackend: "unconfigured"`, and `backgroundGeneration: false`. From a client, forward the server's loopback port to a local loopback port over an authorized SSH session. Set the desktop process's `MUSE_LOCALMINIDRAMA_URL` to that tunnel address before using the repository's normal desktop launcher.

Check the project list, one retained production package, the original prompt and references for a historical video, and media downloads. Confirm the shared service PID is unchanged before completing the handoff. If health or history verification fails, stop only the independent unit and retain the logs, failed release, and current data. Keep the prior unit and prior data snapshot together: only run the prior release after validating schema compatibility or restoring a verified matching database and storage copy. Do not open a possibly migrated database with an unverified older release.
