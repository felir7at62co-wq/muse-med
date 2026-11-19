"""Install systemd units for Jingliu and its Muse account bridge."""
from pathlib import Path

ROOT = "/srv/muse-workbenches"
REL = ROOT + "/current"
UNIT = Path("/etc/systemd/system")
entries = (
    ("muse-wb-edge", "edge", REL, ROOT + "/runtime/node/bin/node " + REL + "/edge.mjs"),
    ("muse-wb-jingliu", "jingliu", REL + "/jingliu", ROOT + "/runtime/jingliu/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 19743 --no-access-log"),
)

for unit, owner, cwd, command in entries:
    if unit == "muse-wb-edge":
        env = "Environment=MUSE_WORKBENCH_EDGE_CONFIG=" + ROOT + "/config/edge/config.json"
    else:
        env = "EnvironmentFile=" + ROOT + "/config/" + owner + "/service.env"
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
