# Clawdwell ↔ Clawdio protocol (ops + sync)

Goal: let a secondary box ("Clawdwell") execute risky/iterative changes while keeping Clawd Console improving upstream.

## Roles

- **Clawdio (primary box):** upstream source of truth (GitHub repo), builds tar bundles, reviews/merges changes.
- **Clawdwell (test box):** runs experiments, makes local commits if needed, reports results, then upstreams clean patches.

## 1) Stay in sync (git workflow)

On Clawdwell (assuming Console lives at `/opt/clawdwell/console` and is a git checkout):

```bash
cd /opt/clawdwell/console

git status -sb
# keep local commits on top

git pull --rebase
npm ci --omit=dev
systemctl restart clawdwell-console.service
systemctl status clawdwell-console.service --no-pager | sed -n '1,25p'
```

If the repo is not a git checkout (installed from tar), update by downloading the latest tar and re-running the installer.

## 2) Reporting: first-run notes + outcomes

Canonical notes file on Clawdwell:

- `/var/lib/clawdwell/console-data/clawdwell-first-100-steps.md`

Keep it **timestamped** and include:
- commands executed
- files changed (path + what)
- service restarts
- why the change was needed
- observable results

### Exposing notes for retrieval

Recommended (behind Console auth):
- `GET /api/ops/clawdwell-notes` → returns `{ ok, path, text }`
- `POST /api/ops/clawdwell-notes` → writes `{ text }`

This allows the primary box to pull the notes without manual copy/paste.

## 3) “Risky moves” policy

A risky move is anything that could:
- break auth/session behavior
- change gateway auth/bind policies
- change service units
- alter firewall/network exposure
- run automated dependency upgrades (`npm audit fix`, `apt full-upgrade`, etc.)

Rules:
1) Prefer doing risky moves on Clawdwell first.
2) Make a backup copy of each file before editing.
3) Log every risky move in the notes file.
4) If a change works, upstream it as a small isolated patch.

## 4) When to upstream

Upstream immediately when:
- the fix affects first-run UX (auth loops, UI bounce, setup friction)
- it is safe + deterministic

Keep local-only when:
- it is droplet-specific (hostnames, passwords, secrets)

## 5) Security defaults

- Keep `/adminonly` disabled by default.
- Keep Discord disabled by default.
- Avoid `Secure` cookies on plain HTTP (browsers will drop them).

