# Credential forgery

> Honest accounting of the v1 trust assumptions in **rideshare**'s Verifiable Credential model, and the planned upgrade. Audience: anyone deciding whether to rely on a credential issued by this deployment.

---

## What we issue

A Verifiable Credential in JWT (JWS) form, signed by the deployment's Ed25519 key, asserting one or more of:

- "This subject DID participated in event X."
- "This subject DID was on the allowlist."
- "This subject DID held role Y" (admin, organiser, volunteer).
- "Cross-event: this subject DID held a credential issued by peer deployment Z."

The full schema lives in [`TRUST.md`](../../TRUST.md). The credential is bound to the subject's `did:key` (so transferring the JWS to someone else doesn't transfer the claim — the holder must prove control of the subject DID by signing a challenge).

---

## v1 model — unilateral signing

In v0.3, the deployment signs credentials **unilaterally**. The subject doesn't co-sign. The implications:

- A compromised deployment key can mint arbitrary credentials backdated, attributing claims to subjects who never consented.
- A *malicious* deployment can do the same without compromise.
- A relying party (another event's verifier) accepting our credentials is trusting our entire operational chain: who held the signing key, what their issuance UI did, how it was reviewed.

This is normal for "issuer authority" credentials (a university issuing a degree credential is unilateral; the student doesn't co-sign). It is honest to call it out for an event-context credential where the subject *could* in principle co-sign.

We say this plainly here so that downstream verifiers can decide whether their threat model accepts unilateral issuance.

### What v1 *does* do well

- Credential issuance is recorded in the audit log with subject DID, credential ID, claim summary, and issued-at timestamp. A retroactive forgery would require either modifying the audit log (currently mutable for an insider — see [`audit-tampering.md`](audit-tampering.md)) or shipping a credential that has no audit trail (which a relying party can detect by asking us "did you issue this?").
- The deployment's `did.json` lists the public key. A relying party verifies the signature against that key, fetched fresh per verification. Key rotation is visible.
- Credentials carry an `expirationDate`, default 90 days from issuance. Old credentials age out.
- Credentials are revocable via a revocation list at `/.well-known/revocations.json` (signed by the same key). A revoked credential's `id` will appear there; verifiers MUST check.

### What v1 *cannot* do

- Defend against an insider with key access who issues a forged credential and either omits the audit entry or modifies it later.
- Provide non-repudiation against the deployment itself ("yes the signature is ours, but we didn't intend to issue it").
- Allow a subject to point at a credential and say "the deployment claims this about me, but I never agreed."

---

## Planned v2 model — counter-signature

Tracked for v0.4.

The credential issuance flow becomes a two-party protocol:

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

The result is a credential that is verifiable as "both parties asserted this." A unilateral mint by the deployment is not a valid credential under v2 — it lacks the holder signature. Relying parties verify both signatures.

### Migration plan

- v0.4 ships the counter-signature flow alongside the unilateral one. New credentials default to counter-signed; legacy verification paths still accept unilateral credentials issued before the cutoff.
- v0.5 deprecates unilateral issuance. The deployment refuses to issue unilateral credentials. Verification still accepts old ones.
- v1.0 requires counter-signature for all credentials, including via verification.

### What v2 still cannot do

- Defend against a holder who is coerced into co-signing (we cannot detect coercion).
- Defend against the deployment displaying a different claim in the UI than the one it asks the holder to sign. Mitigation: the holder's signing UI shows the canonicalised payload bytes; an attendee with technical literacy can verify what they're about to sign. We commit to keeping that UI minimal and auditable.

---

## What relying parties should do today (v0.3)

If you are a peer deployment considering accepting our credentials:

1. **Pin our `did:web` identifier explicitly** in your `TRUST_PEERS` list. Never use a wildcard.
2. **Cache the public key for the duration of a verification session**, and re-fetch on a TTL of your choice. Sudden key change → investigate before honoring credentials.
3. **Surface the credential's claim text to the user**, don't auto-trust. The user should see "Event X says you attended" before any trust decision.
4. **Honour the revocation list.** Fetch `/.well-known/revocations.json` periodically (or on every verification, if your app permits the latency).
5. **Set a short `maxAge`** on credentials accepted: 30-60 days is reasonable for an event context; 1 year is too long.
6. **Treat the credential as evidence of attendance, not as identity.** A credential can be issued to a `did:key` whose holder has since lost the private key.

If your threat model requires defense against a malicious issuer, **wait for v0.4** before relying on these credentials in a high-stakes flow.

---

## What attendees should know

- A credential issued to your `did:key` is yours to share or keep private. The deployment doesn't push it; you fetch it from `/trust/credentials`.
- Revoking a credential happens at `/trust/credentials/<id>/revoke` (writes to our revocation list).
- The credential proves "the deployment said this." It does not prove "you, personally, are X." If you've shared your `did:key` private key with someone (don't), they hold an equally-valid claim.
- We will publish a public log of issued credentials' IDs (not the contents) so you can audit what's been issued in your name.

---

## Where to look

- [`TRUST.md`](../../TRUST.md) — full credential schema and ceremony.
- `lib/vc.js` — issuance and verification of the JWS form.
- `lib/trust.js` — policy: which issuers, which types, which expiry windows.
- `routes/trust.js` — the user-facing endpoints, including the planned counter-signature UI.

---

## See also

- [`THREAT_MODEL.md`](../../THREAT_MODEL.md) — Asset A4 (deployment signing key) and the residual risk on unilateral issuance.
- [`audit-tampering.md`](audit-tampering.md) — current state of audit integrity, which is a load-bearing assumption for v1 credential authenticity.
- [`ssrf.md`](ssrf.md) — what protects the verifier when fetching peer DID documents.
