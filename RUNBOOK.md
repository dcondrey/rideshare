# Runbook

> Operational playbook for an operator deploying the **rideshare** webapp at an event. Audience: the human running the deployment, before, during, and after the event.

This is a *short-lived* deployment by design. The runbook reflects that — first-time setup is heavy, day-to-day operation is light, and the post-event wipe is mandatory.

If you are responding to a security incident, also read [`SECURITY.md`](SECURITY.md) and [`THREAT_MODEL.md`](THREAT_MODEL.md).

---

## Table of contents

1. [First-time setup checklist](#first-time-setup-checklist)
2. [Daily checks during the event](#daily-checks-during-the-event)
3. [Backup procedure](#backup-procedure)
4. [Common incidents](#common-incidents)
   - [Magic-link emails not sending](#magic-link-emails-not-sending)
   - [User can't sign in](#user-cant-sign-in)
   - [Admin lockout](#admin-lockout)
   - [DB corruption](#db-corruption)
   - [Deployment key rotation](#deployment-key-rotation)
   - [SSL cert renewal](#ssl-cert-renewal)
5. [Monitoring](#monitoring)
6. [Post-event wipe](#post-event-wipe)
7. [Migrations](#migrations)
8. [Updating the deployment](#updating-the-deployment)

---

## First-time setup checklist

Do this once per event, ideally a week before doors open.

### 1. Provision the host

- Linux VM, hardened, with a dedicated non-root service user (e.g. `rideshare`).
- Disk encryption (LUKS or your cloud's equivalent).
- Snapshots enabled, ideally with short retention (≤14 days post-event).
- Outbound internet allowed; inbound limited to 80/443 from the edge proxy.

### 2. Install Node ≥ 22.5

```bash
# Verify
node --version   # must print v22.5.x or newer
```

The app uses `node:sqlite` and the experimental SQLite API stabilised in 22.5. Older Node will fail at startup.

### 3. Clone and place the source

```bash
git clone https://example.com/rideshare /opt/rideshare
cd /opt/rideshare
git verify-tag $(git describe --tags)   # confirm signed tag
```

There is **no** `npm install`. The app has zero runtime npm dependencies.

### 4. Generate secrets

```bash
mkdir -p /opt/rideshare/secrets
chmod 700 /opt/rideshare/secrets

# Server secret (used for HMAC of allowlist entries and session-derived material)
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))" > secrets/server.secret
chmod 600 secrets/server.secret

# Deployment Ed25519 key (used to sign Verifiable Credentials)
node -e "
  const k = require('node:crypto').generateKeyPairSync('ed25519');
  process.stdout.write(k.privateKey.export({type:'pkcs8', format:'pem'}));
" > secrets/deployment.key
chmod 600 secrets/deployment.key

chown -R rideshare:rideshare secrets
```

### 5. Configure `.env`

Copy the example and fill in real values.

```bash
cp .env.example .env
chmod 600 .env
```

Required fields:

- `EVENT_HOST` — the public hostname (e.g. `rides.iiwxx.example.com`). MUST match the certificate.
- `ADMIN_EMAILS` — comma-separated list of admin email addresses.
- `SMTP_URL` *or* `RESEND_API_KEY` — pick one mail provider.
- `MAIL_FROM` — the `From:` address for magic links.
- `SERVER_SECRET_PATH` — defaults to `secrets/server.secret`.
- `DEPLOYMENT_KEY_PATH` — defaults to `secrets/deployment.key`.
- `EVENT_CONFIG_PATH` — defaults to `event.config.yaml`.

Optional:

- `TILE_PROXY_URL` — if set, all tile requests are proxied through this URL (recommended for privacy).
- `TRUST_PEERS` — comma-separated `did:web` identifiers we accept cross-event credentials from.
- `RATE_LIMIT_TUNING` — JSON overrides; defaults are sensible.

### 6. Fill in `event.config.yaml`

This is the public-facing config: event name, dates, venues, default map style, ride radius defaults. Reviewed by attendees as part of the source-readability promise.

### 7. Import the allowlist

```bash
# CSV with one email per line
node bin/allowlist-import.js < attendees.csv
```

The script HMACs each address with `secrets/server.secret` before insert; the plaintext list is never stored. Verify the count:

```bash
sqlite3 events.db "SELECT count(*) FROM allowlist;"
```

### 8. Publish the deployment DID document

```bash
node bin/did-publish.js
```

This writes `public/.well-known/did.json` with the deployment's public key. Verify it's served:

```bash
curl -fsSL https://$EVENT_HOST/.well-known/did.json | jq .
```

### 9. Smoke-test

```bash
node --test                    # all tests pass
node --check server.js         # syntax OK
node server.js &               # start
curl -fsS http://localhost:3000/health
```

### 10. Hand off to systemd / your process supervisor

Sample unit file is in `deploy/rideshare.service`. The unit runs as the `rideshare` user, uses `Restart=on-failure`, and sets `NoNewPrivileges=yes`.

---

## Daily checks during the event

Five minutes a day. Skipping these is fine for a one-day event; do them daily for a multi-day one.

- `curl -fsS https://$EVENT_HOST/health` returns `200`.
- `sqlite3 events.db "SELECT count(*) FROM audit WHERE created_at > datetime('now','-1 day');"` is non-zero (people are using it).
- Tail the systemd journal for `level=error` lines.
- Glance at `/admin/insights` for failed-magic-link rate spikes.

---

## Backup procedure

The only stateful artifact is `events.db`. We back it up using SQLite's online backup API, which is safe while the server is running.

### Take a backup

```bash
sqlite3 events.db ".backup '/var/backups/rideshare/events-$(date -u +%Y%m%dT%H%M%SZ).db'"
```

Move backups off-host to encrypted storage. Do **not** commit them to git.

### Restore a backup

```bash
systemctl stop rideshare
cp /var/backups/rideshare/events-<timestamp>.db /opt/rideshare/events.db
chown rideshare:rideshare /opt/rideshare/events.db
chmod 600 /opt/rideshare/events.db
systemctl start rideshare
```

### Verify integrity after restore

Once the audit hash chain ships (see [`docs/security/audit-tampering.md`](docs/security/audit-tampering.md)), restore is followed by:

```bash
node bin/audit-verify.js
```

Until then, integrity check is structural only:

```bash
sqlite3 events.db "PRAGMA integrity_check;"   # expect: ok
sqlite3 events.db "SELECT count(*) FROM audit;"   # cross-check against pre-restore count
```

### Backup cadence

- Hourly during the event.
- One archival backup at end-of-day, encrypted with `age` to a key held off-host.
- Wipe all backups within 30 days of the post-event wipe (see [Post-event wipe](#post-event-wipe)).

---

## Common incidents

### Magic-link emails not sending

**Symptom:** attendees report no email after submitting their address; insights dashboard shows magic-link issuance OK but delivery confirmations missing.

**Triage steps:**

1. Tail the journal: `journalctl -u rideshare -n 200 | grep -i mail`.
2. Look for HTTP 4xx/5xx from the mail provider.
3. Check provider quota (Resend dashboard / SMTP provider's status page).
4. Confirm `MAIL_FROM` domain has SPF + DKIM configured. Many providers silently drop misconfigured senders.
5. Verify outbound connectivity: `curl -v https://api.resend.com` from the host.
6. If the provider is down, switch credentials to the backup provider via `.env` and `systemctl restart rideshare`.

**Remediation:**

- If a provider outage, post a banner via `/admin/banner` and instruct attendees to wait.
- If misconfiguration, fix and **purge** the queued links so users don't get stale ones: `sqlite3 events.db "DELETE FROM magic_links WHERE created_at < datetime('now','-15 minutes');"`.

### User can't sign in

**Symptom:** an attendee says they entered their email and never received a link, *and* the mail system is fine.

**Triage steps:**

1. Confirm they are on the allowlist:
   ```bash
   node bin/allowlist-check.js user@example.com
   # prints "in" or "not in"
   ```
2. If "not in": add them via `/admin/allowlist`. Confirm the addition appears in `audit`.
3. If "in": check the rate limit table:
   ```bash
   sqlite3 events.db "SELECT * FROM rate_limits WHERE key LIKE '%user@example.com%';"
   ```
   Clear the per-email key if they've been hammering the form:
   ```bash
   sqlite3 events.db "DELETE FROM rate_limits WHERE key='magic:user@example.com';"
   ```
4. Ask them to check spam, including any corporate quarantine.
5. As a last resort, manually issue a one-time link from `/admin/issue-link?email=...`. This action is audited.

### Admin lockout

**Symptom:** the only admin email is unreachable (e.g., admin's company SSO is broken and they can't get email).

**Recovery:**

Admin status is determined by the `ADMIN_EMAILS` env var, not by anything in the DB. There is no in-DB privilege escalation route, by design.

```bash
# Edit env
sudo $EDITOR /opt/rideshare/.env
# Add the new admin email to ADMIN_EMAILS=...
sudo systemctl restart rideshare
```

The new admin still needs to receive a magic link to sign in, so make sure their email account works first. If neither admin can receive email, you have a bigger problem (see [Magic-link emails not sending](#magic-link-emails-not-sending)).

### DB corruption

**Symptom:** `PRAGMA integrity_check;` returns anything other than `ok`, or the server logs `SQLITE_CORRUPT`.

**Recovery:**

1. Stop the server: `systemctl stop rideshare`.
2. Move the corrupt DB aside: `mv events.db events.db.corrupt-$(date +%s)`.
3. Restore the most recent backup (see [Restore a backup](#restore-a-backup)).
4. Run integrity check + audit chain verification.
5. Start the server.
6. **Communicate.** Anyone who signed up between the backup and the corruption needs to re-bind their `did:key` (the binding is in the audit log, but if it's gone we can't tell the difference between "new attendee" and "lost attendee"). Post the cutoff time on `/admin/banner`.

### Deployment key rotation

**When:** suspected compromise, scheduled rotation, or end-of-event for the long-term archival key.

**Impact:** every Verifiable Credential issued under the old key becomes unverifiable by anyone who has not cached the old `did.json`. Treat as a serious operation.

**Procedure:**

1. Generate the new key (see step 4 of [First-time setup](#4-generate-secrets)) into `secrets/deployment.key.new`.
2. Update `did.json` to list **both** the old and new public keys, with the new one marked primary.
3. Restart the server with `DEPLOYMENT_KEY_PATH=secrets/deployment.key.new`.
4. Reissue any in-flight credentials.
5. After 30 days (or the event ends, whichever is sooner), remove the old key from `did.json`.
6. Audit the rotation: `node bin/audit-write.js key-rotation`.

**Do not** delete the old private key file until you are sure no holder still relies on a credential signed by it. The old key in cold storage lets you re-issue an equivalent credential under the new key if needed.

### SSL cert renewal

The app does not handle TLS. Cert renewal is your edge proxy's job (Caddy auto-renews; nginx with certbot is straightforward; Cloudflare handles it).

The dependency you should document for your event's runbook is: **whose responsibility is the cert?** Common modes:

- **Caddy on the same host:** automatic; just monitor that it's running.
- **Cloudflare:** automatic; just monitor the origin cert (15-year, set-and-forget).
- **Let's Encrypt via certbot:** monthly renewal cron; add to monitoring.

---

## Monitoring

Per-metric, what to watch and what's abnormal:

| Metric | Source | Alert threshold |
| --- | --- | --- |
| Failed magic-link issuance rate | `audit` table, `event_type='magic_link_failed'` | > 20 in 5 min → investigate provider |
| Magic-link delivery latency (issue → use) | `magic_links.consumed_at - created_at` | p95 > 5 min → mail provider degraded |
| Credential issuance failures | logs, `level=error component=trust` | any → investigate immediately |
| Audit chain breaks | `bin/audit-verify.js` (when chained) | any → escalate to security; isolate host |
| `/health` failure | external probe | 2 consecutive → page operator |
| Process restarts | systemd | > 1 / hour → investigate |
| DB file size | `du -h events.db` | growth > 100MB / day → unusual; investigate |
| Rate-limit table size | `SELECT count(*) FROM rate_limits;` | > 50,000 → being scanned |

Minimal monitoring stack: a cron that hits `/health`, plus `journalctl -p err` shipped to a SIEM if you have one. For one-day events a phone alarm is fine.

---

## Post-event wipe

**Mandatory.** This is a privacy commitment to attendees, not a suggestion.

Run within 30 days of the event ending. Sooner is better.

```bash
# 1. Stop the service
systemctl stop rideshare
systemctl disable rideshare

# 2. Take a final encrypted archival snapshot, IF AND ONLY IF
#    the event constitution requires it (rare). Otherwise skip.
# sqlite3 events.db ".backup /tmp/events-final.db"
# age -r <archive-recipient> /tmp/events-final.db > /var/archive/events-final.db.age
# shred -u /tmp/events-final.db

# 3. Wipe the DB
shred -u /opt/rideshare/events.db

# 4. Wipe any backups
find /var/backups/rideshare -type f -exec shred -u {} \;
rmdir /var/backups/rideshare

# 5. Wipe secrets
shred -u /opt/rideshare/secrets/*
rmdir /opt/rideshare/secrets

# 6. Remove the deployment
rm -rf /opt/rideshare

# 7. Destroy snapshots
#    (cloud-specific; use your provider's CLI)

# 8. Rotate or destroy the mail-provider API key
#    so a leaked .env elsewhere can't replay messages.

# 9. Tell attendees you're done.
```

Verify nothing remains:

```bash
find / -name 'events.db*' 2>/dev/null
find / -name 'deployment.key*' 2>/dev/null
```

Both should print nothing.

---

## Migrations

The schema is bootstrapped on first start by `lib/db.js`. Additive changes (new columns with `DEFAULT`, new tables, new indexes) are handled at startup via idempotent `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN` blocks guarded by `PRAGMA table_info(...)` checks.

For non-additive changes (rename, drop, type change):

1. Take a backup.
2. Stop the server.
3. Apply migration via a versioned script in `bin/migrations/`. Pattern:
   ```sql
   BEGIN;
   ALTER TABLE rides RENAME TO rides_v1;
   CREATE TABLE rides ( ... );
   INSERT INTO rides SELECT ... FROM rides_v1;
   DROP TABLE rides_v1;
   COMMIT;
   ```
4. Run integrity check.
5. Start the server.

We deliberately avoid an ORM-style migration framework. The migration scripts are short, hand-written, and reviewable.

---

## Updating the deployment

For an additive update (no schema break, no env changes):

```bash
cd /opt/rideshare
git fetch origin
git verify-tag $(git describe --tags origin/main)   # confirm signed
git checkout <new-tag>
node --test                                          # must pass
systemctl restart rideshare
curl -fsS https://$EVENT_HOST/health                 # verify
```

For an update with schema changes: take a backup first, then follow [Migrations](#migrations).

For an update with new env vars: update `.env`, then restart. Document the change in your event's local notes so the next operator knows.

The reference deployment publishes a build hash at `/health` — see [`BUILD.md`](BUILD.md) for how to verify it matches your local checkout.

---

## See also

- [`SECURITY.md`](SECURITY.md) — disclosure policy, defense layers.
- [`THREAT_MODEL.md`](THREAT_MODEL.md) — what we model.
- [`TRUST.md`](TRUST.md) — DID + VC architecture.
- [`BUILD.md`](BUILD.md) — reproducible-build verification.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — for operators who patch in their own changes.
