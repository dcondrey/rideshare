# Audit tampering

> Honest accounting of audit-log integrity in **rideshare** today, and the planned hash-chain upgrade. Audience: anyone whose threat model treats the audit log as evidence.

---

## What we record

Every privileged or state-mutating action writes one row to the `audit` table:

- `id` — autoincrementing.
- `created_at` — UTC timestamp.
- `actor_id` — session-derived attendee ID, or `null` for system actions.
- `actor_did` — the `did:key` bound to the actor, if known.
- `event_type` — short string, e.g. `signin.ok`, `ride.create`, `cred.issue`, `allowlist.add`, `admin.banner.set`.
- `payload_json` — JSON blob with event-specific fields (no raw secrets, no PII beyond what's necessary).
- `payload_hash` — SHA-256 of the canonicalised payload.

The schema lives in `lib/db.js`. The single writer is `audit({...})` in `lib/audit.js`. Code review forbids any other path to the table.

---

## v1 state — mutable, with friction

In v0.3, the audit log is **mutable for an insider with DB write access**. We acknowledge this and do not pretend otherwise.

What protects it today:

1. **Filesystem permissions.** `events.db` is mode `600`, owned by the `rideshare` service user. Only that user (and root) can write.
2. **`BEFORE UPDATE` and `BEFORE DELETE` triggers** on the `audit` table that `RAISE(ABORT, ...)`. An application path that tries to UPDATE or DELETE an audit row fails. This blocks accidental modification by a future buggy handler; it does NOT stop an attacker who can run arbitrary SQLite commands (they can `DROP TRIGGER` first).
3. **The audit table appends only via the central helper.** Code review checks for direct SQL against the table.
4. **Hourly backups.** A tampering window is bounded to the last hour, assuming backups go off-host to write-once storage.

What does NOT protect it:

- A compromised host. The attacker has root, can stop the service, edit the file, restart. No software defense helps here. See [`THREAT_MODEL.md`](../../THREAT_MODEL.md) residual risks.
- An insider with DB write. Same picture.
- A targeted modification within the backup interval that goes undetected if the next backup includes the modified state.

This is the load-bearing assumption behind v1 credential authenticity ([`credential-forgery.md`](credential-forgery.md)). If you cannot trust the audit log, you cannot trust "did the deployment really issue this credential?"

---

## Planned v2 — hash chain

Tracked for v0.4. The schema gains two columns:

- `prev_hash` — the `row_hash` of the previous row, or zero for row 1.
- `row_hash` — `SHA-256(prev_hash || canonical(everything else in this row))`.

On every insert, the writer computes `row_hash` from `prev_hash` and the row's content. The chain is verifiable by re-walking the table from row 1 and recomputing each hash; any modification breaks the chain at the modified row and every subsequent row.

### Verifier tool

`bin/audit-verify.js` walks the table and reports:

- `ok` — every row's `row_hash` matches the recomputed hash.
- `break at row N` — the modified row plus the upstream/downstream context.

Run after every restore. Run periodically as a cron during the event.

### Public head publication

For meaningful tamper-evidence (not just tamper-resistance), the chain head needs to be witnessed externally. Plan:

- Periodically (e.g. hourly), the deployment signs the current `row_hash` of the latest row with its Ed25519 key, and posts the `(rowid, row_hash, signature, timestamp)` tuple to a public location (a static endpoint on a separate hostname; or a transparency log; or as a tweet/toot — anywhere outside operator control).
- A retroactive modification of any row would require either:
  - Forging signatures over the old head (requires the deployment key — which a compromised host has),
  - Or acknowledging that all published heads from that point forward will diverge from a re-verified chain.
- A diligent reviewer can cross-check the deployment's claimed chain against the public heads.

This won't ship until v0.4 / v0.5. Documented now so the design is fixed.

### What the hash chain still cannot do

- Prevent a compromised host from re-writing history *and* re-publishing matching public heads, if the host had been doing the publishing for long enough that observers stopped checking. Mitigation: the public head publication should ideally be to a transparency log that the deployment cannot itself rewrite (e.g., a Sigstore-backed log). v0.5 target.
- Prevent the deployment from never writing a row in the first place ("we did this thing but didn't audit it"). Mitigation: code review of all mutation paths. Long-tail risk.
- Make the chain meaningful to a verifier who never saw an early head. The chain only proves "no modification since the head you trust." If you only see the chain at the end of the event, you are trusting the operator that the chain wasn't rewritten before you arrived.

---

## What relying parties should do today (v0.3)

- Treat audit-derived claims (e.g., "this credential was issued at time T") as **operator-attested**, not cryptographically tamper-evident.
- If you need stronger guarantees, request that the operator manually sign and publish a current snapshot of the audit table at meaningful checkpoints (event start, day end, post-event). The operator's signature plus the snapshot provides off-host evidence.
- If you are evaluating multiple deployments, prefer ones running v0.4+ once it ships.

---

## Where to look

- `lib/audit.js` — the central writer.
- `lib/db.js` — the table definition and triggers.
- `routes/admin/audit.js` — admin viewer; read-only.
- `bin/audit-verify.js` — once shipped, the chain verifier.

---

## See also

- [`THREAT_MODEL.md`](../../THREAT_MODEL.md) — Asset A6, plus the `CC-2: tampered audit log` cross-cutting threat and residual risk #3.
- [`credential-forgery.md`](credential-forgery.md) — why audit integrity matters for credential authenticity.
- [`RUNBOOK.md`](../../RUNBOOK.md) — backup and restore procedures, integrity check after restore.
