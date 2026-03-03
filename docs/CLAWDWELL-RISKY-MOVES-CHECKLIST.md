# Clawdwell risky moves checklist

Use this checklist before doing anything high-impact on the Clawdwell droplet.

## Before
- [ ] Confirm current state:
  - [ ] `systemctl status clawdwell-console.service --no-pager | head`
  - [ ] `clawdbot gateway status` (if gateway involved)
- [ ] Create backups of files you will edit:
  - [ ] `cp -a <file> <file>.bak.$(date +%F-%H%M%S)`
- [ ] Note the goal + rollback plan in the notes file.

## During
- [ ] Change one thing at a time.
- [ ] Restart only the service that needs it.
- [ ] Verify the expected user-visible behavior.

## After
- [ ] Record:
  - [ ] exact commands
  - [ ] exact files changed
  - [ ] observed behavior
  - [ ] whether rollback was needed
- [ ] If successful and generalizable, upstream as a minimal patch.

## Red flags
Avoid running these without explicit decision to accept risk:
- `npm audit fix`
- large dependency upgrades
- firewall/network exposure changes
- switching gateway bind from loopback to LAN/public

