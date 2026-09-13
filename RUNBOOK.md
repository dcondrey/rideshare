# Runbook

> Operational playbook for an operator deploying the **rideshare** webapp at an event. Audience: the human running the deployment, before, during, and after the event.

This is a *short-lived* deployment by design. The runbook reflects that — first-time setup is heavy, day-to-day operation is light, and the post-event wipe is mandatory.

If you are responding to a security incident, also read [`SECURITY.md`](SECURITY.md) and [`THREAT_MODEL.md`](THREAT_MODEL.md).

**Single-instance only.** SQLite plus the in-memory rate limiter mean this app cannot run as more than one replica (see [Limitations in the README](README.md#limitations)). Don't put it behind a load balancer fanning out to multiple containers/dynos/instances — a second instance gets its own empty rate-limit table and, if it isn't pointed at the exact same SQLite file, its own empty database. One instance is enough for event scale (a few thousand users); this is a constraint to plan around, not a bug to work around.

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

Do this once per event, ideally a week before doors open. Full platform-by-platform steps (Docker, Railway, Render, Fly.io) are in [README.md > Deploy](README.md#deploy) — this section is the critical path distilled, plus the two steps the README doesn't cover (allowlist bootstrap, and verifying the deployment identity came up).

### 1. Pick a platform and deploy

Follow [README.md > Deploy](README.md#deploy) for your target:

- **Docker:** `cp .env.example .env` (fill it in), `docker compose up -d`. SQLite lives in the `rideshare-data` named volume.
- **Railway:** one-click template, set env vars in the Railway UI, attach a Volume at `/data`.
- **Render:** **New > Blueprint** against this repo; `render.yaml` provisions the service and a 1GB disk.
- **Fly.io:** `fly launch`, `fly volumes create data`, `fly secrets set ...`, `fly deploy`.

There is **no** `npm install` step — the app has zero runtime npm dependencies. Node ≥ 22.5 is required (`engines.node` in `package.json`); the app uses `node:sqlite`, stabilizing in that release.

### 2. Set the required environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `APP_URL` | Yes | — | Public URL the app is served from. Also becomes the deployment's `did:web:<host>` identity — get this right before first boot, since the DID is derived from it. |
| `SESSION_SECRET` | Yes | — | 32+ random hex bytes. Signs sessions and magic-link tokens. |
| `ALLOWLIST_SALT` | Yes | — | 32+ random hex bytes. HMAC key for attendee email hashing. |
| `ADMIN_EMAILS` | Yes | — | Comma-separated admin addresses. See step 4 below — this alone does not let an admin sign in. |
| `EMAIL_FROM` | Yes | — | RFC 5322 sender, e.g. `"Rideshare <noreply@x.com>"`. |
| `RESEND_API_KEY` | one of | — | Recommended mail transport. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` | one of | — | Bring-your-own SMTP, if not using Resend. |
| `SMTP_ALLOW_PLAINTEXT` | no | `false` | Only for a local relay with no TLS. When `SMTP_SECURE=false`, STARTTLS is required and a server that does not offer it is refused; this waives that. |
| `PORT` | no | `3000` | |
| `DATABASE_PATH` | no | `./data/app.db` (`/data/app.db` in the Docker volume) | SQLite file location. |
| `TRUST_PROXY` | no | `false` | Set `true` behind any reverse proxy / platform edge (Railway, Render, Fly all need this). The client address comes from the last `X-Forwarded-For` hop, which assumes one proxy in front. Left `false` behind a proxy, every visitor shares one per-IP rate-limit bucket — the server warns once when it first sees the header. |
| `MAGIC_LINK_RATE_LIMIT` | no | `5` | Max sign-in emails per address per hour (in-memory; see the single-instance warning above). |
| `SESSION_LIFETIME_DAYS` | no | `14` | Session cookie lifetime. |

`config.js` exits at boot with a clear error naming the first missing required var — if the process won't start, check its stderr before anything else.

### 3. Fill in `event.config.yaml`

```bash
cp event.config.example.yaml event.config.yaml
```

The example is the tracked file; your copy is gitignored, so configuring an event does not leave a dirty working tree and an upgrade cannot conflict on it. If `event.config.yaml` is absent the app boots from the example and warns on every start — which means placeholder text like "Your Event" is reaching attendees.

The config is validated at boot. A missing, misspelled or malformed field stops the process and names every problem at once, by path, rather than failing later inside a page render.

Event name, dates, venues, airports, default map style, meetup pins. This is the public-facing config — attendees can read it as part of the source-readability promise. Most fields are also editable live via `/admin/config` without a restart. Full schema and example: [README.md > Configuration](README.md#configuration).

### 4. Bootstrap the admin allowlist (required, not covered by `ADMIN_EMAILS` alone)

`ADMIN_EMAILS` only controls what `/admin` *authorizes once signed in*. Signing in at all still requires being on the attendee allowlist (`lib/auth.js` checks `isAllowed(email)` before issuing a magic link, with no admin bypass). On a brand-new deployment the allowlist is empty, so the admin can't receive their own first link, and there is no admin UI yet to fix that — because reaching it requires already being signed in.

Import from the repo root, after `.env` is in place and the process has a database at `DATABASE_PATH`. A one-line CSV is enough to break the deadlock:

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

This is the same import path as the `/admin/allowlist` UI (`lib/allowlist.js#importAllowlistCsv`): the address is normalized and only its HMAC is stored (`ALLOWLIST_SALT`-keyed, via `lib/crypto.js`), never the raw email, and an `allowlist.append` row goes to `audit_log`. Add every address in `ADMIN_EMAILS` in one file. After this, each admin signs in normally and the web UI is sufficient from then on.

Delete the CSV afterwards — it is a plaintext list of addresses, and nothing reads it again.

### 5. Import the attendee allowlist

Three ways in, all the same code path and all storing only HMACs:

| | When to use it |
|---|---|
| `npm run allowlist:import -- list.csv` | Bulk load from a terminal or a deploy script. Re-runnable; `--append` adds without clearing. Default is replace, matching the admin form. |
| `allowlist.csv` in the project root | Seeded automatically on first boot, and only when the allowlist is empty — so it cannot undo later admin edits. Convenient for a bare-metal deploy; the file is gitignored. **Not available in Docker**: `.dockerignore` excludes `allowlist*` and `*.csv` so attendee addresses are never baked into an image. Use the CLI against the running container instead. |
| `/admin/allowlist` | Sign in as admin, paste or upload a CSV, choose **Replace** or **Append**. |

The CSV is a single email column, or any multi-column file with an `email` header. Invalid rows are counted and skipped rather than failing the import. Details: [README.md > Importing attendees](README.md#importing-attendees).

### 6. Confirm the deployment identity came up

The deployment generates its own Ed25519 signing key on first boot and derives a `did:web:<host-of-APP_URL>` identity from it. The private key is a file at `DEPLOYMENT_KEY_PATH`, outside the database, so it is not in a `npm run backup` dump — back it up separately. (An older release kept it in the `signing_keys` table; `lib/keys.js` migrates that row out to the file on first boot and clears it.) Verify both the health check and the DID document:

```bash
curl -fsS https://$APP_URL/health | jq .
# { "status": "ok", "checks": { "db": true, "signingKey": true } }

curl -fsS https://$APP_URL/.well-known/did.json | jq .
```

If `signingKey` is `false` or the DID document 500s, the keypair failed to generate or load — check logs for `[trust]` and `[keys]` lines and confirm the DB and the key path are writable.

**Changing `APP_URL` after first boot is a breaking change and the server now refuses to start.** The DID is pinned into the key file when the key is generated, so a deployment that moves host would otherwise keep issuing credentials whose `iss` document lives at the old address — unverifiable at every other deployment, with no error visible locally. Startup fails naming both the stored DID and the one `APP_URL` implies. To move host deliberately, adopt a new identity: move the key file aside and clear the `deployment_identity` row. Credentials issued under the old DID stay verifiable only for as long as the old host serves its `/.well-known/did.json`.

### 7. Smoke-test

```bash
npm test                                       # all tests pass (per CLAUDE.md toolchain)
curl -fsS https://$APP_URL/health              # { "status": "ok", ... }
```

---

## Daily checks during the event

Five minutes a day. Skipping these is fine for a one-day event; do them daily for a multi-day one.

- `curl -fsS https://$APP_URL/health` returns `{"status":"ok",...}` (200). A `503` means `db` or `signingKey` failed — see the check above.
- `sqlite3 $DATABASE_PATH "SELECT count(*) FROM audit_log WHERE created_at > (unixepoch('now','-1 day')*1000);"` is non-zero (people are using it). `audit_log.created_at` is stored as epoch-milliseconds, not a SQLite datetime string.
- Tail logs for error-level lines — command depends on platform:
  - **Docker:** `docker logs -f --since 1h <container>` (or `docker compose logs -f`).
  - **Railway:** `railway logs`, or the Logs tab in the dashboard.
  - **Render:** the service's Logs tab, or `render logs` if you have the CLI linked.
  - **Fly.io:** `fly logs`.
- Glance at `/admin/insights.csv` (or the `/admin` dashboard) for failed-magic-link rate spikes.

---

## Backup procedure

The only stateful artifact is the SQLite file at `config.databasePath` — `$DATABASE_PATH`, defaulting to `./data/app.db` locally or `/data/app.db` inside the Docker volume — plus its WAL/SHM siblings (`app.db-wal`, `app.db-shm`) while the server is running.

### Take a backup

The repo ships `scripts/backup.mjs`, which is the maintained way to do this: it uses SQLite's `VACUUM INTO` for a consistent online snapshot (no `sqlite3` binary dependency, safe with the server running), verifies the copy with `PRAGMA integrity_check`, and prunes old snapshots.

```bash
node scripts/backup.mjs
# writes backups/app-<UTC timestamp>.db, prints its size once verified
```

Environment overrides: `DATABASE_PATH` (source, same var the app itself reads), `BACKUP_DIR` (default `./backups`), `RETENTION_DAYS` (default 30, `0` disables pruning). Exit code `0` means written and verified; `1` means the backup failed outright (don't trust a `0`-byte or missing output file as success — check the exit code).

If you'd rather not run the script (e.g. a quick one-off on a host without Node handy but with the `sqlite3` CLI):

```bash
sqlite3 $DATABASE_PATH ".backup './backups/app-$(date -u +%Y%m%dT%H%M%SZ).db'"
```

For Docker volumes specifically, a filesystem-level tar of the volume also works:

```bash
docker run --rm -v rideshare-data:/data -v $PWD:/out alpine \
  tar czf /out/backup.tgz /data
```

Move backups off-host to encrypted storage. Do **not** commit them to git.

A snapshot holds attendee email addresses (`users`, `magic_links`, `audit_log`) but **not** the deployment signing key, which lives in the file at `DEPLOYMENT_KEY_PATH` — see [Deployment key rotation](#deployment-key-rotation) for how to back that up separately.

### Restore a backup

Stop the running instance, replace the live file with the backup, restart — command depends on platform:

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

There is no hash-chain audit verifier yet — `docs/security/audit-tampering.md` describes one as a planned v2, not something that exists today. The real, current check is structural only:

```bash
sqlite3 data/app.db "PRAGMA integrity_check;"            # expect: ok
sqlite3 data/app.db "SELECT count(*) FROM audit_log;"    # cross-check against your pre-restore count
```

`scripts/backup.mjs` already runs `PRAGMA integrity_check` on the snapshot at backup time, so a backup it wrote and verified is trustworthy going in — this step is about confirming the *restored* file matches, not re-litigating the backup.

### Backup cadence

- Hourly during the event (cron `node scripts/backup.mjs`, or your platform's own scheduled-job feature).
- One archival backup at end-of-day, moved off-host to encrypted storage.
- Wipe all backups within 30 days of the post-event wipe (see [Post-event wipe](#post-event-wipe)) — or just leave `RETENTION_DAYS` at its default of 30 and let the script prune for you, then delete the `backups/` directory itself at wipe time.

---

## Common incidents

### Magic-link emails not sending

**Symptom:** attendees report no email after submitting their address; `/admin/insights.csv` shows magic-link issuance OK but delivery confirmations missing.

**Triage steps:**

1. Tail logs for `mail` (see [Daily checks](#daily-checks-during-the-event) for the per-platform log command) — `grep -i mail`.
2. Look for HTTP 4xx/5xx from the mail provider in those logs.
3. Check provider quota (Resend dashboard, or your SMTP provider's status page).
4. Confirm the `EMAIL_FROM` domain has SPF + DKIM configured. Many providers silently drop misconfigured senders.
5. Verify outbound connectivity from the instance, e.g. `curl -v https://api.resend.com`.
6. If the provider itself is down, switch credentials (`RESEND_API_KEY` or the `SMTP_*` vars) in your platform's env var UI and restart/redeploy.

**Remediation:**

- If it's a provider outage, post a notice via `/admin/banner` (site-wide banner, `info`/`warning` severity) so attendees know to wait, rather than retrying and hitting the rate limit.
- If it was misconfiguration, fix it, then clear the stale unused links so nobody uses one you've since fixed the cause of:
  ```bash
  sqlite3 $DATABASE_PATH "DELETE FROM magic_links WHERE used_at IS NULL AND created_at < (unixepoch()*1000 - 900000);"
  ```
  (`created_at`/`expires_at` are epoch-milliseconds; the above is "older than 15 minutes.")

### User can't sign in

**Symptom:** an attendee says they entered their email and never received a link, *and* the mail system is fine.

**Triage steps:**

1. Confirm they're on the allowlist: sign in as admin, go to `/admin/allowlist`, use the "check a single email" form (rate-limited and audited — logs an `allowlist.check` style entry either way).
2. If not on it: add them via `/admin/allowlist` (Append mode so you don't wipe everyone else), then have them retry sign-in themselves. There is no admin-triggered "send them a link" or "issue a one-time link" action — the attendee has to submit their own email again once they're allowed.
3. If they are on it: they're likely rate-limited (`MAGIC_LINK_RATE_LIMIT`, default 5/hour per email, plus a hardcoded 30/hour per IP). Rate-limit state is an in-memory `Map` inside the running process — there's no table to query or a targeted row to delete. Your options are: wait out the window, or restart the process, which clears **every** bucket for **every** user, not just this one. Prefer waiting unless the event is actively blocked on it.
4. Ask them to check spam, including any corporate quarantine.

### Admin lockout

**Symptom:** the only admin email is unreachable (e.g. their company SSO is broken and they can't get email).

**Recovery:**

Admin status comes from the `ADMIN_EMAILS` env var, checked at request time — there's no DB-side privilege escalation route. But being in `ADMIN_EMAILS` is not sufficient to sign in; the address must also be on the attendee allowlist (see [step 4 of First-time setup](#4-bootstrap-the-admin-allowlist-required-not-covered-by-admin_emails-alone)).

1. Add the new admin's email to `ADMIN_EMAILS` in your platform's env var UI, and restart/redeploy.
2. Confirm that email is also on the allowlist — if not, run the same `appendAllowlist` one-liner from [step 4 above](#4-bootstrap-the-admin-allowlist-required-not-covered-by-admin_emails-alone), or add it via `/admin/allowlist` if another admin still has access.
3. The new admin signs in via the normal magic-link flow.

If no admin can receive email at all, you have a mail-delivery incident, not an admin-lockout one — see [Magic-link emails not sending](#magic-link-emails-not-sending).

### DB corruption

**Symptom:** `PRAGMA integrity_check;` returns anything other than `ok`, or logs show `SQLITE_CORRUPT`.

**Recovery:**

1. Stop the instance (platform-specific — see [Restore a backup](#restore-a-backup)).
2. Move the corrupt file aside: `mv data/app.db data/app.db.corrupt-$(date +%s)` (and its `-wal`/`-shm` siblings).
3. Restore the most recent backup (see [Restore a backup](#restore-a-backup)).
4. Run `PRAGMA integrity_check;` plus the `audit_log` row-count cross-check — there's no hash-chain verifier yet (see [Backup procedure](#backup-procedure)).
5. Restart/redeploy.
6. **Communicate.** Anyone who signed up or bound a DID between the backup and the corruption is gone from the restored DB — the only record of that binding was in `audit_log` and `user_dids`, and you can't distinguish "new attendee" from "lost attendee" after the fact. Post the cutoff time via `/admin/banner`.

### Deployment key rotation

**Rotation is destructive and there is no transition window.** Treat this as a known limitation, not a to-do.

The deployment has exactly one Ed25519 signing key, held in the file named by `DEPLOYMENT_KEY_PATH` (default `secrets/deployment.key`, mode 0600, created on first boot — `lib/keys.js`). The `/.well-known/did.json` document (`getDeploymentDidDocument()` in `lib/trust.js`) publishes exactly one verification method for it, so there is no way to publish an old key alongside a new one while both remain verifiable.

Consequence: replacing the key makes every Verifiable Credential this deployment has ever issued permanently unverifiable, with no rollback. Anyone holding a credential from before the rotation loses it for good.

A deployment upgraded from an older version keeps its original key: on first boot `lib/keys.js` moves the row out of the `signing_keys` table into the key file and deletes it from the database. Nothing is re-generated, and the published DID does not change. If that migration cannot write the file it aborts and leaves the database untouched, so a failed upgrade is recoverable by fixing the path and restarting.

If you are facing an actual key-compromise scenario and decide rotation is still the lesser evil:

1. Stop the instance.
2. Delete the key file **and** the `deployment_identity` row (`DELETE FROM deployment_identity WHERE id = 1`). The row is the integrity check: leaving it in place makes the server refuse to start with a key that does not match the one it published.
3. Restart. A new keypair is generated and `/.well-known/did.json` republishes with the new public key.

Every previously issued credential becomes unverifiable the moment you do this — there is no "both keys valid" transition available.

### The key is not in the backup

`scripts/backup.mjs` copies the SQLite file only, so a snapshot carries no issuer key material; it prints a warning if it finds a pre-migration key row still in the database. That means a restore alone does not restore the ability to sign: back the key file up separately, encrypted (age, KMS, or your platform's secret store), and restore it alongside the database.

Recommendation: don't, outside of confirmed key compromise. For a routine end-of-event situation, just proceed to [Post-event wipe](#post-event-wipe) instead — the key dies with the database.

### SSL cert renewal

The app does not handle TLS. Cert renewal is your edge proxy's or platform's job.

- **Docker, fronted by your own proxy:** Caddy auto-renews; nginx with certbot needs a renewal cron; document which one you're using.
- **Railway / Render / Fly.io:** TLS for the platform-provided domain is automatic and managed by the platform. If you've attached a custom domain, each platform's dashboard shows the cert status — check it once, then it's generally set-and-forget.
- **Cloudflare in front of any of the above:** automatic; just monitor the origin cert if you're also terminating TLS at origin.

---

## Monitoring

Per-metric, what to watch and what's abnormal:

| Metric | Source | Alert threshold |
| --- | --- | --- |
| Failed magic-link issuance rate | `audit_log` table, relevant `action` values | sudden spike → investigate provider |
| Magic-link delivery latency (issue → use) | `magic_links.used_at - created_at` | p95 consistently high → mail provider degraded |
| Credential issuance failures | logs, trust/credential errors | any → investigate immediately |
| `/health` failure | external probe | 2 consecutive `503`s → page operator |
| Process restarts | platform's own restart/crash metric | > 1/hour → investigate |
| DB file size | `du -h $DATABASE_PATH` | growth > 100MB/day → unusual; investigate |
| Rate-limiter bucket count | logs: `[rate-limit] bucket count=N`, emitted every 5 minutes | sustained growth without a cleanup drop → possible scanning/abuse |

**No SQL table to query for rate limiting.** The limiter (`lib/rate-limit.js`) is an in-memory `Map`, single-process, with no `rate_limits` table — the bucket-count log line above is the only visibility into it, and the only reset is a full process restart (see [User can't sign in](#user-cant-sign-in)). This is also the single-instance constraint called out at the top of this runbook: a second replica would get its own, separate rate-limit state.

The audit trail lives in the `audit_log` table (not `audit`).

Minimal monitoring stack: a cron or uptime service hitting `/health`, plus whatever log aggregation your platform offers. For one-day events a phone alarm checking `/health` is fine.

---

## Post-event wipe

**Mandatory.** This is a privacy commitment to attendees, not a suggestion.

Run within 30 days of the event ending. Sooner is better.

The only real artifact to destroy is the SQLite file at `$DATABASE_PATH` and its WAL/SHM siblings, plus any backups you've taken.

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

If the volume is a named Docker volume rather than a bind mount, remove the volume itself after wiping its contents: `docker volume rm rideshare-data`.

### Platform-managed (Railway / Render / Fly.io)

These platforms manage the underlying disk for you — there is no filesystem to `shred`. Wiping means deleting the **volume** and the **service** through that platform's own dashboard or CLI (e.g. `fly volumes destroy`, or the Railway/Render dashboard's delete-volume and delete-service actions). Do this rather than trying to reach the disk directly; the managed volume may outlive a deleted service otherwise.

In both cases:

```bash
# Verify nothing remains, if you still have filesystem access:
find . -name 'app.db*' 2>/dev/null
```

Should print nothing once the volume/service is actually gone.

---

## Migrations

The schema is bootstrapped on first start by `lib/db.js`: a single `db.exec()` block with `CREATE TABLE IF NOT EXISTS` for every table. There is no separate migrations directory or script runner — additive schema changes live inline in `lib/db.js`, wrapped through `tryExec()`:

```js
tryExec("ALTER TABLE rides ADD COLUMN pickup_lat REAL");
```

`tryExec()` swallows "duplicate column" / "already exists" errors so the same `ALTER` is safe to run again on an already-migrated DB, and rethrows anything else. This is how new columns get added without a migration framework: the block runs on every boot, and is a no-op past the first time.

For non-additive changes (rename, drop, type change) there is no tooling at all today — this pattern only covers additive changes. If you ever need one:

1. Take a backup (`node scripts/backup.mjs`).
2. Stop the server.
3. Apply it by hand, inside a transaction, following the existing inline style in `lib/db.js` rather than adding a separate script:
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

We deliberately avoid an ORM-style migration framework. Schema changes are short, hand-written, and reviewable in the diff that introduces them.

---

## Updating the deployment

> **One-time, when upgrading across the release that untracked `event.config.yaml`.**
> That file used to be tracked. The commit removing it from the index will delete
> an unmodified copy on `git pull`. The app still boots — it falls back to
> `event.config.example.yaml` and warns — but it would serve placeholder text to
> attendees. Copy it aside first and put it back:
>
> ```bash
> cp event.config.yaml /tmp/event.config.yaml.keep   # before the pull
> git pull
> cp /tmp/event.config.yaml.keep event.config.yaml   # after
> ```
>
> From then on it is gitignored and no pull touches it again.

For an additive update (no schema break, no new required env vars), per platform:

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

Run `npm test` locally before pushing/deploying either way.

For an update with schema changes: take a backup first, then follow [Migrations](#migrations) — in this codebase that almost always just means the new `tryExec()` block ships as part of the same deploy, since additive changes apply automatically at boot.

For an update with new env vars: set them in your platform's env var UI *before* the restart/redeploy that needs them, then deploy. Document the change in your event's local notes so the next operator knows.

---

## See also

- [`SECURITY.md`](SECURITY.md) — disclosure policy, defense layers.
- [`THREAT_MODEL.md`](THREAT_MODEL.md) — what we model.
- [`TRUST.md`](TRUST.md) — DID + VC architecture.
- [`BUILD.md`](BUILD.md) — reproducible-build verification.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — for operators who patch in their own changes.
