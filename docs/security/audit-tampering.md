# Audit tampering

Audit-log integrity in **rideshare** today, and the planned hash chain.

---

## What we record

Privileged and state-changing actions write one row to `audit_log`:

| Column | Contents |
|---|---|
| `id` | autoincrement |
| `created_at` | epoch milliseconds |
| `actor_id` | user id; `null` for system actions and after the user is deleted |
| `actor_email` | denormalized so a deleted user's actions stay attributable |
| `action` | e.g. `ride.create`, `allowlist.check`, `admin.banner.set` |
| `detail` | free text |
| `ip` | client address as the router resolved it |

No `payload_hash`, no `actor_did`; rows are not hashed.

Schema and the single writer, `audit({...})`, are in `lib/db.js`. The writer logs and swallows failures so auditing can't break the action; under DB pressure a row can go missing.

---

## v1 state: mutable, with friction

In v0.3 the log is **mutable by an insider with DB write access**. Current friction:

1. **File permissions.** `DATABASE_PATH` (default `data/app.db`) is owned by the service user (unprivileged `app` in the container).
2. **`BEFORE UPDATE` / `BEFORE DELETE` triggers** on `audit_log` that `RAISE(ABORT, 'audit_log is append-only')` (`lib/db.js`, tested in `tests/unit/audit-append-only.test.js`). The UPDATE trigger covers content columns only, so user deletion can still NULL `actor_id`. Stops buggy handlers, not an attacker with SQL access (`DROP TRIGGER`).
3. **Single writer.** Code review rejects direct SQL against the table.
4. **Hourly backups.** One-hour tampering window, if backups go off-host to write-once storage.

Not protected against:

- A compromised host (root can stop, edit, restart). See [`THREAT_MODEL.md`](../../THREAT_MODEL.md) residual risks.
- An insider with DB write, or a targeted edit the next backup captures.

v1 credential authenticity depends on this log ([`credential-forgery.md`](credential-forgery.md)).

---

## Planned v2: hash chain

Tracked for v0.4. Two new columns:

- `prev_hash`: previous row's `row_hash`, or zero for row 1.
- `row_hash`: `SHA-256(prev_hash || canonical(everything else in this row))`.

Re-walking from row 1 verifies the chain; an edit breaks it from that row on.

### Verifier tool

Not written yet. Would report `ok` or `break at row N` with context. Run after every restore and on a cron during the event.

### Public head publication

Tamper-evidence needs the head witnessed outside operator control:

- Hourly, sign the latest `row_hash` with the Ed25519 key and publish `(rowid, row_hash, signature, timestamp)` externally (another hostname, a transparency log, a social post).
- Rewriting history then means forging signatures over old heads (a compromised host has the key) or published heads diverging from the re-verified chain, which reviewers can cross-check.

Ships v0.4 / v0.5; documented now to fix the design.

### What the hash chain still cannot do

- Stop a compromised host rewriting history and republishing heads once observers stop checking. Fix: a log the deployment can't rewrite (e.g. Sigstore-backed), v0.5.
- Detect a mutation that was never audited. Fix: code review of all mutation paths.
- Help a verifier who never saw an early head: it proves only "no change since the head you trust."

---

## What relying parties should do today (v0.3)

- Treat audit-derived claims (e.g. "issued at time T") as **operator-attested**, not tamper-evident.
- For more, ask the operator to sign and publish audit snapshots at event start, end of day and post-event.
- Across deployments, prefer v0.4+ once it ships.

---

## Where to look

- `lib/db.js`: table definition, append-only triggers, `audit()`.
- `routes/admin.js`: the read-only `/admin/audit` viewer.

---

## See also

- [`THREAT_MODEL.md`](../../THREAT_MODEL.md): Asset A6, `CC-2: tampered audit log`, residual risk #3.
- [`credential-forgery.md`](credential-forgery.md): why audit integrity matters for credentials.
- [`RUNBOOK.md`](../../RUNBOOK.md): backup, restore, post-restore integrity check.
