"""Install systemd units for the two original applications and their account bridge."""
from pathlib import Path

ROOT = "/srv/muse-workbenches"
REL = ROOT + "/current"
UNIT = Path("/etc/systemd/system")
entries = (
    ("muse-wb-edge", "edge", REL, ROOT + "/runtime/node/bin/node " + REL + "/edge.mjs"),
    ("muse-wb-workshop", "workshop", REL + "/workshop", ROOT + "/runtime/workshop/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 19741 --no-access-log"),
    ("muse-wb-worker", "workshop", REL + "/workshop", ROOT + "/runtime/workshop/bin/python -m app.worker"),
    ("muse-wb-web", "workshop", REL + "/web", ROOT + "/runtime/node/bin/node " + REL + "/web/server.js"),
    ("muse-wb-jingliu", "jingliu", REL + "/jingliu", ROOT + "/runtime/jingliu/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 19743 --no-access-log"),
)

for unit, owner, cwd, command in entries:
    if unit == "muse-wb-edge":
        env = "Environment=MUSE_WORKBENCH_EDGE_CONFIG=" + ROOT + "/config/edge/config.json"
    elif unit == "muse-wb-web":
        env = "Environment=HOSTNAME=127.0.0.1 PORT=19742 NODE_ENV=production NEXT_TELEMETRY_DISABLED=1"
    else:
        env = "EnvironmentFile=" + ROOT + "/config/" + owner + "/service.env"
    if unit == "muse-wb-worker":
        env += "\nEnvironment=ROLE=worker"
    content = f"""[Unit]
Description=Muse workbenches - {unit}
After=network.target docker.service
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=simple
User=muse-{owner}
Group=muse-{owner}
WorkingDirectory={cwd}
{env}
ExecStart={command}
Restart=on-failure
RestartSec=4
TimeoutStopSec=60
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths={ROOT}/state/{owner}
MemoryMax=4G
CPUQuota=300%

[Install]
WantedBy=multi-user.target
"""
    (UNIT / (unit + ".service")).write_text(content)
