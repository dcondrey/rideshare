# Runbook

Running **rideshare** at an event. For security incidents also read [`SECURITY.md`](SECURITY.md) and [`THREAT_MODEL.md`](THREAT_MODEL.md).

**Single instance only** (SQLite plus in-memory rate limiter; see [Limitations in the README](README.md#limitations)). A second replica gets its own empty rate-limit table and, unless it shares the SQLite file, an empty database. One instance handles a few thousand users.

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

Once per event, ideally a week out. Per-platform detail: [README.md > Deploy](README.md#deploy).

### 1. Pick a platform and deploy

- **Docker:** `cp .env.example .env` (fill it in), `docker compose up -d`. SQLite lives in the `rideshare-data` named volume.
- **Railway:** one-click template, env vars in the Railway UI, Volume at `/data`.
- **Render:** **New > Blueprint** on this repo; `render.yaml` provisions the service and a 1GB disk.
- **Fly.io:** `fly launch`, `fly volumes create data`, `fly secrets set ...`, `fly deploy`.

No `npm install`: zero runtime dependencies. Requires Node ≥ 22.5 (`engines.node` in `package.json`) for `node:sqlite`.

### 2. Set the required environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `APP_URL` | Yes | | Public URL. Sets the `did:web:<host>` identity; get it right before first boot. |
| `SESSION_SECRET` | Yes | | 32+ random hex bytes. Signs sessions and magic-link tokens. |
| `ALLOWLIST_SALT` | Yes | | 32+ random hex bytes. HMAC key for attendee email hashing. |
| `ADMIN_EMAILS` | Yes | | Comma-separated. Not enough to sign in on its own (step 4). |
| `EMAIL_FROM` | Yes | | RFC 5322 sender, e.g. `"Rideshare <noreply@x.com>"`. |
| `RESEND_API_KEY` | one of | | Recommended mail transport. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` | one of | | Your own SMTP instead of Resend. |
| `SMTP_ALLOW_PLAINTEXT` | no | `false` | Local relay without TLS only. With `SMTP_SECURE=false`, STARTTLS is otherwise required. |
| `PORT` | no | `3000` | |
| `DATABASE_PATH` | no | `./data/app.db` (`/data/app.db` in Docker) | SQLite file. |
| `TRUST_PROXY` | no | `false` | `true` behind any proxy/edge (Railway, Render, Fly). Uses the last `X-Forwarded-For` hop (one proxy). Left `false` behind a proxy, everyone shares one per-IP bucket (server warns once). |
| `MAGIC_LINK_RATE_LIMIT` | no | `5` | Sign-in emails per address per hour (in-memory). |
| `SESSION_LIFETIME_DAYS` | no | `14` | Session cookie lifetime. |

`config.js` exits at boot naming the first missing required var. If the process won't start, read stderr first.

### 3. Fill in `event.config.yaml`

```bash
cp event.config.example.yaml event.config.yaml
```

- Gitignored, so upgrades can't conflict on it. If missing, the app uses the example and warns each start (attendees see "Your Event").
- Validated at boot; bad fields stop the process, listed by path.
- Public config: event name, dates, venues, airports, map style, meetup pins. Most fields editable live at `/admin/config`. Schema: [README.md > Configuration](README.md#configuration).

### 4. Bootstrap the admin allowlist

`ADMIN_EMAILS` only authorizes `/admin` after sign-in. Sign-in needs the allowlist (`lib/auth.js` checks `isAllowed(email)`, no admin bypass), which starts empty. Seed it from the CLI.

From the repo root, with `.env` in place and a database at `DATABASE_PATH`:

```bash
printf 'email\nyou@example.com\n' > admins.csv
npm run allowlist:import -- admins.csv --append
```

```
Appended to the allowlist from /srv/rideshare/admins.csv
  parsed  1 rows
  skipped 0 invalid
  added   1
  total   1 entries now on the allowlist
```

- Same path as `/admin/allowlist` (`lib/allowlist.js#importAllowlistCsv`): stores only the `ALLOWLIST_SALT` HMAC (`lib/crypto.js`), logs `allowlist.append` to `audit_log`.
- Include every `ADMIN_EMAILS` address. Then delete the CSV (plaintext addresses).

### 5. Import the attendee allowlist

All three use the same code and store only HMACs:

| Method | When |
|---|---|
| `npm run allowlist:import -- list.csv` | Terminal or deploy script. Default replaces; `--append` adds. |
| `allowlist.csv` in the project root | Seeded on first boot only if the allowlist is empty. Gitignored. **Not in Docker**: `.dockerignore` excludes `allowlist*` and `*.csv`; use the CLI against the container. |
| `/admin/allowlist` | Paste or upload, choose **Replace** or **Append**. |

CSV: one email column, or any file with an `email` header. Invalid rows are skipped and counted. See [README.md > Importing attendees](README.md#importing-attendees).

### 6. Confirm the deployment identity came up

First boot generates an Ed25519 key and a `did:web:<host-of-APP_URL>` identity. Key files are outside the DB and **not** in `npm run backup`; back them up separately:

- `DEPLOYMENT_KEY_PATH`: Ed25519 signing key.
- `DEPLOYMENT_KEY_PATH.es256`: signs SD-JWT VCs and OpenID4VP requests.
- `DEPLOYMENT_KEY_PATH.x25519`: DIDComm key agreement.

(Older releases kept the key in the `signing_keys` table; `lib/keys.js` moves it to the file on first boot and clears the row.)

```bash
curl -fsS https://$APP_URL/health | jq .
# { "status": "ok", "checks": { "db": true, "signingKey": true } }

curl -fsS https://$APP_URL/.well-known/did.json | jq .
```

If `signingKey` is `false` or `did.json` 500s, check logs for `[trust]` and `[keys]` and make sure the DB and key path are writable.

**Changing `APP_URL` after first boot blocks startup** (the DID is pinned in the key file; the error names both DIDs). To move host: move the key file aside and clear the `deployment_identity` row. Old credentials verify only while the old host serves `/.well-known/did.json`.

### 7. Smoke-test

```bash
npm test                                       # all tests pass (per CLAUDE.md toolchain)
curl -fsS https://$APP_URL/health              # { "status": "ok", ... }
```

---

## Daily checks during the event

Five minutes a day for multi-day events; optional for one-day.

- `curl -fsS https://$APP_URL/health` returns 200 `{"status":"ok",...}`. `503` means `db` or `signingKey` failed (see setup step 6).
- Activity in the last day is non-zero (`created_at` is epoch ms):
  `sqlite3 $DATABASE_PATH "SELECT count(*) FROM audit_log WHERE created_at > (unixepoch('now','-1 day')*1000);"`
- Scan logs for errors:
  - **Docker:** `docker logs -f --since 1h <container>` (or `docker compose logs -f`)
  - **Railway:** `railway logs`, or the Logs tab
  - **Render:** Logs tab, or `render logs` with the CLI linked
  - **Fly.io:** `fly logs`
- Check `/admin/insights.csv` (or `/admin`) for failed-magic-link spikes.

---

## Backup procedure

State is the SQLite file at `config.databasePath` (`$DATABASE_PATH`: `./data/app.db` locally, `/data/app.db` in Docker), plus `app.db-wal` and `app.db-shm` while running.

### Take a backup

Use `scripts/backup.mjs`: `VACUUM INTO` snapshot (safe while running, no `sqlite3` binary), `PRAGMA integrity_check` on the copy, prunes old snapshots.

```bash
node scripts/backup.mjs
# writes backups/app-<UTC timestamp>.db, prints its size once verified
```

- Env: `DATABASE_PATH` (source), `BACKUP_DIR` (default `./backups`), `RETENTION_DAYS` (default 30, `0` disables pruning).
- Exit `0` = written and verified, `1` = failed. Check the exit code, not the file.

Without Node, using the `sqlite3` CLI:

```bash
sqlite3 $DATABASE_PATH ".backup './backups/app-$(date -u +%Y%m%dT%H%M%SZ).db'"
```

Docker volume tarball:

```bash
docker run --rm -v rideshare-data:/data -v $PWD:/out alpine \
  tar czf /out/backup.tgz /data
```

Move backups off-host to encrypted storage. Never commit them.

Snapshots hold attendee emails (`users`, `magic_links`, `audit_log`), **not** the key at `DEPLOYMENT_KEY_PATH` (see [Deployment key rotation](#deployment-key-rotation)).

### Restore a backup

Stop, replace the file, restart:

```bash
# Docker
docker compose stop
cp backups/app-<timestamp>.db data/app.db
rm -f data/app.db-wal data/app.db-shm   # stale WAL/SHM from the old file, if present
docker compose up -d

# Railway / Render / Fly.io: upload the backup file into the attached volume
# (via their own volume/SFTP/CLI tooling), then restart or redeploy the service
# from that platform's dashboard or CLI.
```

### Verify integrity after restore

No hash-chain verifier yet (planned v2, `docs/security/audit-tampering.md`). Structural check only:

```bash
sqlite3 data/app.db "PRAGMA integrity_check;"            # expect: ok
sqlite3 data/app.db "SELECT count(*) FROM audit_log;"    # cross-check against your pre-restore count
```

### Backup cadence

- Hourly during the event (cron `node scripts/backup.mjs` or a platform scheduled job).
- One end-of-day archive, off-host, encrypted.
- Delete all backups within 30 days of the [Post-event wipe](#post-event-wipe) (default `RETENTION_DAYS=30` prunes; delete `backups/` at wipe).

---

## Common incidents

### Magic-link emails not sending

**Symptom:** no email arrives; `/admin/insights.csv` shows issuance OK but no delivery confirmations.

**Triage:**

1. Grep logs for `mail` (log commands under [Daily checks](#daily-checks-during-the-event)).
2. Look for 4xx/5xx from the mail provider.
3. Check provider quota (Resend dashboard or SMTP status page).
4. Confirm SPF and DKIM on the `EMAIL_FROM` domain. Providers often drop misconfigured senders silently.
5. Test egress: `curl -v https://api.resend.com`.
6. Provider down: switch `RESEND_API_KEY` or `SMTP_*` in the platform env UI and restart.

**Remediation:**

- Outage: post an `info`/`warning` banner at `/admin/banner` so people wait instead of hitting the rate limit.
- Misconfiguration: fix it, then delete unused links older than 15 minutes (`created_at` is epoch ms):
  ```bash
  sqlite3 $DATABASE_PATH "DELETE FROM magic_links WHERE used_at IS NULL AND created_at < (unixepoch()*1000 - 900000);"
  ```

### User can't sign in

**Symptom:** one attendee gets no link, mail is otherwise fine.

1. Check the allowlist: `/admin/allowlist`, "check a single email" form (rate-limited, audited as an `allowlist.check`-style entry).
2. Not listed: add them in **Append** mode, then have them resubmit. There is no admin "send link" action.
3. Listed: likely rate-limited (`MAGIC_LINK_RATE_LIMIT`, default 5/hour per email; 30/hour per IP, hardcoded). Limits live in an in-memory `Map`. Wait, or restart (clears **every** bucket for everyone). Prefer waiting.
4. Ask them to check spam and corporate quarantine.

### Admin lockout

**Symptom:** the only admin can't receive email.

Admin status is `ADMIN_EMAILS`, checked per request; no DB-side escalation path. The address must also be on the allowlist ([setup step 4](#4-bootstrap-the-admin-allowlist)).

1. Add the new admin to `ADMIN_EMAILS` in the platform env UI and restart.
2. Make sure they're on the allowlist: run the [step 4](#4-bootstrap-the-admin-allowlist) import, or use `/admin/allowlist` if another admin has access.
3. New admin signs in via magic link.

If no admin can get email at all, see [Magic-link emails not sending](#magic-link-emails-not-sending).

### DB corruption

**Symptom:** `PRAGMA integrity_check;` returns anything but `ok`, or logs show `SQLITE_CORRUPT`.

1. Stop the instance (see [Restore a backup](#restore-a-backup)).
2. Move it aside: `mv data/app.db data/app.db.corrupt-$(date +%s)` (plus `-wal`/`-shm`).
3. Restore the latest backup ([Restore a backup](#restore-a-backup)).
4. Run `PRAGMA integrity_check;` and the `audit_log` row-count cross-check (no hash-chain verifier; see [Backup procedure](#backup-procedure)).
5. Restart.
6. **Communicate.** Sign-ups and DID bindings since the backup are lost (only in `audit_log` and `user_dids`) and indistinguishable from new users. Post the cutoff time via `/admin/banner`.

### Deployment key rotation

**Destructive, with no transition window.** Known limitation.

- One Ed25519 key, in the file at `DEPLOYMENT_KEY_PATH` (default `secrets/deployment.key`, mode 0600, created on first boot by `lib/keys.js`).
- `/.well-known/did.json` (`getDeploymentDidDocument()` in `lib/trust.js`) publishes one verification method, so old and new keys can't both verify.
- Replacing the key permanently invalidates every credential ever issued. No rollback.

Upgrades keep the key: `lib/keys.js` moves it from `signing_keys` to the file; the DID is unchanged. If the write fails it aborts with the DB untouched; fix the path and restart.

Only on confirmed key compromise:

1. Stop the instance.
2. Delete the key file **and** the identity row: `DELETE FROM deployment_identity WHERE id = 1`. Leaving the row makes the server refuse to start with a mismatched key.
3. Restart. A new keypair is generated and `/.well-known/did.json` republishes.

### The key is not in the backup

`scripts/backup.mjs` copies only the SQLite file (warns if a pre-migration key row remains). Back up the key file separately, encrypted (age, KMS, or platform secret store), and restore it with the DB.

At end of event don't rotate; do the [Post-event wipe](#post-event-wipe).

### SSL cert renewal

The app doesn't do TLS; your proxy or platform does.

- **Docker behind your own proxy:** Caddy auto-renews; nginx + certbot needs a renewal cron. Note which you use.
- **Railway / Render / Fly.io:** automatic for platform domains. For a custom domain, check cert status in the dashboard once.
- **Cloudflare in front:** automatic; watch the origin cert if you also terminate TLS at origin.

---

## Monitoring

| Metric | Source | Alert when |
| --- | --- | --- |
| Failed magic-link issuance | `audit_log` `action` values | sudden spike (check provider) |
| Link latency (issue → use) | `magic_links.used_at - created_at` | p95 stays high (provider degraded) |
| Credential issuance failures | logs, trust/credential errors | any |
| `/health` | external probe | 2 consecutive `503`s: page operator |
| Process restarts | platform metric | > 1/hour |
| DB file size | `du -h $DATABASE_PATH` | > 100MB/day growth |
| Rate-limiter buckets | log `[rate-limit] bucket count=N`, every 5 min | sustained growth, no cleanup drop (scanning/abuse) |

- Limiter (`lib/rate-limit.js`): in-memory `Map`, no `rate_limits` table. The log line is the only visibility; restart the only reset.
- Audit table is `audit_log` (not `audit`).
- Minimum: uptime check on `/health` plus platform logs.

---

## Post-event wipe

**Mandatory** privacy commitment. Within 30 days of the event; sooner is better.

Destroy the SQLite file at `$DATABASE_PATH`, its WAL/SHM files, and all backups.

### Self-hosted (Docker on your own VM, or anywhere you hold the filesystem)

```bash
# 1. Stop the service
docker compose down

# 2. Wipe the DB and its WAL/SHM siblings
shred -u data/app.db data/app.db-wal data/app.db-shm

# 3. Wipe backups
find backups -type f -name 'app-*.db' -exec shred -u {} \;
rmdir backups 2>/dev/null

# 4. Rotate or revoke the mail-provider API key
#    so a leaked .env elsewhere can't replay messages.

# 5. Tell attendees you're done.
```

For a named volume (not a bind mount), also run `docker volume rm rideshare-data`.

### Platform-managed (Railway / Render / Fly.io)

No filesystem to `shred`. Delete the **volume** and the **service** via the platform (e.g. `fly volumes destroy`, or Railway/Render delete-volume and delete-service). Delete the volume explicitly; it can outlive the service.

Either way, if you still have filesystem access, this should print nothing:

```bash
# Verify nothing remains, if you still have filesystem access:
find . -name 'app.db*' 2>/dev/null
```

---

## Migrations

`lib/db.js` bootstraps the schema on start with one `db.exec()` of `CREATE TABLE IF NOT EXISTS`. No migrations directory or runner. Additive changes go inline via `tryExec()`:

```js
tryExec("ALTER TABLE rides ADD COLUMN pickup_lat REAL");
```

`tryExec()` ignores "duplicate column" / "already exists" and rethrows the rest, so reruns are no-ops.

Non-additive changes (rename, drop, type change) have no tooling. By hand:

1. Back up (`node scripts/backup.mjs`).
2. Stop the server.
3. Apply in a transaction, following the inline style in `lib/db.js` (no separate script):
   ```sql
   BEGIN;
   ALTER TABLE rides RENAME TO rides_v1;
   CREATE TABLE rides ( ... );
   INSERT INTO rides SELECT ... FROM rides_v1;
   DROP TABLE rides_v1;
   COMMIT;
   ```
4. Run `PRAGMA integrity_check;`.
5. Restart.

No migration framework, on purpose: changes stay short and reviewable in the diff.

---

## Updating the deployment

> **One-time, when upgrading past the release that untracked `event.config.yaml`.**
> `git pull` deletes an unmodified tracked copy. The app then falls back to
> `event.config.example.yaml` and serves placeholder text. Save it first:
>
> ```bash
> cp event.config.yaml /tmp/event.config.yaml.keep   # before the pull
> git pull
> cp /tmp/event.config.yaml.keep event.config.yaml   # after
> ```
>
> After that it's gitignored.

Additive update (no schema break, no new required env vars):

```bash
# Docker
git pull
docker compose build
docker compose up -d
curl -fsS $APP_URL/health

# Railway / Render
git push   # if deploying from a connected repo, this triggers a redeploy automatically
# otherwise use each platform's own redeploy action in its dashboard/CLI

# Fly.io
fly deploy
```

Run `npm test` locally first.

- **Schema changes:** back up, then see [Migrations](#migrations). Usually the new `tryExec()` ships in the same deploy and applies at boot.
- **New env vars:** set them in the platform UI before the deploy that needs them. Note it in your event's local notes for the next operator.

---

## See also

- [`SECURITY.md`](SECURITY.md): disclosure policy, defense layers.
- [`THREAT_MODEL.md`](THREAT_MODEL.md): what we model.
- [`TRUST.md`](TRUST.md): DID + VC architecture.
- [`BUILD.md`](BUILD.md): reproducible-build verification.
- [`CONTRIBUTING.md`](CONTRIBUTING.md): for operators patching in their own changes.
