#!/usr/bin/env bash
set -euo pipefail

# Build an installable console bundle tarball.
# Usage:
#   bash scripts/make-bundle.sh clawdius /home/master/clawd/dist/clawdius-bundle.tar.gz

NAME="${1:-}"
OUT="${2:-}"
if [ -z "$NAME" ] || [ -z "$OUT" ]; then
  echo "Usage: $0 <name> <out.tar.gz>" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK_DIR="$(mktemp -d -p /tmp clawdconsole-bundle.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

mkdir -p "$WORK_DIR/console"

# Copy console sources (no node_modules, no .git)
# Prefer git (fast + deterministic) when available.
if [ -d "$ROOT_DIR/.git" ] && command -v git >/dev/null 2>&1; then
  git -C "$ROOT_DIR" ls-files -z | tar --null -T - -cf - | tar -xf - -C "$WORK_DIR/console"
else
  rsync -a --delete \
    --exclude node_modules \
    --exclude .git \
    --exclude console-data \
    "$ROOT_DIR/" "$WORK_DIR/console/"
fi

cat > "$WORK_DIR/QUICKSTART.md" <<MD
# ${NAME} Console — Quickstart

This bundle installs **Clawd Console** as a systemd service.

## Install

```bash
sudo systemctl stop ${NAME}-console.service || true
sudo rm -rf /opt/${NAME}
sudo mkdir -p /opt/${NAME}
cd /opt/${NAME}
# copy ${NAME}-bundle.tar.gz here
sudo tar -xzf ${NAME}-bundle.tar.gz
sudo bash install.sh
```

Open:

http://<SERVER_IP>:21337

Credentials:

/etc/${NAME}-console.env

## Domain + SSL (optional)

If you want a domain like **${NAME}.nwesource.com**:

1) Put the Console behind Nginx on 80/443.
2) Use certbot to request a certificate.

High-level:

- Nginx proxy target: http://127.0.0.1:21337
- certbot: \`certbot --nginx -d your.domain.example\`

## Bridge (token-only)

This bundle enables token-only bridge endpoints by default.
The token is stored here:

- \`BRIDGE_TOKEN=...\` in \`/etc/${NAME}-console.env\`

To bridge between boxes, copy the same BRIDGE_TOKEN to the other box.
MD

cat > "$WORK_DIR/install.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

NAME="__NAME__"
APP_DIR="/opt/${NAME}"
CONSOLE_DIR="$APP_DIR/console"
ENV_FILE="/etc/${NAME}-console.env"
UNIT_FILE="/etc/systemd/system/${NAME}-console.service"
DATA_DIR_DEFAULT="/var/lib/${NAME}/console-data"

if [ "$(id -u)" != "0" ]; then
  echo "Run as root." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node 22+ first (recommended), then rerun." >&2
  exit 1
fi

if [ ! -d "$CONSOLE_DIR" ]; then
  echo "Missing $CONSOLE_DIR (extract the bundle into $APP_DIR so $APP_DIR/console exists)" >&2
  exit 1
fi

echo "[1/4] Installing console dependencies…"
cd "$CONSOLE_DIR"
npm ci --omit=dev

echo "[2/4] Writing env file…"
if [ ! -f "$ENV_FILE" ]; then
  PASS=$(openssl rand -hex 12)
  BRIDGE=$(openssl rand -hex 32)
  cat > "$ENV_FILE" <<EOF
# ${NAME} Console env
PORT=21337
BIND=0.0.0.0
DATA_DIR=${DATA_DIR_DEFAULT}
AUTH_USER=nwesource
AUTH_PASS=${PASS}
ADMINONLY_ENABLED=1

# Bridge (token-only endpoints)
BRIDGE_TOKEN=${BRIDGE}

# Optional: Together serverless
# TOGETHER_API_KEY=

# Optional: force gateway token (otherwise auto-read /root/.clawdbot/clawdbot.json)
# GATEWAY_TOKEN=
EOF
  echo "Created $ENV_FILE"
  echo "Login: nwesource / $PASS"
  echo "BRIDGE_TOKEN: $BRIDGE"
else
  echo "Env file exists: $ENV_FILE (leaving as-is)"
fi

mkdir -p "$DATA_DIR_DEFAULT"

echo "[3/4] Installing systemd unit…"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=${NAME} Console
After=network.target

[Service]
Type=simple
EnvironmentFile=${ENV_FILE}
WorkingDirectory=${CONSOLE_DIR}
ExecStart=/usr/bin/node ${CONSOLE_DIR}/index.js
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "${NAME}-console.service"

echo "[4/4] Status:"
systemctl --no-pager --full status "${NAME}-console.service" | sed -n '1,30p'

echo "Done. Open: http://$(hostname -I | awk '{print $1}'):21337"
SH
sed -i "s/__NAME__/${NAME}/g" "$WORK_DIR/install.sh"
chmod +x "$WORK_DIR/install.sh"

mkdir -p "$(dirname "$OUT")"
# Put files at tar root (console/, install.sh, QUICKSTART.md)
tar -czf "$OUT" -C "$WORK_DIR" .

echo "Wrote: $OUT" >&2
ls -la "$OUT" >&2
