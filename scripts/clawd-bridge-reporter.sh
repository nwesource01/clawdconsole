#!/usr/bin/env bash
set -euo pipefail

# clawd-bridge-reporter.sh
# Notify-only reporter: posts health/issues to a TeamClawd bridge inbox.
# Intended to run via systemd timer on remote boxes (e.g., Clawdwell).
#
# Required env:
#   BRIDGE_TOKEN
#   BRIDGE_INBOX_URL   (e.g. https://claw.nwesource.com/api/ops/bridge/inbox)
# Optional:
#   REPORT_HOST_LABEL  (e.g. clawdwell)
#   STATE_FILE         (default: /var/lib/clawdwell/console-data/reporter-state.json)
#   LOOKBACK_MIN       (default: 20)

BRIDGE_TOKEN="${BRIDGE_TOKEN:-}"
BRIDGE_INBOX_URL="${BRIDGE_INBOX_URL:-}"
REPORT_HOST_LABEL="${REPORT_HOST_LABEL:-$(hostname)}"
STATE_FILE="${STATE_FILE:-/var/lib/clawdwell/console-data/reporter-state.json}"
LOOKBACK_MIN="${LOOKBACK_MIN:-20}"

if [[ -z "$BRIDGE_TOKEN" || -z "$BRIDGE_INBOX_URL" ]]; then
  echo "Missing BRIDGE_TOKEN or BRIDGE_INBOX_URL" >&2
  exit 2
fi

since_ts="${LOOKBACK_MIN} minutes ago"
now_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$(dirname "$STATE_FILE")"
if [[ ! -f "$STATE_FILE" ]]; then
  printf '{"lastSig":"","lastPost":""}\n' >"$STATE_FILE"
fi

lastSig="$(STATE_FILE="$STATE_FILE" python3 - <<'PY'
import json, os
p = os.environ.get("STATE_FILE")
try:
  j=json.load(open(p,"r",encoding="utf-8"))
except Exception:
  j={}
print(j.get("lastSig", ""))
PY
)"

# Collect symptoms (best-effort)
port_listen="$(ss -ltn 2>/dev/null | grep -E ':18789\b' || true)"

gw_errs="$(journalctl -u clawdbot-gateway.service --since "$since_ts" --no-pager 2>/dev/null | egrep -i "(error|fail|exception|ECONNREFUSED|timeout)" | tail -n 40 || true)"
console_errs="$(journalctl -u clawdwell-console.service --since "$since_ts" --no-pager 2>/dev/null | egrep -i "(ECONNREFUSED|gateway timeout|not connected|error|fail)" | tail -n 40 || true)"

problem=0
if [[ -z "$port_listen" ]]; then
  problem=1
fi
if echo "$gw_errs" | grep -qiE "ECONNREFUSED|timeout|error|fail|exception"; then
  problem=1
fi
if echo "$console_errs" | grep -qiE "ECONNREFUSED|gateway timeout|not connected"; then
  problem=1
fi

# Compose report
summary="OK"
if [[ "$problem" == "1" ]]; then
  summary="Gateway trouble"
fi

body="# TeamClawd Auto-Support Report\n\n"
body+="- host: ${REPORT_HOST_LABEL}\n"
body+="- ts: ${now_iso}\n"
body+="- status: ${summary}\n\n"
body+="## Port 18789 listening\n"
body+="\n\`\`\`\n${port_listen:-"(not listening)"}\n\`\`\`\n\n"

if [[ -n "$console_errs" ]]; then
  body+="## Recent console symptoms (last ${LOOKBACK_MIN}m)\n\n\`\`\`\n${console_errs}\n\`\`\`\n\n"
fi
if [[ -n "$gw_errs" ]]; then
  body+="## Recent gateway symptoms (last ${LOOKBACK_MIN}m)\n\n\`\`\`\n${gw_errs}\n\`\`\`\n\n"
fi

# Signature to dedupe
sig="$(printf "%s" "$summary|$port_listen|$console_errs|$gw_errs" | sha256sum | awk '{print $1}')"
if [[ "$sig" == "$lastSig" ]]; then
  exit 0
fi

# Post to bridge
payload=$(REPORT_HOST_LABEL="$REPORT_HOST_LABEL" SUMMARY="$summary" BODY="$body" python3 - <<'PY'
import json, os
print(json.dumps({
  "summary": f"{os.environ.get('REPORT_HOST_LABEL','host')}: {os.environ.get('SUMMARY','OK')}",
  "text": os.environ.get('BODY',''),
}))
PY
)

curl -sS \
  -H "X-Clawd-Bridge-Token: ${BRIDGE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$payload" \
  "$BRIDGE_INBOX_URL" >/dev/null

STATE_FILE="$STATE_FILE" SIG="$sig" NOW_ISO="$now_iso" python3 - <<'PY'
import json, os
p = os.environ.get("STATE_FILE")
try:
  j=json.load(open(p,'r',encoding='utf-8'))
except Exception:
  j={}
j['lastSig'] = os.environ.get('SIG','')
j['lastPost'] = os.environ.get('NOW_ISO','')
json.dump(j, open(p,'w',encoding='utf-8'))
PY
