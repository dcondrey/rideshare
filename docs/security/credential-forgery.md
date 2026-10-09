# Credential forgery

Trust assumptions behind **rideshare** Verifiable Credentials in v1, and the planned upgrade.

---

## What we issue

A JWT (JWS) Verifiable Credential signed with the deployment's Ed25519 key, asserting one or more of:

- The subject DID participated in event X.
- The subject DID was on the allowlist.
- The subject DID held role Y (admin, organiser, volunteer).
- Cross-event: the subject DID held a credential from peer deployment Z.

Schema: [`TRUST.md`](../../TRUST.md). Credentials are bound to the subject's `did:key`; the holder proves control by signing a challenge, so copying the JWS doesn't transfer the claim.

---

## v1 model: unilateral signing

In v0.3 the deployment signs alone. So:

- A stolen key, or a malicious deployment, can mint backdated credentials about non-consenting subjects.
- Relying parties trust our whole operation: who held the key, what the issuance UI did, how it was reviewed.

Normal for issuer-authority credentials (a degree), but here the subject could co-sign. Decide whether that fits your threat model.

### What v1 *does* do well

- Issuance is audit-logged (subject DID, credential ID, claim summary, timestamp). Forgery needs an audit edit (possible for an insider, see [`audit-tampering.md`](audit-tampering.md)) or no audit trail, detectable by asking us.
- `did.json` publishes the key, fetched fresh per verification, so rotation is visible.
- `expirationDate` defaults to 90 days.
- Revocation list at `/.well-known/revocations.json`, signed by the same key. Revoked `id`s appear there; verifiers MUST check.

### What v1 *cannot* do

- Stop an insider with key access from forging a credential and omitting or editing the audit entry.
- Give non-repudiation against the deployment ("our signature, but unintended").
- Let a subject dispute a claim made about them.

---

## Planned v2 model: counter-signature

Tracked for v0.4. Issuance becomes two-party:

```
Deployment                           Subject (in browser)
    │                                       │
    │  1. propose claim payload  ────────►  │
    │                                       │
    │                                       │  2. holder reviews claim
    │                                       │     in UI; signs the
    │                                       │     payload with did:key
    │                                       │
    │  ◄────────────  3. holder signature   │
    │                                       │
    │  4. deployment signs the              │
    │     {payload, holderSig} bundle       │
    │     with did:web key                  │
    │                                       │
    │  5. final credential = JWS_holder ⊕ JWS_deployment
```

Relying parties verify both signatures. A deployment-only mint isn't valid under v2.

### Migration plan

| Version | Change |
|---|---|
| v0.4 | Counter-signed by default; pre-cutoff unilateral credentials still verify. |
| v0.5 | Unilateral issuance refused; old ones still verify. |
| v1.0 | Counter-signature required everywhere, including verification. |

### What v2 still cannot do

- Detect a coerced holder.
- Stop the UI showing one claim and signing another. Mitigation: the signing UI shows canonicalized payload bytes and stays minimal and auditable.

---

## What relying parties should do today (v0.3)

1. Pin our `did:web` explicitly in `TRUST_PEERS`. No wildcards.
2. Cache our key per verification session, re-fetch on your TTL. Investigate a sudden key change.
3. Show the claim text ("Event X says you attended") before any trust decision.
4. Honor `/.well-known/revocations.json`: fetch periodically, or per verification if latency allows.
5. Set a short `maxAge`: 30-60 days for event context. A year is too long.
6. Treat it as attendance evidence, not identity; the holder may have lost the key.

If you need defense against a malicious issuer, **wait for v0.4** before using these in high-stakes flows.

---

## What attendees should know

- You fetch credentials from `/trust/credentials`; share or keep them.
- Revoke at `/trust/credentials/<id>/revoke` (writes to our revocation list).
- It proves "the deployment said this," not who you are. Anyone with your `did:key` private key holds an equally valid claim.
- Planned: a public log of issued credential IDs (not contents) to audit what's issued in your name.

---

## Where to look

- [`TRUST.md`](../../TRUST.md): schema and ceremony.
- `lib/vc.js`: JWS issuance and verification.
- `lib/trust.js`: policy (issuers, types, expiry windows).
- `routes/trust.js`: user-facing endpoints, including the planned counter-signature UI.

---

## See also

- [`THREAT_MODEL.md`](../../THREAT_MODEL.md): Asset A4 (deployment signing key), residual risk on unilateral issuance.
- [`audit-tampering.md`](audit-tampering.md): audit integrity, which v1 authenticity depends on.
- [`ssrf.md`](ssrf.md): protecting the verifier when fetching peer DID documents.
