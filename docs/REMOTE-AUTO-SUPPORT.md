# Remote Auto-Support (TeamClawd) — Notify-only Reporter (v1)

Goal: remote boxes (ex: Clawdwell) automatically post a concise health report to the primary Claw bridge inbox when Gateway/Console connectivity breaks.

This v1 is **notify-only**: it does not restart anything.

## Components

- Script: `scripts/clawd-bridge-reporter.sh`
- Systemd unit + timer: install on the remote box

## Required env on the remote box

- `BRIDGE_TOKEN=...`
- `BRIDGE_INBOX_URL=https://claw.nwesource.com/api/ops/bridge/inbox`

Optional:
- `REPORT_HOST_LABEL=clawdwell`
- `STATE_FILE=/var/lib/clawdwell/console-data/reporter-state.json`
- `LOOKBACK_MIN=20`

## Install (remote box)

1) Copy the script to the remote box:

- `/usr/local/bin/clawd-bridge-report`

Make executable:

```bash
chmod +x /usr/local/bin/clawd-bridge-report
```

2) Create env file:

```bash
sudo tee /etc/clawd-bridge-report.env >/dev/null <<'ENV'
BRIDGE_TOKEN=YOUR_TOKEN
BRIDGE_INBOX_URL=https://claw.nwesource.com/api/ops/bridge/inbox
REPORT_HOST_LABEL=clawdwell
STATE_FILE=/var/lib/clawdwell/console-data/reporter-state.json
LOOKBACK_MIN=20
ENV
```

3) Create systemd service:

```bash
sudo tee /etc/systemd/system/clawd-bridge-report.service >/dev/null <<'UNIT'
[Unit]
Description=TeamClawd notify-only reporter (posts gateway/console issues to bridge)
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/clawd-bridge-report.env
ExecStart=/usr/local/bin/clawd-bridge-report
UNIT
```

4) Create timer:

```bash
sudo tee /etc/systemd/system/clawd-bridge-report.timer >/dev/null <<'UNIT'
[Unit]
Description=Run TeamClawd reporter periodically

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
RandomizedDelaySec=20
Persistent=true

[Install]
WantedBy=timers.target
UNIT
```

5) Enable:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now clawd-bridge-report.timer
sudo systemctl list-timers | grep clawd-bridge-report
```

6) Manual test:

```bash
sudo systemctl start clawd-bridge-report.service
```

## Dedupe behavior

The script writes a signature to `STATE_FILE` and posts only when the signature changes (new errors / recovery).

## Future (v2)

- Optional remote restart endpoint gated by `REMOTE_OPS_ENABLED=1`
- Snapshot/restore mechanic before auto-remediation
